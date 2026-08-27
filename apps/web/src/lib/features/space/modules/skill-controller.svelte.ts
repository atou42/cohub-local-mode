import type { SkillCatalogEntry } from "@neta-art/cohub";
import { sdkForSpaceOrigin } from "$lib/sdk";
import { readCachedSkills, writeCachedSkills } from "$lib/skill-cache";
import { resolveSpaceOrigin } from "$lib/space-origin";

export function createSkillController(options: { getSpaceId: () => string }) {
	let items = $state<SkillCatalogEntry[]>([]);
	let loaded = $state(false);
	let loadedFor = $state<string | null>(null);
	let refreshError = $state<string | null>(null);
	let refreshInFlight: Promise<void> | null = null;
	let refreshInFlightFor: string | null = null;

	function restore(targetSpaceId: string) {
		const cached = readCachedSkills(targetSpaceId);
		if (!cached) {
			items = [];
			loaded = false;
			loadedFor = null;
			refreshError = null;
			return;
		}
		items = cached;
		loaded = true;
		loadedFor = targetSpaceId;
		refreshError = null;
	}

	async function refresh(targetSpaceId: string) {
		if (refreshInFlight && refreshInFlightFor === targetSpaceId) {
			return refreshInFlight;
		}
		const run = (async () => {
			try {
				const response = await sdkForSpaceOrigin(
					resolveSpaceOrigin(targetSpaceId),
				).skills.list({ spaceId: targetSpaceId });
				writeCachedSkills(targetSpaceId, response.skills);
				if (options.getSpaceId() !== targetSpaceId) return;
				items = response.skills;
				loaded = true;
				loadedFor = targetSpaceId;
				refreshError = null;
			} catch (error) {
				console.error("Failed to load skills:", error);
				if (options.getSpaceId() !== targetSpaceId) return;
				// Keep any restored cache; mark loaded so slash menu is not stuck.
				loaded = true;
				loadedFor = targetSpaceId;
				refreshError =
					error instanceof Error ? error.message : "Failed to refresh skills";
			}
		},
	});

	function restore(targetSpaceId: string) {
		const cached = readCachedSkills(targetSpaceId);
		if (!cached) {
			items = [];
			loaded = false;
			loadedFor = null;
			return;
		}
		items = cached;
		loaded = true;
		loadedFor = targetSpaceId;
	}

	async function load(loadOptions: CatalogRefreshOptions = {}) {
		const targetSpaceId = options.getSpaceId();
		if (loadedFor !== targetSpaceId) restore(targetSpaceId);
		await refreshCoordinator.refresh(targetSpaceId, loadOptions);
	}

	return {
		get items() {
			return items;
		},
		get loaded() {
			return loaded;
		},
		get loadedFor() {
			return loadedFor;
		},
		get refreshError() {
			return refreshError;
		},
		load,
		restore,
		refresh: refreshCoordinator.refresh,
	};
}
