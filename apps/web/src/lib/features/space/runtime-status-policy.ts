/**
 * Freshness and backoff policy for the Space runtime status probe.
 *
 * `/api/spaces/:id/runtime` is polled by every Space surface, while a release
 * can ship the web app before the API that serves the route. A probe that keeps
 * failing is pure waste, so the policy distinguishes a missing route (404/405,
 * retried rarely) from an authorization or transient failure, and collapses the
 * focus/mount bursts that would otherwise hit the network more than once.
 */

/** Epoch-ms bookkeeping for one Space. */
export type RuntimeStatusFreshness = {
	/** Epoch ms of the last successful probe; `0` when never probed. */
	lastSuccessAt: number;
	/** Epoch ms before which probing is pointless (backoff). */
	retryAt: number;
};

export const RUNTIME_STATUS_MIN_INTERVAL_MS = 10_000;
export const RUNTIME_STATUS_UNAVAILABLE_BACKOFF_MS = 2 * 60_000;
export const RUNTIME_STATUS_DENIED_BACKOFF_MS = 60_000;
export const RUNTIME_STATUS_ERROR_BACKOFF_MS = 30_000;

export function createRuntimeStatusFreshness(): RuntimeStatusFreshness {
	return { lastSuccessAt: 0, retryAt: 0 };
}

/** Backoff for a failed probe, keyed on the HTTP status when one is known. */
export function runtimeStatusBackoffMs(
	status: number | null | undefined,
): number {
	if (status === 404 || status === 405)
		return RUNTIME_STATUS_UNAVAILABLE_BACKOFF_MS;
	if (status === 401 || status === 403) return RUNTIME_STATUS_DENIED_BACKOFF_MS;
	return RUNTIME_STATUS_ERROR_BACKOFF_MS;
}

/**
 * Whether a probe should reach the network now: explicit refreshes always do,
 * otherwise an active backoff window or a very recent success keeps the cached
 * status.
 */
export function shouldRequestRuntimeStatus(
	freshness: RuntimeStatusFreshness,
	options: { now: number; force?: boolean },
): boolean {
	if (options.force) return true;
	if (options.now < freshness.retryAt) return false;
	if (freshness.lastSuccessAt === 0) return true;
	return (
		options.now - freshness.lastSuccessAt >= RUNTIME_STATUS_MIN_INTERVAL_MS
	);
}
