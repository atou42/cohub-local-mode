import { scopeListHasPermission, type Permission } from "./types.js";

// Caches the app viewer scopes a user has already granted, so returning
// viewers can be re-authorized silently instead of seeing the consent dialog
// on every visit. Grants are cached per space: the app's home space keeps the
// legacy key (no space segment) so existing users stay silently authorized,
// while grants for other spaces get their own keys. The server remains the
// source of truth: a fresh app session token is always requested from the
// API, and a failed silent re-authorization clears the stale cache and falls
// back to the dialog.
//
// A grant expires after MAX_AGE_MS (counted from the last explicit consent);
// silent re-authorizations do not refresh it, so viewers periodically
// re-confirm. Stored in localStorage under
// "cohub:work-grants:<userUuid>:<appId>[:<spaceId>]:v1".

const STORAGE_PREFIX = "cohub:work-grants";
const CACHE_VERSION = 1;
// Silent re-authorization is allowed for this long after the viewer last
// confirmed consent. Only an explicit confirmation refreshes the timestamp,
// so this acts as a periodic re-consent window rather than rolling forward
// on every silent use.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type CachedAppGrant = {
	version: number;
	userUuid: string;
	appId: string;
	scopes: Permission[];
	updatedAt: number;
};

function isBrowser() {
	return typeof localStorage !== "undefined";
}

function storageKey(userUuid: string, appId: string, spaceId?: string) {
	const base = `${STORAGE_PREFIX}:${encodeURIComponent(userUuid)}:${encodeURIComponent(appId)}`;
	return spaceId
		? `${base}:${encodeURIComponent(spaceId)}:v${CACHE_VERSION}`
		: `${base}:v${CACHE_VERSION}`;
}

function userPrefix(userUuid: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userUuid)}:`;
}

function isPermissionArray(value: unknown): value is Permission[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isCachedAppGrant(value: unknown): value is CachedAppGrant {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CachedAppGrant>;
	return (
		record.version === CACHE_VERSION &&
		typeof record.userUuid === "string" &&
		typeof record.appId === "string" &&
		isPermissionArray(record.scopes) &&
		typeof record.updatedAt === "number"
	);
}

function readEntry(userUuid: string, appId: string, spaceId?: string): CachedAppGrant | null {
	if (!isBrowser()) return null;
	const key = storageKey(userUuid, appId, spaceId);

	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (
			!isCachedAppGrant(parsed) ||
			parsed.userUuid !== userUuid ||
			parsed.appId !== appId
		) {
			localStorage.removeItem(key);
			return null;
		}
		if (Date.now() - parsed.updatedAt > MAX_AGE_MS) {
			localStorage.removeItem(key);
			return null;
		}
		return parsed;
	} catch {
		try {
			localStorage.removeItem(key);
		} catch {
			// Ignore cleanup failures.
		}
		return null;
	}
}

/**
 * Returns true when the viewer has previously granted every requested scope
 * for this app on the target space, allowing a silent re-authorization.
 */
export function hasGrantedAppScopes(
	userUuid: string | null | undefined,
	appId: string,
	scopes: readonly Permission[],
	spaceId?: string,
): boolean {
	if (!userUuid || !appId || scopes.length === 0) return false;
	const entry = readEntry(userUuid, appId, spaceId);
	if (!entry) return false;
	// Implication-aware: a full-access grant silently covers a later
	// read-only request instead of forcing a fresh consent dialog.
	return scopes.every((scope) => scopeListHasPermission(entry.scopes, scope));
}

/**
 * The Space ids of cached grants that cover every requested scope, scanning all
 * Spaces. Used for account-level scopes, which are not bound to one Space but
 * must be renewed against a Space whose grant actually exists. The coverage is
 * already validated here, so callers must not re-check with a per-Space key
 * (a legacy, Space-less entry would otherwise never match).
 */
export function listGrantedAppSpacesForScopes(
	userUuid: string | null | undefined,
	appId: string,
	scopes: readonly Permission[],
	homeSpaceId?: string,
): string[] {
	if (!userUuid || !appId || scopes.length === 0) return [];
	const spaces = new Set<string>();
	for (const grant of listGrantedAppScopes(userUuid, appId, homeSpaceId)) {
		if (scopes.every((scope) => scopeListHasPermission(grant.scopes, scope))) {
			spaces.add(grant.spaceId);
		}
	}
	return [...spaces];
}

/**
 * Lists every cached grant for an app — one entry per space — so hosts can
 * report what the viewer previously consented to without a server round trip.
 * Entries past their re-consent window are dropped on read.
 */
export function listGrantedAppScopes(
	userUuid: string | null | undefined,
	appId: string,
	homeSpaceId?: string,
): Array<{ spaceId: string; scopes: Permission[] }> {
	if (!userUuid || !appId || !isBrowser()) return [];
	const prefix = `${STORAGE_PREFIX}:${encodeURIComponent(userUuid)}:${encodeURIComponent(appId)}:`;
	const grants: Array<{ spaceId: string; scopes: Permission[] }> = [];
	try {
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key?.startsWith(prefix)) continue;
			// "…:<appId>:v1" is the home-space entry; "…:<appId>:<spaceId>:v1" is per space.
			const match = key.slice(prefix.length).match(/^(?:(.*):)?v\d+$/);
			// The legacy home-space entry only maps to a space when the caller
			// supplies the app's home space id.
			const spaceId = match?.[1] || homeSpaceId;
			if (!spaceId) continue;
			const raw = localStorage.getItem(key);
			if (!raw) continue;
			const parsed = JSON.parse(raw) as unknown;
			if (
				!isCachedAppGrant(parsed) ||
				parsed.userUuid !== userUuid ||
				parsed.appId !== appId ||
				Date.now() - parsed.updatedAt > MAX_AGE_MS
			) {
				continue;
			}
			grants.push({ spaceId: decodeURIComponent(spaceId), scopes: parsed.scopes });
		}
	} catch {
		// Ignore storage failures.
	}
	return grants;
}

/**
 * Records the granted scopes for an app on a space. Replaces any previously
 * cached scopes so the cache mirrors the server row exactly — an explicit
 * consent with fewer scopes must narrow the cache too, or silent reuse could
 * hand back permissions the viewer just removed.
 */
export function setGrantedAppScopes(
	userUuid: string | null | undefined,
	appId: string,
	scopes: readonly Permission[],
	spaceId?: string,
) {
	if (!userUuid || !appId || scopes.length === 0) return;
	const entry: CachedAppGrant = {
		version: CACHE_VERSION,
		userUuid,
		appId,
		scopes: Array.from(new Set(scopes)),
		updatedAt: Date.now(),
	};
	if (!isBrowser()) return;
	try {
		localStorage.setItem(storageKey(userUuid, appId, spaceId), JSON.stringify(entry));
	} catch {
		// Ignore quota and privacy-mode failures.
	}
}

/**
 * Synchronizes a cached grant with the server while preserving the last
 * explicit-consent timestamp. Also migrates legacy keys to the canonical Space.
 */
export function syncGrantedAppScopes(
	userUuid: string | null | undefined,
	appId: string,
	fromSpaceId: string | undefined,
	toSpaceId: string,
	scopes: readonly Permission[],
) {
	if (!userUuid || !appId || !toSpaceId || scopes.length === 0 || !isBrowser()) return;
	const entry = readEntry(userUuid, appId, toSpaceId) ?? readEntry(userUuid, appId, fromSpaceId);
	if (!entry) return;
	try {
		localStorage.setItem(storageKey(userUuid, appId, toSpaceId), JSON.stringify({
			...entry,
			scopes: Array.from(new Set(scopes)),
		}));
		if (fromSpaceId !== toSpaceId) {
			localStorage.removeItem(storageKey(userUuid, appId, fromSpaceId));
		}
	} catch {
		// Ignore storage failures; the server remains the source of truth.
	}
}

/**
 * Clears cached grants. Pass an appId to clear one app (optionally one
 * space), or omit it to clear every cached grant for the user (sign-out).
 */
export function clearGrantedAppScopes(
	userUuid: string | null | undefined,
	appId?: string,
	spaceId?: string,
) {
	if (!isBrowser() || !userUuid) return;
	try {
		if (appId) {
			localStorage.removeItem(storageKey(userUuid, appId, spaceId));
			return;
		}
		const prefix = userPrefix(userUuid);
		for (let i = localStorage.length - 1; i >= 0; i -= 1) {
			const key = localStorage.key(i);
			if (key?.startsWith(prefix)) localStorage.removeItem(key);
		}
	} catch {
		// Ignore storage failures.
	}
}
