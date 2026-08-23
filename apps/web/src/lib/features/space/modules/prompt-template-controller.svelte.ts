import type { PromptTemplateCatalogEntry } from "@neta-art/cohub";
import {
	readCachedPromptTemplates,
	writeCachedPromptTemplates,
} from "$lib/prompt-template-cache";
import { sdkForSpaceOrigin } from "$lib/sdk";
import { resolveSpaceOrigin } from "$lib/space-origin";

export function createPromptTemplateController(options: {
	getSpaceId: () => string;
}) {
	let items = $state<PromptTemplateCatalogEntry[]>([]);
	let loaded = $state(false);
	let loadedFor = $state<string | null>(null);
	const refreshCoordinator = createCatalogRefreshCoordinator({
		getSpaceId: options.getSpaceId,
		refresh: async (targetSpaceId) => {
			try {
				const response = await sdk.prompts.list({ spaceId: targetSpaceId });
				writeCachedPromptTemplates(targetSpaceId, response.prompts);
				if (options.getSpaceId() !== targetSpaceId) return;
				items = response.prompts;
				loaded = true;
				loadedFor = targetSpaceId;
			} catch (error) {
				console.error("Failed to load prompt templates:", error);
			}
		},
	});

	function restore(targetSpaceId: string) {
		const cached = readCachedPromptTemplates(targetSpaceId);
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

	async function refresh(targetSpaceId: string) {
		if (refreshInFlight && refreshInFlightFor === targetSpaceId) {
			return refreshInFlight;
		}
		const run = (async () => {
			try {
				const response = await sdkForSpaceOrigin(
					resolveSpaceOrigin(targetSpaceId),
				).prompts.list({ spaceId: targetSpaceId });
				writeCachedPromptTemplates(targetSpaceId, response.prompts);
				if (options.getSpaceId() !== targetSpaceId) return;
				items = response.prompts;
				loaded = true;
				loadedFor = targetSpaceId;
			} catch (error) {
				console.error("Failed to load prompt templates:", error);
			}
		})();
		const trackedRun = run.finally(() => {
			if (refreshInFlight === trackedRun) {
				refreshInFlight = null;
				refreshInFlightFor = null;
			}
		});
		refreshInFlight = trackedRun;
		refreshInFlightFor = targetSpaceId;
		return trackedRun;
	}

	async function load() {
		const targetSpaceId = options.getSpaceId();
		if (loadedFor !== targetSpaceId) restore(targetSpaceId);
		await refreshCoordinator.refresh(targetSpaceId, loadOptions);
	}

	const quickActions = $derived<PromptQuickAction[]>(
		items
			.filter((item) => item.quickAction)
			.slice()
			.sort((a, b) => {
				const orderDelta = (a.order ?? 0) - (b.order ?? 0);
				if (orderDelta !== 0) return orderDelta;
				return a.name.localeCompare(b.name);
			})
			.map((item) => ({
				name: item.name,
				label: item.buttonLabel?.trim() || item.description || item.name,
				description: item.description,
				argumentHint: item.argumentHint?.trim() || null,
			})),
	);

	return {
		get items() {
			return items;
		},
		get quickActions() {
			return quickActions;
		},
		get loaded() {
			return loaded;
		},
		get loadedFor() {
			return loadedFor;
		},
		load,
		restore,
		refresh: refreshCoordinator.refresh,
	};
}
