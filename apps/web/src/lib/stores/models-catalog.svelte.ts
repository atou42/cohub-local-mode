import { isModelHidden, type ModelCatalogItem } from "$lib/model-catalog";
import { sdkForSpaceOrigin } from "$lib/sdk";
import type { SpaceOrigin } from "$lib/space-origin";
import type { AgentHarness } from "@cohub/protocol";

type CatalogKey = `${SpaceOrigin}:${AgentHarness}`;

class ModelsCatalogStore {
	items = $state<ModelCatalogItem[] | null>(null);
	visibleItems = $state<ModelCatalogItem[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<ModelCatalogItem[]> | null = null;
	private loadPromiseKey: CatalogKey | null = null;
	private loadedKey: CatalogKey | null = null;

	async load(
		options: {
			force?: boolean;
			origin?: SpaceOrigin;
			agentHarness?: AgentHarness;
		} = {},
	) {
		const origin = options.origin ?? "cloud";
		const agentHarness = options.agentHarness ?? "pi";
		const key: CatalogKey = `${origin}:${agentHarness}`;
		if (this.items && this.loadedKey === key && !options.force)
			return this.items;
		if (
			this.loadPromise &&
			this.loadPromiseKey === key &&
			!options.force
		)
			return this.loadPromise;
		if (this.loadedKey !== key) {
			this.items = null;
			this.visibleItems = null;
		}

		this.loading = true;
		this.error = null;
		const request = sdkForSpaceOrigin(origin).models
			.list(agentHarness)
			.then((catalog) => {
				const items: ModelCatalogItem[] = [];
				for (const entries of Object.values(catalog)) {
					for (const entry of entries) items.push(entry);
				}
				if (this.loadPromise !== request) return items;
				this.items = items;
				this.visibleItems = items.filter((item) => !isModelHidden(item));
				this.loadedKey = key;
				return items;
			})
			.catch((error) => {
				if (this.loadPromise !== request) throw error;
				this.error =
					error instanceof Error
						? error.message
						: "Failed to load models catalog";
				throw error;
			})
			.finally(() => {
				if (this.loadPromise !== request) return;
				this.loading = false;
				this.loadPromise = null;
				this.loadPromiseKey = null;
			});
		this.loadPromise = request;
		this.loadPromiseKey = key;

		return request;
	}
}

export const modelsCatalogStore = new ModelsCatalogStore();
