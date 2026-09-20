import { HttpError, type RuntimeStatus } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import {
	createRuntimeStatusFreshness,
	type RuntimeStatusFreshness,
	runtimeStatusBackoffMs,
	shouldRequestRuntimeStatus,
} from "./runtime-status-policy";

const statuses = $state<Record<string, RuntimeStatus>>({});
const fetchedAt = $state<Record<string, number>>({});
const pending = new Map<string, Promise<RuntimeStatus | null>>();
const freshness = new Map<string, RuntimeStatusFreshness>();

export const cachedRuntimeStatus = (spaceId: string) =>
	statuses[spaceId] ?? null;

/** Epoch ms of the last successful status fetch for a Space, if any. */
export const cachedRuntimeStatusFetchedAt = (spaceId: string) =>
	fetchedAt[spaceId] ?? null;

function freshnessFor(spaceId: string) {
	let current = freshness.get(spaceId);
	if (!current) {
		current = createRuntimeStatusFreshness();
		freshness.set(spaceId, current);
	}
	return current;
}

/**
 * Fetch the runtime status for a Space, coalescing concurrent callers and
 * honouring the freshness/backoff policy. `force` bypasses both, for explicit
 * user actions that must observe the server immediately.
 */
export function refreshRuntimeStatus(
	spaceId: string,
	options: { force?: boolean } = {},
) {
	const inFlight = pending.get(spaceId);
	if (inFlight) return inFlight;

	const state = freshnessFor(spaceId);
	if (
		!shouldRequestRuntimeStatus(state, {
			now: Date.now(),
			force: options.force,
		})
	)
		return Promise.resolve(statuses[spaceId] ?? null);

	const request = sdk
		.space(spaceId)
		.getRuntime()
		.then((status) => {
			statuses[spaceId] = status;
			fetchedAt[spaceId] = Date.now();
			state.lastSuccessAt = Date.now();
			state.retryAt = 0;
			return status as RuntimeStatus | null;
		})
		.catch((error) => {
			state.retryAt =
				Date.now() +
				runtimeStatusBackoffMs(
					error instanceof HttpError ? error.status : null,
				);
			throw error;
		})
		.finally(() => {
			if (pending.get(spaceId) === request) pending.delete(spaceId);
		});
	pending.set(spaceId, request);
	return request;
}
