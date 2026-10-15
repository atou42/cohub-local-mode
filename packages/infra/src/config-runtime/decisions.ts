import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFastContentHash, resolvePlatformModelApiKey } from "./models.js";

export const DECISIONS_CONFIG_PATH = ".cohub/decisions.json";
export const DECISIONS_CACHE_TTL_SEC = 24 * 60 * 60;
export const DECISIONS_CACHE_REDIS_KEY_VERSION = "v1";
export const PLATFORM_DECISIONS_REDIS_KEY = `configs:decisions:${DECISIONS_CACHE_REDIS_KEY_VERSION}:platform`;
export const USER_DECISIONS_REDIS_KEY_PREFIX = `configs:decisions:${DECISIONS_CACHE_REDIS_KEY_VERSION}:user`;

const SAFE_REDIS_KEY_SEGMENT_REGEX = /^[0-9a-zA-Z_-]+$/;
const MAXIMUM_IMAGES_LIMIT = 200;

export type DecisionModelDef = {
  id: string;
  name?: string;
  hidden?: boolean;
  input?: Array<"text" | "image">;
  maxImages?: number;
};

export type DecisionProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: DecisionModelDef[];
};

export type DecisionsConfig = {
  providers: Record<string, DecisionProviderConfig>;
};

export type CachedDecisionsConfig = {
  rev: string;
  updatedAt: string;
  sourceCheckpointId?: string | null;
  content: DecisionsConfig | null;
};

export type ResolvedDecisionModel = {
  provider: string;
  id: string;
  name: string;
  hidden: boolean;
  input: Array<"text" | "image">;
  maxImages: number;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isDecisionModelDef(value: unknown, partial: boolean): boolean {
  if (!isRecord(value)) return false;
  return (partial ? value.id === undefined || isNonEmptyString(value.id) : isNonEmptyString(value.id))
    && (value.name === undefined || typeof value.name === "string")
    && (value.hidden === undefined || typeof value.hidden === "boolean")
    && (value.input === undefined
      || (Array.isArray(value.input) && value.input.length > 0
        && value.input.every((item) => item === "text" || item === "image")))
    && (value.maxImages === undefined
      || (typeof value.maxImages === "number" && Number.isSafeInteger(value.maxImages)
        && value.maxImages > 0 && value.maxImages <= MAXIMUM_IMAGES_LIMIT));
}

function isDecisionProviderConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.baseUrl === undefined || isHttpUrl(value.baseUrl))
    && (value.apiKey === undefined || isNonEmptyString(value.apiKey))
    && (value.headers === undefined || isStringRecord(value.headers))
    && (value.models === undefined
      || (Array.isArray(value.models) && value.models.length > 0 && value.models.every((model) => isDecisionModelDef(model, false))));
}

export function isDecisionsConfig(value: unknown): value is DecisionsConfig {
  if (!isRecord(value) || !isRecord(value.providers)) return false;
  return Object.entries(value.providers).every(([provider, config]) =>
    Boolean(provider.trim()) && isDecisionProviderConfig(config));
}

function isDecisionsUserProviderConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.baseUrl !== undefined || value.apiKey !== undefined || value.headers !== undefined) return false;
  return value.models === undefined
    || (Array.isArray(value.models) && value.models.length > 0 && value.models.every((model) => isDecisionModelDef(model, true)));
}

export function isDecisionsUserConfig(value: unknown): value is DecisionsConfig {
  if (!isRecord(value) || !isRecord(value.providers)) return false;
  return Object.entries(value.providers).every(([provider, config]) =>
    Boolean(provider.trim()) && isDecisionsUserProviderConfig(config));
}

export function parseDecisionsConfig(rawText: string): DecisionsConfig {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isDecisionsConfig(parsed)) throw new Error("Decisions config file has invalid schema");
  return parsed;
}

export function parseDecisionsUserConfig(rawText: string): DecisionsConfig {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isDecisionsUserConfig(parsed)) throw new Error("Decisions config file has invalid schema");
  return parsed;
}

export function createCachedDecisionsConfig(input: {
  rawText?: string;
  content: DecisionsConfig | null;
  sourceCheckpointId?: string | null;
  updatedAt?: string;
}): CachedDecisionsConfig {
  return {
    rev: input.rawText ? createFastContentHash(input.rawText) : `missing:${input.sourceCheckpointId ?? "decisions"}`,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    content: input.content,
  };
}

export function parseCachedDecisionsConfig(rawText: string): CachedDecisionsConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const content = parsed.content;
  if (content !== null && !isDecisionsConfig(content)) return null;
  return {
    rev: typeof parsed.rev === "string" ? parsed.rev : "unknown",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    sourceCheckpointId: typeof parsed.sourceCheckpointId === "string" ? parsed.sourceCheckpointId : null,
    content,
  };
}

export function getUserDecisionsRedisKey(userId: string): string {
  const trimmed = userId.trim();
  if (!SAFE_REDIS_KEY_SEGMENT_REGEX.test(trimmed)) throw new Error("Invalid userId for Redis key");
  return `${USER_DECISIONS_REDIS_KEY_PREFIX}:${trimmed}`;
}

// User overrides cannot redirect platform credentials or change upstream-reported charges.
export function resolveDecisionsModels(input: {
  platform: DecisionsConfig | null;
  user?: DecisionsConfig | null;
  resolveApiKey?: (value: string) => string | undefined;
}): ResolvedDecisionModel[] {
  const resolveApiKey = input.resolveApiKey ?? resolvePlatformModelApiKey;
  const models: ResolvedDecisionModel[] = [];
  for (const [provider, providerConfig] of Object.entries(input.platform?.providers ?? {})) {
    const baseUrl = providerConfig.baseUrl?.trim();
    const apiKey = resolveApiKey(providerConfig.apiKey ?? "")?.trim();
    if (!baseUrl || !apiKey) continue;
    const overrides = new Map(
      (input.user?.providers[provider]?.models ?? []).map((model) => [model.id, model]),
    );
    for (const model of providerConfig.models ?? []) {
      const override = overrides.get(model.id);
      const modalities = model.input ?? ["text"];
      models.push({
        provider,
        id: model.id,
        name: override?.name ?? model.name ?? model.id,
        hidden: override?.hidden ?? model.hidden ?? false,
        input: modalities,
        maxImages: modalities.includes("image") ? model.maxImages ?? MAXIMUM_IMAGES_LIMIT : 0,
        baseUrl,
        apiKey,
        ...(providerConfig.headers ? { headers: providerConfig.headers } : {}),
      });
    }
  }
  return models;
}

export function selectDecisionModel(
  models: ResolvedDecisionModel[],
  input: { provider?: string | null; model?: string | null },
): { model: ResolvedDecisionModel | null; error: string | null } {
  const provider = input.provider?.trim() || null;
  const modelId = input.model?.trim() || null;

  if (provider && modelId) {
    const found = models.find((item) => item.provider === provider && item.id === modelId);
    return found ? { model: found, error: null } : { model: null, error: `Model not found: ${provider}/${modelId}` };
  }
  if (modelId) {
    const matches = models.filter((item) => item.id === modelId);
    const only = matches[0];
    if (matches.length === 1 && only) return { model: only, error: null };
    if (matches.length > 1) return { model: null, error: `Model id "${modelId}" is ambiguous; specify provider` };
    return { model: null, error: `Model not found: ${modelId}` };
  }
  const candidates = provider ? models.filter((item) => item.provider === provider) : models;
  const fallback = candidates.find((item) => !item.hidden) ?? candidates[0];
  return fallback
    ? { model: fallback, error: null }
    : { model: null, error: provider ? `No models available for provider: ${provider}` : "No decision model available. Check platform decisions.json" };
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
};

export async function readDecisionsCacheFromFile(input: {
  configPath: string;
  parse: (rawText: string) => DecisionsConfig;
  sourceCheckpointId?: string | null;
}): Promise<CachedDecisionsConfig> {
  try {
    const rawText = await readFile(input.configPath, "utf-8");
    return createCachedDecisionsConfig({
      rawText,
      content: input.parse(rawText),
      sourceCheckpointId: input.sourceCheckpointId ?? null,
    });
  } catch (error) {
    const code = isRecord(error) ? String((error as { code?: unknown }).code) : undefined;
    if (code !== "ENOENT") throw error;
    return createCachedDecisionsConfig({ content: null, sourceCheckpointId: input.sourceCheckpointId ?? null });
  }
}

export function createDecisionsModelsLoader(input: {
  platformConfigRoot: string;
  redis: RedisLike;
}) {
  const inflight = new Map<string, Promise<CachedDecisionsConfig>>();

  async function load(path: string, redisKey: string, parse: (rawText: string) => DecisionsConfig) {
    const pending = inflight.get(redisKey);
    if (pending) return pending;
    const promise = (async () => {
      const cached = await input.redis.get(redisKey).catch(() => null);
      const parsed = cached ? parseCachedDecisionsConfig(cached) : null;
      if (parsed) return parsed;
      const value = await readDecisionsCacheFromFile({ configPath: path, parse });
      await input.redis.set(redisKey, JSON.stringify(value), "EX", DECISIONS_CACHE_TTL_SEC).catch(() => undefined);
      return value;
    })();
    inflight.set(redisKey, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(redisKey);
    }
  }

  return async function loadDecisionModels(userId?: string | null): Promise<ResolvedDecisionModel[]> {
    const normalizedUserId = userId?.trim() || null;
    const [platform, user] = await Promise.all([
      load(
        join(input.platformConfigRoot, "platform", DECISIONS_CONFIG_PATH),
        PLATFORM_DECISIONS_REDIS_KEY,
        parseDecisionsConfig,
      ),
      normalizedUserId
        ? load(
            join(input.platformConfigRoot, "users", normalizedUserId, DECISIONS_CONFIG_PATH),
            getUserDecisionsRedisKey(normalizedUserId),
            parseDecisionsUserConfig,
          )
        : null,
    ]);
    return resolveDecisionsModels({ platform: platform.content, user: user?.content ?? null });
  };
}
