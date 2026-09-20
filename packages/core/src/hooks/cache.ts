import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SPACE_HOOKS_CACHE_TTL_SEC,
  SPACE_HOOKS_EMPTY_CACHE_TTL_SEC,
  SPACE_HOOKS_DIR,
  getSpaceHooksRedisKey,
  isSpaceHooksConfigPath,
} from "@cohub/protocol";
import {
  isSpaceHookFileName,
  parseSpaceHookDefinition,
} from "./parse.js";
import type { CachedSpaceHooksConfig, SpaceHookDefinition } from "./types.js";

export type LoadSpaceHookDefinitionsResult = {
  definitions: SpaceHookDefinition[];
  cache: "hit" | "miss";
};

export type PeekSpaceHookDefinitionsResult =
  | { status: "hit"; definitions: SpaceHookDefinition[] }
  | { status: "miss" };

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
};

export type SpaceHooksCacheReader = Pick<RedisLike, "get">;
export type SpaceHooksCacheWriter = Pick<RedisLike, "del">;

type ListedSpaceHookDefinitions = {
  definitions: SpaceHookDefinition[];
  listed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createCachedSpaceHooksConfig(input: {
  spaceId: string;
  definitions: SpaceHookDefinition[];
  updatedAt?: string;
}): CachedSpaceHooksConfig {
  return {
    version: 1,
    spaceId: input.spaceId,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    definitions: input.definitions,
  };
}

export function parseCachedSpaceHooksConfig(raw: string): CachedSpaceHooksConfig | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (typeof parsed.spaceId !== "string" || !parsed.spaceId.trim()) return null;
    if (!Array.isArray(parsed.definitions)) return null;
    return parsed as CachedSpaceHooksConfig;
  } catch {
    return null;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

async function readSpaceHookDefinitionsFromDir(dir: string): Promise<ListedSpaceHookDefinitions> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { definitions: [], listed: false };
    }
    throw error;
  }

  const definitions: SpaceHookDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!isSpaceHookFileName(entry)) continue;
    const path = join(dir, entry);
    const relativePath = `${SPACE_HOOKS_DIR}/${entry}`;
    try {
      const raw = await readFile(path, "utf8");
      definitions.push(parseSpaceHookDefinition(raw, relativePath));
    } catch (error) {
      // Invalid declarations are skipped for matching, but kept out of cache
      // so the next successful read can refresh after a fix.
      console.warn(`[SpaceHooks] skipping invalid hook file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { definitions, listed: true };
}

export async function loadSpaceHookDefinitionsFromDir(dir: string): Promise<SpaceHookDefinition[]> {
  return (await readSpaceHookDefinitionsFromDir(dir)).definitions;
}

export function resolveSpaceHooksCacheTtlSec(definitionsCount: number): number {
  return definitionsCount > 0 ? SPACE_HOOKS_CACHE_TTL_SEC : SPACE_HOOKS_EMPTY_CACHE_TTL_SEC;
}

/**
 * Read-only cache peek for publishers. Never loads from disk.
 * Used to skip dispatch enqueue when a space is known to have zero hooks.
 */
export async function peekSpaceHookDefinitions(input: {
  spaceId: string;
  redis: SpaceHooksCacheReader;
}): Promise<PeekSpaceHookDefinitionsResult> {
  const cached = await input.redis.get(getSpaceHooksRedisKey(input.spaceId)).catch(() => null);
  if (!cached) return { status: "miss" };
  const parsed = parseCachedSpaceHooksConfig(cached);
  if (!parsed) return { status: "miss" };
  return { status: "hit", definitions: parsed.definitions };
}

async function shouldWriteSpaceHooksCache(
  workspaceDir: string,
  loaded: ListedSpaceHookDefinitions,
): Promise<boolean> {
  if (loaded.listed) return true;
  return directoryExists(workspaceDir);
}

export async function loadSpaceHookDefinitions(input: {
  spaceId: string;
  workspaceDir: string;
  redis?: RedisLike | null;
  allowCache?: boolean;
}): Promise<LoadSpaceHookDefinitionsResult> {
  const redisKey = getSpaceHooksRedisKey(input.spaceId);
  if (input.allowCache !== false && input.redis) {
    const cached = await input.redis.get(redisKey).catch(() => null);
    if (cached) {
      const parsed = parseCachedSpaceHooksConfig(cached);
      if (parsed) {
        return { definitions: parsed.definitions, cache: "hit" };
      }
    }
  }

  const loaded = await readSpaceHookDefinitionsFromDir(join(input.workspaceDir, SPACE_HOOKS_DIR));
  if (input.redis && await shouldWriteSpaceHooksCache(input.workspaceDir, loaded)) {
    const payload = createCachedSpaceHooksConfig({
      spaceId: input.spaceId,
      definitions: loaded.definitions,
    });
    await input.redis
      .set(redisKey, JSON.stringify(payload), "EX", resolveSpaceHooksCacheTtlSec(loaded.definitions.length))
      .catch(() => undefined);
  }
  return { definitions: loaded.definitions, cache: "miss" };
}

export async function invalidateSpaceHooksCache(input: {
  spaceId: string;
  redis: SpaceHooksCacheWriter;
}) {
  return input.redis
    .del(getSpaceHooksRedisKey(input.spaceId))
    .then(() => true)
    .catch(() => false);
}

export function shouldInvalidateSpaceHooksCache(paths: string[]): boolean {
  return paths.some(isSpaceHooksConfigPath);
}

/** Wrap a hook run script. Trigger context is injected via process env, not files. */
export function buildHookRunCommand(run: string) {
  return ["set -euo pipefail", run].join("\n");
}
