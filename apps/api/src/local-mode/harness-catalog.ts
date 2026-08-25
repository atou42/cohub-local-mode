import type { AgentHarness, ModelThinkingLevel } from "@cohub/protocol";
import type { ModelCatalogEntry } from "@cohub/infra/config-runtime/models";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

function cachePath(harness: Exclude<AgentHarness, "pi">) {
  if (harness === "codex") {
    return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "models_cache.json");
  }
  return join(process.env.GROK_HOME?.trim() || join(homedir(), ".grok"), "models_cache.json");
}

export async function loadExternalHarnessCatalog(
  harness: Exclude<AgentHarness, "pi">,
): Promise<ModelCatalogEntry[]> {
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
