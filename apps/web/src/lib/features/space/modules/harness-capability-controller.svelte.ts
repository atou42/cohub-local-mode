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

	function reset() {
		catalog = null;
		loaded = true;
		loadedFor = null;
		refreshError = null;
	}

	function restore(target: Target) {
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
		const run = (async () => {
			try {
				const response = await sdkForSpaceOrigin(
					resolveSpaceOrigin(target.spaceId),
				).harnessCapabilities.list(target);
				writeCachedHarnessCapabilities(target.spaceId, response);
				if (refreshInFlightFor !== key) return;
				catalog = response;
				loaded = true;
				loadedFor = key;
				refreshError = null;
			} catch (error) {
				if (refreshInFlightFor !== key) return;
				loaded = true;
				loadedFor = key;
				refreshError =
					error instanceof Error
						? error.message
						: "Failed to refresh agent commands";
			}
		})();
		const tracked = run.finally(() => {
			if (refreshInFlight === tracked) {
				refreshInFlight = null;
				refreshInFlightFor = null;
			}
		});
		refreshInFlight = tracked;
		refreshInFlightFor = key;
		return tracked;
	}

	function load(target: Target) {
		const key = targetKey(target);
		if (loadedFor !== key) restore(target);
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
