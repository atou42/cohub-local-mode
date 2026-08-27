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
	let refreshError = $state<string | null>(null);
	let refreshInFlight: Promise<void> | null = null;
	let refreshInFlightFor: string | null = null;

	function restore(targetSpaceId: string) {
		const cached = readCachedPromptTemplates(targetSpaceId);
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
				).prompts.list({ spaceId: targetSpaceId });
				writeCachedPromptTemplates(targetSpaceId, response.prompts);
				if (options.getSpaceId() !== targetSpaceId) return;
				items = response.prompts;
				loaded = true;
				loadedFor = targetSpaceId;
				refreshError = null;
			} catch (error) {
				console.error("Failed to load prompt templates:", error);
				if (options.getSpaceId() !== targetSpaceId) return;
				loaded = true;
				loadedFor = targetSpaceId;
				refreshError =
					error instanceof Error ? error.message : "Failed to refresh commands";
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
		get refreshError() {
			return refreshError;
		},
		load,
		restore,
		refresh: refreshCoordinator.refresh,
	};
}
