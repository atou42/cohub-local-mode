import type { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveApiBaseUrl, resolveCohubEnvironment } from "@neta-art/cohub";
import { readAuthSession } from "./auth.js";
import { createClient } from "./client.js";
import { getRuntimeSpaceBinding } from "./runtime/space-binding.js";
import { error, handleHttp } from "./output.js";

const CONFIG_DIR = join(homedir(), ".config", "cohub");
const CACHE_PATH = join(CONFIG_DIR, "default-space.json");
/** Home space is stable; a one-day TTL bounds how long a stale hit survives. */
const CACHE_TTL_MS = 86_400_000;

type DefaultSpaceCache = {
  /** Identity fingerprint the cached space belongs to (endpoint + env + subject). */
  key: string;
  spaceId: string;
  cachedAt: number;
};

function jwtClaim(token: string | undefined | null, key: string): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Cache key aligned with auth: execution token is exclusive (same as
 * `resolveAccessToken`) and never falls back to a local Logto session.
 * Execution grants identify the actor as `actorUserId`, not `sub`.
 */
export function identityKeyFrom(input: {
  env: string;
  apiBaseUrl?: string;
  executionToken?: string | null;
  idToken?: string | null;
  accessToken?: string | null;
}): string | null {
  const prefix = input.apiBaseUrl
    ? `${input.env}:${JSON.stringify(new URL(input.apiBaseUrl).href.replace(/\/+$/, ""))}`
    : input.env;
  if (input.executionToken) {
    const actor = jwtClaim(input.executionToken, "actorUserId") ?? jwtClaim(input.executionToken, "sub");
    return actor ? `${prefix}:${actor}` : null;
  }
  const sub = jwtClaim(input.idToken, "sub") ?? jwtClaim(input.accessToken, "sub");
  return sub ? `${prefix}:${sub}` : null;
}

export function currentIdentityKey(): string | null {
  const session = readAuthSession();
  return identityKeyFrom({
    env: resolveCohubEnvironment(),
    apiBaseUrl: resolveApiBaseUrl({ baseUrl: process.env.COHUB_API_URL?.trim() || undefined }),
    executionToken: process.env.COHUB_EXECUTION_TOKEN?.trim(),
    idToken: session?.idToken,
    accessToken: session?.accessToken,
  });
}

/** Exported for tests; production always uses `CACHE_PATH`. */
export function readDefaultSpaceCache(path: string, key: string, now = Date.now()): string | null {
  try {
    const cache = JSON.parse(readFileSync(path, "utf-8")) as Partial<DefaultSpaceCache>;
    if (cache.key !== key || typeof cache.spaceId !== "string" || typeof cache.cachedAt !== "number") return null;
    if (now - cache.cachedAt > CACHE_TTL_MS) return null;
    return cache.spaceId;
  } catch {
    return null;
  }
}

function writeCachedDefaultSpace(key: string, spaceId: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cache: DefaultSpaceCache = { key, spaceId, cachedAt: Date.now() };
    writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Cache is best-effort; never fail the command over it.
  }
}

let defaultSpacePromise: Promise<string | null> | null = null;
let defaultSpacePromiseKey: string | null = null;

export function clearDefaultSpaceCache(): void {
  defaultSpacePromise = null;
  defaultSpacePromiseKey = null;
  try {
    rmSync(CACHE_PATH, { force: true });
  } catch {
    // Best-effort, same as writes.
  }
}

/** Explicit target from `-s/--space` (any ancestor) or `COHUB_SPACE_ID`, else null. */
export function explicitSpace(program: Command): string | null {
  let current: Command | null = program;
  while (current) {
    const opts = current.opts() as Record<string, unknown>;
    if (typeof opts.space === "string" && opts.space.trim()) return opts.space.trim();
    current = current.parent ?? null;
  }
  return process.env.COHUB_SPACE_ID?.trim() || null;
}

/**
 * Resolve the user's home space when no target is given. Cached locally per
 * identity so repeated invocations skip the network entirely, and memoized
 * in-process so preAction hooks and actions share a single lookup.
 * Network and auth failures propagate so callers can report them faithfully.
 */
export function resolveDefaultSpace(): Promise<string | null> {
  const key = currentIdentityKey();
  if (key !== defaultSpacePromiseKey) {
    defaultSpacePromise = null;
    defaultSpacePromiseKey = key;
  }
  defaultSpacePromise ??= (async () => {
    if (key) {
      const cached = readDefaultSpaceCache(CACHE_PATH, key);
      if (cached) return cached;
    }

    const space = (await createClient().spaces.getDefault()).space ?? null;
    // Recent-space fallback from getDefault() is not stable enough to cache.
    if (space?.id && space.slug === "home" && key) writeCachedDefaultSpace(key, space.id);
    return space?.id ?? null;
  })();
  return defaultSpacePromise;
}

/** Shared exit for commands that need a space but resolved none. */
export function missingSpaceError(): never {
  return error("No target space", "Add -s, --space <id> or set COHUB_SPACE_ID. Run `cohub auth login` to use your home space.");
}

/**
 * Resolve a Space from an optional explicit target, the current directory
 * binding, and finally the user's Home Space.
 */
export async function resolveBoundSpace(
  options: { cwd?: string; bindingsPath?: string } = {},
): Promise<string | null> {
  const bound = await getRuntimeSpaceBinding(
    options.cwd ?? process.cwd(),
    currentIdentityKey(),
    options.bindingsPath,
  ).catch(handleHttp);
  return bound?.spaceId ?? null;
}

export async function resolveSpaceTarget(
  target?: string | null,
  options: { cwd?: string; bindingsPath?: string } = {},
): Promise<string> {
  const explicit = target?.trim() || process.env.COHUB_SPACE_ID?.trim() || null;
  if (explicit) return explicit;

  return (await resolveBoundSpace(options))
    ?? (await resolveDefaultSpace().catch(handleHttp))
    ?? missingSpaceError();
}

export async function resolveSpace(program: Command): Promise<string> {
  return resolveSpaceTarget(explicitSpace(program));
}
