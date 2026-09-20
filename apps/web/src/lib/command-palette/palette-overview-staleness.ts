/**
 * Pure staleness rules for the palette overview cache.
 *
 * Extracted so the semantics are testable without the browser/SDK import
 * chain: a snapshot is stale when it is older than the freshness window OR
 * when viewer activity invalidated it after it was cached.
 */

export const OVERVIEW_FRESH_MS = 60_000;
export const OVERVIEW_HARD_EXPIRY_MS = 10 * 60_000;

/**
 * Floor between two background revalidations, shared across tabs. The
 * freshness window decides whether a revalidation is needed at all; this only
 * bounds how often we are willing to hit the network when viewer activity
 * keeps invalidating the snapshot (sending a burst of messages, several
 * focus/visibility events).
 */
export const OVERVIEW_MIN_REVALIDATE_MS = 120_000;

export function isOverviewSnapshotStale(input: {
	cachedAt: number;
	invalidatedAt: number;
	now: number;
	freshMs?: number;
}) {
	const freshMs = input.freshMs ?? OVERVIEW_FRESH_MS;
	if (input.invalidatedAt > input.cachedAt) return true;
	return input.now - input.cachedAt > freshMs;
}

export function isOverviewSnapshotExpired(input: {
	cachedAt: number;
	now: number;
	hardExpiryMs?: number;
}) {
	const hardExpiryMs = input.hardExpiryMs ?? OVERVIEW_HARD_EXPIRY_MS;
	return input.now - input.cachedAt > hardExpiryMs;
}

/** Whether enough time has passed since the last refresh attempt to try again. */
export function shouldRevalidateOverview(input: {
	lastRefreshStartedAt: number;
	now: number;
	minIntervalMs?: number;
}) {
	const minIntervalMs = input.minIntervalMs ?? OVERVIEW_MIN_REVALIDATE_MS;
	return input.now - input.lastRefreshStartedAt >= minIntervalMs;
}
