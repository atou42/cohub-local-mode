import { parse as parseYaml } from "yaml";
import {
  SPACE_HOOK_SCHEMA,
  SPACE_HOOK_WEBHOOK_EVENT,
  SPACE_HOOKS_DIR,
  getSpaceHookName,
  isSpaceHookableEvent,
  parseSpaceSlug,
  parseUsername,
  type SpaceHookableEvent,
} from "@cohub/protocol";
import { isAppActionKey } from "../apps/action-command.js";
import { parsePromptEnv } from "../sessions/prompt-env.js";
import type { SpaceHookDefinition, SpaceHookUsesDefinition } from "./types.js";

const HOOK_FILE_EXTENSIONS = new Set([".yml", ".yaml", ".json"]);
const MAX_RUN_LENGTH = 64 * 1024;
const MAX_SECRET_LENGTH = 256;
const MAX_WITH_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_SECS = 10 * 60;
const MAX_TIMEOUT_SECS = 30 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeLabelFilter(value: unknown): SpaceHookDefinition["labels"] | undefined {
  if (!isRecord(value)) return undefined;
  const filter = {
    any: normalizeStringList(value.any),
    all: normalizeStringList(value.all),
    none: normalizeStringList(value.none),
  };
  return filter.any || filter.all || filter.none ? filter : undefined;
}

function normalizeKinds(value: unknown): SpaceHookDefinition["kinds"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is "create" | "modify" | "delete" | "rename" =>
      item === "create" || item === "modify" || item === "delete" || item === "rename");
  return kinds.length > 0 ? Array.from(new Set(kinds)) : undefined;
}

function normalizeTimeoutSecs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_TIMEOUT_SECS);
}

function parseDocument(raw: string, path: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`hook file is empty: ${path}`);
  if (path.endsWith(".json")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(`invalid hook json ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return parseYaml(trimmed);
  } catch (error) {
    throw new Error(`invalid hook yaml ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isSpaceHookFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return Array.from(HOOK_FILE_EXTENSIONS).some((ext) => lower.endsWith(ext));
}

export function normalizeSpaceHookPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

export function isSpaceHookPath(path: string): boolean {
  const normalized = normalizeSpaceHookPath(path);
  if (!normalized.startsWith(`${SPACE_HOOKS_DIR}/`)) return false;
  const relative = normalized.slice(SPACE_HOOKS_DIR.length + 1);
  if (!relative || relative.includes("/")) return false;
  return isSpaceHookFileName(relative);
}

export function parseSpaceHookDefinition(raw: string, path: string): SpaceHookDefinition {
  const normalizedPath = normalizeSpaceHookPath(path);
  if (!isSpaceHookPath(normalizedPath)) {
    throw new Error(`hook path must be a top-level file under ${SPACE_HOOKS_DIR}: ${path}`);
  }

  const document = parseDocument(raw, normalizedPath);
  if (!isRecord(document)) throw new Error(`hook must be an object: ${normalizedPath}`);
  if (document.schema !== SPACE_HOOK_SCHEMA) {
    throw new Error(`unsupported hook schema in ${normalizedPath}; expected ${SPACE_HOOK_SCHEMA}`);
  }

  const on = isRecord(document.on) ? document.on : null;
  const eventValue = typeof on?.event === "string" ? on.event.trim() : "";
  if (!eventValue || !isSpaceHookableEvent(eventValue)) {
    throw new Error(`unsupported or missing on.event in ${normalizedPath}`);
  }

  const actions = (["run", "prompt", "uses"] as const).filter((key) => Object.hasOwn(document, key));
  const action = actions[0];
  if (!action || actions.length !== 1) {
    throw new Error(`exactly one of run, prompt or uses is required in ${normalizedPath}`);
  }

  const timeoutSecs = normalizeTimeoutSecs(document.timeoutSecs ?? document.timeout)
    ?? DEFAULT_TIMEOUT_SECS;
  const topLevelEnv = parseHookUserEnv(document.env, normalizedPath);

  const triggerFilters = {
    paths: normalizeStringList(on?.paths),
    ignore: normalizeStringList(on?.ignore),
    kinds: normalizeKinds(on?.kinds),
    sessionIds: normalizeStringList(on?.sessionIds),
    ignoreSessionIds: normalizeStringList(on?.ignoreSessionIds),
    sources: normalizeStringList(on?.sources),
    labels: normalizeLabelFilter(on?.labels),
    secret: parseWebhookSecret(on?.secret, normalizedPath),
  };
  if (triggerFilters.labels && eventValue !== "session.turn.finalized") {
    throw new Error(`on.labels is only supported for session.turn.finalized in ${normalizedPath}`);
  }
  if (eventValue === SPACE_HOOK_WEBHOOK_EVENT && !getSpaceHookName(normalizedPath)) {
    throw new Error(`webhook hook file name must be a valid hook name in ${normalizedPath}`);
  }
  if (triggerFilters.secret && eventValue !== SPACE_HOOK_WEBHOOK_EVENT) {
    throw new Error(`on.secret is only supported for webhook in ${normalizedPath}`);
  }

  const base = {
    schema: SPACE_HOOK_SCHEMA,
    path: normalizedPath,
    event: eventValue as SpaceHookableEvent,
    ...triggerFilters,
    timeoutSecs,
  } satisfies Partial<SpaceHookDefinition>;

  if (action === "run") {
    const run = typeof document.run === "string" ? document.run.trim() : "";
    if (!run) throw new Error(`missing run in ${normalizedPath}`);
    if (run.length > MAX_RUN_LENGTH) throw new Error(`run is too long in ${normalizedPath}`);
    return { ...base, action, run, ...(topLevelEnv ? { env: topLevelEnv } : {}) };
  }

  if (action === "uses") {
    const uses = parseUsesDefinition(document.uses, normalizedPath);
    const withInput = parseWithInput(document.with, normalizedPath);
    return {
      ...base,
      action,
      uses,
      ...(withInput !== undefined ? { with: withInput } : {}),
      ...(topLevelEnv ? { env: topLevelEnv } : {}),
    };
  }

  const prompt = parsePromptDefinition(document.prompt, normalizedPath);
  // Prefer top-level env; keep legacy prompt.env as fallback only when top-level is absent.
  const env = topLevelEnv ?? parseHookUserEnv(
    isRecord(document.prompt) ? document.prompt.env : undefined,
    normalizedPath,
  );
  return { ...base, action, prompt, ...(env ? { env } : {}) };
}

function parseWebhookSecret(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const secret = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!secret) throw new Error(`on.secret must be a non-empty string in ${path}`);
  if (secret.length > MAX_SECRET_LENGTH) throw new Error(`on.secret is too long in ${path}`);
  return secret;
}

/** `uses: username/spaceSlug/appSlug/action` — a published App Action. */
function parseUsesDefinition(value: unknown, path: string): SpaceHookUsesDefinition {
  const raw = typeof value === "string" ? value.trim() : "";
  const parts = raw.split("/");
  if (parts.length !== 4) throw new Error(`uses must be username/space/app/action in ${path}`);
  const [username, spaceSlug, appSlug, action] = parts;
  const parsed = username && spaceSlug && appSlug && action
    ? {
        username: parseUsername(username),
        spaceSlug: parseSpaceSlug(spaceSlug),
        appSlug: parseSpaceSlug(appSlug),
        action: isAppActionKey(action) ? action : null,
      }
    : null;
  if (!parsed?.username || !parsed.spaceSlug || !parsed.appSlug || !parsed.action) {
    throw new Error(`uses must be username/space/app/action in ${path}`);
  }
  return { username: parsed.username, spaceSlug: parsed.spaceSlug, appSlug: parsed.appSlug, action: parsed.action };
}

function parseWithInput(value: unknown, path: string): unknown {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`with must be JSON-serializable in ${path}`);
  if (Buffer.byteLength(encoded) > MAX_WITH_BYTES) throw new Error(`with is too large in ${path}`);
  return value;
}

function parseHookUserEnv(value: unknown, path: string): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  try {
    return parsePromptEnv(value);
  } catch (error) {
    throw new Error(`invalid env in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePromptDefinition(value: unknown, path: string): SpaceHookDefinition["prompt"] {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) throw new Error(`missing prompt text in ${path}`);
    if (text.length > MAX_RUN_LENGTH) throw new Error(`prompt is too long in ${path}`);
    return { text };
  }
  if (!isRecord(value)) throw new Error(`prompt must be a string or object in ${path}`);

  const text = typeof value.text === "string"
    ? value.text.trim()
    : typeof value.content === "string"
      ? value.content.trim()
      : "";
  if (!text) throw new Error(`missing prompt text in ${path}`);
  if (text.length > MAX_RUN_LENGTH) throw new Error(`prompt is too long in ${path}`);

  const intent = value.intent === "followup" || value.intent === "steer" ? value.intent : null;
  const accessMode = value.accessMode === "read_only" || value.accessMode === "full_access"
    ? value.accessMode
    : null;

  const labelRefs = Array.isArray(value.labelRefs)
    ? value.labelRefs.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : null;

  return {
    text,
    sessionId: typeof value.sessionId === "string" && value.sessionId.trim() ? value.sessionId.trim() : null,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : null,
    intent,
    accessMode,
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : null,
    provider: typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : null,
    thinkingLevel: typeof value.thinkingLevel === "string" && value.thinkingLevel.trim() ? value.thinkingLevel.trim() : null,
    ...(labelRefs && labelRefs.length > 0 ? { labelRefs } : {}),
  };
}

export function getDefaultSpaceHookTimeoutSecs() {
  return DEFAULT_TIMEOUT_SECS;
}

export function getMaxSpaceHookTimeoutSecs() {
  return MAX_TIMEOUT_SECS;
}
