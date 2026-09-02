import type { AgentHarness, ModelThinkingLevel } from "@cohub/protocol";
import type { ModelCatalogEntry } from "@cohub/infra/config-runtime/models";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EFFORT_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const EFFORT_LEVEL_SET = new Set<string>(EFFORT_LEVELS);
const CURSOR_CATALOG_CACHE_VERSION = 4;
const CURSOR_CATALOG_TTL_MS = 5 * 60_000;
const CURSOR_CATALOG_STALE_MAX_MS = 7 * 24 * 60 * 60_000;
const CURSOR_CATALOG_TIMEOUT_MS = 30_000;
const CURSOR_ALLOWED_MODELS = new Set(["grok-4.6", "claude-fable-5-1"]);
const CURSOR_EFFORTS: Record<string, readonly ModelThinkingLevel[]> = {
  "grok-4.6": ["low", "medium", "high", "xhigh"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
};
let cursorCatalogCache: { fetchedAt: number; entries: ModelCatalogEntry[] } | null = null;
let cursorCatalogCacheHydrated = false;
let cursorCatalogInflight: Promise<ModelCatalogEntry[]> | null = null;

export class HarnessCatalogError extends Error {
  readonly code = "harness_catalog_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessCatalogError";
  }
}

type ParseOptions = {
  now?: Date;
  maxAgeMs?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HarnessCatalogError(`${label} is missing`);
  }
  return value.trim();
}

function parseFreshTimestamp(value: unknown, label: string, options: ParseOptions) {
  const raw = requiredString(value, `${label} fetched_at`);
  const fetchedAt = new Date(raw);
  if (!Number.isFinite(fetchedAt.getTime())) {
    throw new HarnessCatalogError(`${label} fetched_at is invalid`);
  }
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ageMs = now.getTime() - fetchedAt.getTime();
  if (ageMs < -5 * 60 * 1000) {
    throw new HarnessCatalogError(`${label} fetched_at is in the future`);
  }
  if (ageMs > maxAgeMs) {
    throw new HarnessCatalogError(`${label} model catalog is stale`);
  }
  return fetchedAt.toISOString();
}

function parseJson(rawText: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new HarnessCatalogError(`${label} model catalog is invalid JSON`, {
      cause: error,
    });
  }
  const parsedRecord = record(parsed);
  if (!parsedRecord) {
    throw new HarnessCatalogError(`${label} model catalog has invalid schema`);
  }
  return parsedRecord;
}

function parseEffort(value: unknown, label: string): ModelThinkingLevel {
  const effort = requiredString(value, label);
  if (!EFFORT_LEVEL_SET.has(effort)) {
    throw new HarnessCatalogError(`${label} is unsupported: ${effort}`);
  }
  return effort as ModelThinkingLevel;
}

function thinkingLevelMap(levels: readonly ModelThinkingLevel[]) {
  const supported = new Set(levels);
  return Object.fromEntries(
    EFFORT_LEVELS.map((level) => [level, supported.has(level) ? level : null]),
  );
}

type CatalogServiceTier = {
  id: string;
  name: string;
  description?: string;
};

function parseServiceTiers(value: unknown, label: string): CatalogServiceTier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HarnessCatalogError(`${label} must be an array`);
  }
  const tiers = value.map((candidate, index) => {
    const tier = record(candidate);
    if (!tier) {
      throw new HarnessCatalogError(`${label} ${index} is invalid`);
    }
    return {
      id: requiredString(tier.id, `${label} ${index} id`),
      name: requiredString(tier.name, `${label} ${index} name`),
      ...(typeof tier.description === "string" && tier.description.trim()
        ? { description: tier.description.trim() }
        : {}),
    };
  });
  if (new Set(tiers.map((tier) => tier.id)).size !== tiers.length) {
    throw new HarnessCatalogError(`${label} contains duplicate ids`);
  }
  return tiers;
}

export function parseCodexModelsCache(
  rawText: string,
  options: ParseOptions = {},
): ModelCatalogEntry[] {
  const root = parseJson(rawText, "Codex");
  const fetchedAt = parseFreshTimestamp(root.fetched_at, "Codex", options);
  requiredString(root.client_version, "Codex client_version");
  if (!Array.isArray(root.models)) {
    throw new HarnessCatalogError("Codex model catalog has no models array");
  }

  const entries = root.models.flatMap((value, index) => {
    const model = record(value);
    if (!model) {
      throw new HarnessCatalogError(`Codex model at index ${index} is invalid`);
    }
    if (model.visibility !== "list") return [];
    const id = requiredString(model.slug, `Codex model ${index} slug`);
    const name = requiredString(
      model.display_name,
      `Codex model ${id} display_name`,
    );
    if (!Array.isArray(model.supported_reasoning_levels)) {
      throw new HarnessCatalogError(
        `Codex model ${id} has no supported reasoning levels`,
      );
    }
    const efforts = model.supported_reasoning_levels.map((level, effortIndex) => {
      const levelRecord = record(level);
      if (!levelRecord) {
        throw new HarnessCatalogError(
          `Codex model ${id} reasoning level ${effortIndex} is invalid`,
        );
      }
      return parseEffort(
        levelRecord.effort,
        `Codex model ${id} reasoning level ${effortIndex}`,
      );
    });
    if (efforts.length === 0 || new Set(efforts).size !== efforts.length) {
      throw new HarnessCatalogError(
        `Codex model ${id} reasoning levels are empty or duplicated`,
      );
    }
    const defaultThinkingLevel = parseEffort(
      model.default_reasoning_level,
      `Codex model ${id} default reasoning level`,
    );
    if (!efforts.includes(defaultThinkingLevel)) {
      throw new HarnessCatalogError(
        `Codex model ${id} default reasoning level is not supported`,
      );
    }
    const serviceTiers = parseServiceTiers(
      model.service_tiers,
      `Codex model ${id} service tiers`,
    );
    const defaultServiceTier = model.default_service_tier === undefined ||
        model.default_service_tier === null
      ? null
      : requiredString(
          model.default_service_tier,
          `Codex model ${id} default service tier`,
        );
    if (
      defaultServiceTier &&
      !serviceTiers.some((tier) => tier.id === defaultServiceTier)
    ) {
      throw new HarnessCatalogError(
        `Codex model ${id} default service tier is not supported`,
      );
    }
    const priority =
      typeof model.priority === "number" && Number.isFinite(model.priority)
        ? model.priority
        : Number.MAX_SAFE_INTEGER;
    return [{
      provider: "codex",
      id,
      model: {
        name,
        description:
          typeof model.description === "string" ? model.description : undefined,
        reasoning: true,
        defaultThinkingLevel,
        thinkingLevelMap: thinkingLevelMap(efforts),
        serviceTiers,
        defaultServiceTier,
        input: Array.isArray(model.input_modalities)
          ? model.input_modalities.filter((item): item is string => typeof item === "string")
          : ["text"],
        contextWindow:
          typeof model.context_window === "number" ? model.context_window : undefined,
        priority,
        catalogFetchedAt: fetchedAt,
        harness: "codex",
      },
    } satisfies ModelCatalogEntry];
  });

  entries.sort((a, b) =>
    Number(a.model.priority ?? Number.MAX_SAFE_INTEGER) -
      Number(b.model.priority ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id));
  if (entries.length === 0) {
    throw new HarnessCatalogError("Codex model catalog has no visible models");
  }
  return entries;
}

export function parseGrokModelsCache(
  rawText: string,
  options: ParseOptions = {},
): ModelCatalogEntry[] {
  const root = parseJson(rawText, "Grok Build");
  const fetchedAt = parseFreshTimestamp(root.fetched_at, "Grok Build", options);
  requiredString(root.grok_version, "Grok Build grok_version");
  const models = record(root.models);
  if (!models) {
    throw new HarnessCatalogError("Grok Build model catalog has no models object");
  }

  const entries = Object.entries(models).flatMap(([key, value]) => {
    const wrapper = record(value);
    const info = record(wrapper?.info);
    if (!wrapper || !info) {
      throw new HarnessCatalogError(`Grok Build model ${key} is invalid`);
    }
    if (info.hidden === true || info.supported_in_api === false) return [];
    const id = requiredString(info.id, `Grok Build model ${key} id`);
    if (id !== key) {
      throw new HarnessCatalogError(`Grok Build model key does not match id: ${key}`);
    }
    const name = requiredString(info.name, `Grok Build model ${id} name`);
    const supportsReasoning = info.supports_reasoning_effort === true;
    let efforts: ModelThinkingLevel[];
    let defaultThinkingLevel: ModelThinkingLevel;
    if (supportsReasoning) {
      if (!Array.isArray(info.reasoning_efforts)) {
        throw new HarnessCatalogError(
          `Grok Build model ${id} has no reasoning efforts`,
        );
      }
      efforts = info.reasoning_efforts.map((value, index) => {
        const effort = record(value);
        if (!effort) {
          throw new HarnessCatalogError(
            `Grok Build model ${id} reasoning effort ${index} is invalid`,
          );
        }
        return parseEffort(
          effort.value ?? effort.id,
          `Grok Build model ${id} reasoning effort ${index}`,
        );
      });
      if (efforts.length === 0 || new Set(efforts).size !== efforts.length) {
        throw new HarnessCatalogError(
          `Grok Build model ${id} reasoning efforts are empty or duplicated`,
        );
      }
      defaultThinkingLevel = parseEffort(
        info.reasoning_effort,
        `Grok Build model ${id} default reasoning effort`,
      );
      if (!efforts.includes(defaultThinkingLevel)) {
        throw new HarnessCatalogError(
          `Grok Build model ${id} default reasoning effort is not supported`,
        );
      }
    } else {
      efforts = ["off"];
      defaultThinkingLevel = "off";
    }

    return [{
      provider: "grok_build",
      id,
      model: {
        name,
        description:
          typeof info.description === "string" ? info.description : undefined,
        reasoning: supportsReasoning,
        defaultThinkingLevel,
        thinkingLevelMap: thinkingLevelMap(efforts),
        input: ["text"],
        contextWindow:
          typeof info.context_window === "number" ? info.context_window : undefined,
        catalogFetchedAt: fetchedAt,
        harness: "grok_build",
      },
    } satisfies ModelCatalogEntry];
  });

  if (entries.length === 0) {
    throw new HarnessCatalogError("Grok Build model catalog has no visible models");
  }
  return entries;
}

function configuredMaxAgeMs() {
  const raw = process.env.LOCAL_HARNESS_CATALOG_MAX_AGE_MS?.trim();
  if (!raw) return DEFAULT_MAX_AGE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HarnessCatalogError(
      "LOCAL_HARNESS_CATALOG_MAX_AGE_MS must be a positive number",
    );
  }
  return parsed;
}

function cachePath(harness: Exclude<AgentHarness, "pi" | "cursor">) {
  if (harness === "codex") {
    return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "models_cache.json");
  }
  return join(process.env.GROK_HOME?.trim() || join(homedir(), ".grok"), "models_cache.json");
}

function cursorThinkingLevel(modelId: string): ModelThinkingLevel {
  const match = modelId.match(/(?:reasoning|effort)=([^,\]]+)/i);
  const value = match?.[1]?.trim().toLowerCase();
  if (value === "none" || value === "false") return "off";
  return value && EFFORT_LEVEL_SET.has(value) ? value as ModelThinkingLevel : "off";
}

export function parseCursorAcpModels(result: Record<string, unknown>, now = new Date()): ModelCatalogEntry[] {
  const models = record(result.models);
  const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const entries = available.flatMap((value, index) => {
    const model = record(value);
    const id = typeof model?.modelId === "string" ? model.modelId.trim() : "";
    const name = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : id;
    // ACP advertises Auto as default[], but that sentinel is not accepted by
    // session/set_config_option. Keep the catalog executable rather than
    // exposing a selection that always fails at runtime.
    const baseId = id.split("[", 1)[0]?.trim() ?? id;
    if (!id || !name || id === "default[]" || !CURSOR_ALLOWED_MODELS.has(baseId)) return [];
    const thinkingLevel = cursorThinkingLevel(id);
    const efforts = CURSOR_EFFORTS[baseId] ?? [thinkingLevel];
    return [{
      provider: "cursor",
      id,
      model: {
        name,
        reasoning: thinkingLevel !== "off",
        defaultThinkingLevel: thinkingLevel,
        thinkingLevelMap: Object.fromEntries(
          EFFORT_LEVELS.map((level) => [
            level,
            efforts.includes(level) ? level : null,
          ]),
        ),
        serviceTiers: [],
        defaultServiceTier: null,
        input: ["text", "image"],
        priority: index,
        catalogFetchedAt: now.toISOString(),
        harness: "cursor",
      },
    } satisfies ModelCatalogEntry];
  });
  if (entries.length === 0) throw new HarnessCatalogError("Cursor ACP model catalog has no visible models");
  return entries;
}

async function loadCursorAcpModels(): Promise<Record<string, unknown>> {
  const command = process.env.CURSOR_AGENT_COMMAND?.trim() || "agent";
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["acp"], { env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const stdout = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdout.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      error ? reject(error) : resolve(result ?? {});
    };
    const send = (payload: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(payload)}\n`);
    timer = setTimeout(() => finish(new HarnessCatalogError("Cursor ACP model discovery timed out")), CURSOR_CATALOG_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", (error) => finish(new HarnessCatalogError(`Cursor ACP model discovery failed: ${error.message}`, { cause: error })));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new HarnessCatalogError(`Cursor ACP model discovery exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    stdout.on("line", (line) => {
      if (settled || !line.trim()) return;
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        payload = record(parsed) ?? (() => { throw new Error("response is not an object"); })();
      } catch (error) {
        finish(new HarnessCatalogError(`Cursor ACP emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const errorPayload = record(payload.error);
      if (errorPayload && payload.id !== undefined) {
        finish(new HarnessCatalogError(`Cursor ACP model discovery failed: ${String(errorPayload.message ?? JSON.stringify(errorPayload))}`));
        return;
      }
      if (payload.id === 1 && record(payload.result)) {
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cursor_login" } });
      } else if (payload.id === 2 && record(payload.result)) {
        send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
      } else if (payload.id === 3 && record(payload.result)) {
        finish(null, payload.result as Record<string, unknown>);
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "cohub-local-capabilities", version: "1" },
    } });
  });
}

function cursorCatalogCachePath() {
  const root = process.env.LOCAL_HARNESS_CATALOG_CACHE_DIR?.trim()
    || process.env.COHUB_LOCAL_DATA_DIR?.trim()
    || join(homedir(), ".cohub-local-mode");
  return join(root, "cache", "cursor-models.v2.json");
}

function parsePersistedCursorCatalog(value: unknown) {
  const root = record(value);
  if (!root || root.version !== CURSOR_CATALOG_CACHE_VERSION) return null;
  const fetchedAt = typeof root.fetchedAt === "number" && Number.isFinite(root.fetchedAt)
    ? root.fetchedAt
    : null;
  if (fetchedAt === null || !Array.isArray(root.entries) || root.entries.length === 0) return null;
  const entries = root.entries.filter((entry): entry is ModelCatalogEntry => {
    const candidate = record(entry);
    const model = record(candidate?.model);
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    const baseId = id.split("[", 1)[0]?.trim() ?? id;
    return candidate?.provider === "cursor"
      && Boolean(id)
      && CURSOR_ALLOWED_MODELS.has(baseId)
      && model !== null
      && typeof model.name === "string"
      && Boolean(model.name.trim());
  });
  return entries.length === root.entries.length ? { fetchedAt, entries } : null;
}

async function hydrateCursorCatalogCache() {
  if (cursorCatalogCacheHydrated) return;
  cursorCatalogCacheHydrated = true;
  try {
    const raw = await readFile(cursorCatalogCachePath(), "utf8");
    const parsed = parsePersistedCursorCatalog(JSON.parse(raw));
    if (!parsed) {
      console.warn("[models] ignoring invalid Cursor catalog cache");
      return;
    }
    if (Date.now() - parsed.fetchedAt > CURSOR_CATALOG_STALE_MAX_MS) return;
    cursorCatalogCache = parsed;
  } catch (error) {
    const code = record(error)?.code;
    if (code !== "ENOENT") {
      console.warn("[models] unable to read Cursor catalog cache", error);
    }
  }
}

async function persistCursorCatalogCache(value: { fetchedAt: number; entries: ModelCatalogEntry[] }) {
  const path = cursorCatalogCachePath();
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify({
      version: CURSOR_CATALOG_CACHE_VERSION,
      ...value,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    console.warn("[models] unable to persist Cursor catalog cache", error);
  }
}

async function refreshCursorModelsCatalog() {
  if (cursorCatalogInflight) return cursorCatalogInflight;
  cursorCatalogInflight = (async () => {
    try {
      const result = await loadCursorAcpModels();
      const entries = parseCursorAcpModels(result);
      const value = { fetchedAt: Date.now(), entries };
      cursorCatalogCache = value;
      await persistCursorCatalogCache(value);
      return entries;
    } catch (error) {
      throw new HarnessCatalogError(
        `Cursor model catalog cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      cursorCatalogInflight = null;
    }
  })();
  return cursorCatalogInflight;
}

async function loadCursorModelsCatalog(): Promise<ModelCatalogEntry[]> {
  await hydrateCursorCatalogCache();
  const now = Date.now();
  if (cursorCatalogCache) {
    if (cursorCatalogCache.fetchedAt + CURSOR_CATALOG_TTL_MS > now) {
      return cursorCatalogCache.entries;
    }
    if (cursorCatalogCache.fetchedAt + CURSOR_CATALOG_STALE_MAX_MS > now) {
      void refreshCursorModelsCatalog().catch((error) => {
        console.warn("[models] Cursor catalog background refresh failed", error);
      });
      return cursorCatalogCache.entries;
    }
  }
  return refreshCursorModelsCatalog();
}

export function clearCursorModelCatalogCacheForTests() {
  cursorCatalogCache = null;
  cursorCatalogCacheHydrated = false;
  cursorCatalogInflight = null;
}

export async function loadExternalHarnessCatalog(
  harness: Exclude<AgentHarness, "pi">,
): Promise<ModelCatalogEntry[]> {
  if (harness === "cursor") return loadCursorModelsCatalog();
  const path = cachePath(harness);
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch (error) {
    const code = record(error)?.code;
    throw new HarnessCatalogError(
      code === "ENOENT"
        ? `${harness === "codex" ? "Codex" : "Grok Build"} model catalog is missing`
        : `${harness === "codex" ? "Codex" : "Grok Build"} model catalog cannot be read`,
      { cause: error },
    );
  }
  const options = { maxAgeMs: configuredMaxAgeMs() };
  return harness === "codex"
    ? parseCodexModelsCache(rawText, options)
    : parseGrokModelsCache(rawText, options);
}

export function getCatalogEfforts(entry: ModelCatalogEntry): ModelThinkingLevel[] {
  const map = record(entry.model.thinkingLevelMap);
  if (!map) return entry.model.reasoning === true ? ["low", "medium", "high"] : ["off"];
  return EFFORT_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined);
}

export function getCatalogServiceTiers(entry: ModelCatalogEntry): CatalogServiceTier[] {
  return parseServiceTiers(entry.model.serviceTiers, `Model ${entry.id} service tiers`);
}

export async function validateExternalHarnessSelection(input: {
  harness: Exclude<AgentHarness, "pi">;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  serviceTier: string | null;
}) {
  if (input.provider !== input.harness || !input.model) {
    return { ok: false as const, code: "model_unavailable", message: "Select a model for the chosen agent" };
  }
  const catalog = await loadExternalHarnessCatalog(input.harness);
  const entry = catalog.find(
    (item) => item.provider === input.provider && item.id === input.model,
  );
  if (!entry) {
    return { ok: false as const, code: "model_unavailable", message: "Requested model is not available for the chosen agent" };
  }
  if (!input.thinkingLevel || !getCatalogEfforts(entry).includes(input.thinkingLevel as ModelThinkingLevel)) {
    return { ok: false as const, code: "effort_unavailable", message: "Requested effort is not available for the chosen model" };
  }
  const serviceTiers = getCatalogServiceTiers(entry);
  if (
    input.serviceTier &&
    (input.harness !== "codex" ||
      !serviceTiers.some((tier) => tier.id === input.serviceTier))
  ) {
    return {
      ok: false as const,
      code: "service_tier_unavailable",
      message: "Requested speed is not available for the chosen model",
    };
  }
  return { ok: true as const, entry };
}
