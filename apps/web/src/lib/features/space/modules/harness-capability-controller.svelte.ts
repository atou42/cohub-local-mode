import type { AgentHarness, HarnessCapabilityCatalog } from "@neta-art/cohub";
import {
	readCachedHarnessCapabilities,
	writeCachedHarnessCapabilities,
} from "$lib/harness-capability-cache";
import { sdkForSpaceOrigin } from "$lib/sdk";
import { resolveSpaceOrigin } from "$lib/space-origin";

type Target = { spaceId: string; harness: AgentHarness };

function targetKey(target: Target) {
	return `${target.spaceId}:${target.harness}`;
}

export function createHarnessCapabilityController() {
	let catalog = $state<HarnessCapabilityCatalog | null>(null);
	let loaded = $state(false);
	let loadedFor = $state<string | null>(null);
	let refreshError = $state<string | null>(null);
	let refreshInFlight: Promise<void> | null = null;
	let refreshInFlightFor: string | null = null;
	let refreshEpoch = 0;

	function invalidateRefresh() {
		refreshEpoch += 1;
		refreshInFlight = null;
		refreshInFlightFor = null;
	}

	function reset() {
		invalidateRefresh();
		catalog = null;
		loaded = true;
		loadedFor = null;
		refreshError = null;
	}

	function restore(target: Target) {
		invalidateRefresh();
		const key = targetKey(target);
		const cached = readCachedHarnessCapabilities(
			target.spaceId,
			target.harness,
		);
		catalog = cached;
		loaded = Boolean(cached);
		loadedFor = cached ? key : null;
		refreshError = null;
	}

	async function refresh(target: Target) {
		const key = targetKey(target);
		if (refreshInFlight && refreshInFlightFor === key) return refreshInFlight;
		const epoch = ++refreshEpoch;
		refreshInFlightFor = key;
		const run = (async () => {
			try {
				const response = await sdkForSpaceOrigin(
					resolveSpaceOrigin(target.spaceId),
				).harnessCapabilities.list(target);
				if (refreshEpoch !== epoch) return;
				writeCachedHarnessCapabilities(target.spaceId, response);
				catalog = response;
				loaded = true;
				loadedFor = key;
				refreshError = null;
			} catch (error) {
				if (refreshEpoch !== epoch) return;
				loaded = true;
				loadedFor = key;
				refreshError =
					error instanceof Error
						? error.message
						: "Failed to refresh agent commands";
			}
		})();
		const tracked = run.finally(() => {
			if (refreshEpoch === epoch && refreshInFlight === tracked) {
				refreshInFlight = null;
				refreshInFlightFor = null;
			}
		});
		refreshInFlight = tracked;
		return tracked;
	}

	function load(target: Target) {
		const key = targetKey(target);
		if (loadedFor !== key && refreshInFlightFor !== key) restore(target);
		return refresh(target);
	}

	return {
		get catalog() {
			return catalog;
		},
		get loaded() {
			return loaded;
		},
		get refreshError() {
			return refreshError;
		},
		reset,
		restore,
		refresh,
		load,
	};
}
