import { isModelHidden, type ModelCatalogItem } from "$lib/model-catalog";
import { sdkForSpaceOrigin } from "$lib/sdk";
import type { SpaceOrigin } from "$lib/space-origin";

class ModelsCatalogStore {
	items = $state<ModelCatalogItem[] | null>(null);
	visibleItems = $state<ModelCatalogItem[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<ModelCatalogItem[]> | null = null;
	private loadPromiseOrigin: SpaceOrigin | null = null;
	private loadedOrigin: SpaceOrigin | null = null;

	async load(
		options: { force?: boolean; origin?: SpaceOrigin } = {},
	) {
		const origin = options.origin ?? "cloud";
		if (this.items && this.loadedOrigin === origin && !options.force)
			return this.items;
		if (
			this.loadPromise &&
			this.loadPromiseOrigin === origin &&
			!options.force
		)
			return this.loadPromise;
		if (this.loadedOrigin !== origin) {
			this.items = null;
			this.visibleItems = null;
		}

		this.loading = true;
		this.error = null;
		const request = sdkForSpaceOrigin(origin).models
			.list()
			.then((catalog) => {
				const items: ModelCatalogItem[] = [];
				for (const entries of Object.values(catalog)) {
					for (const entry of entries) items.push(entry);
				}
				if (this.loadPromise !== request) return items;
				this.items = items;
				this.visibleItems = items.filter((item) => !isModelHidden(item));
				this.loadedOrigin = origin;
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
				this.loadPromiseOrigin = null;
			});
		this.loadPromise = request;
		this.loadPromiseOrigin = origin;

		return request;
	}
}

export const modelsCatalogStore = new ModelsCatalogStore();
