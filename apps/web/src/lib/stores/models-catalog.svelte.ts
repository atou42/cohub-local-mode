import type { AgentHarness } from "@cohub/protocol";
import { getCacheUserKey } from "$lib/cache/keys";
import { isModelHidden, type ModelCatalogItem } from "$lib/model-catalog";
import { sdkForSpaceOrigin } from "$lib/sdk";
import type { SpaceOrigin } from "$lib/space-origin";
import {
	MODEL_CATALOG_CACHE_REFRESH_AFTER_MS,
	readCachedModelsCatalog,
	writeCachedModelsCatalog,
} from "$lib/stores/models-catalog-cache";

type CatalogKey = `${SpaceOrigin}:${AgentHarness}`;
const CURSOR_ALLOWED_MODEL_NAMES = new Set(["grok-4.6", "claude-fable-5-1"]);

function isAllowedCursorModel(item: ModelCatalogItem) {
	const baseId = item.id.split("[", 1)[0]?.trim() ?? item.id;
	return CURSOR_ALLOWED_MODEL_NAMES.has(baseId);
}

class ModelsCatalogStore {
	items = $state<ModelCatalogItem[] | null>(null);
	visibleItems = $state<ModelCatalogItem[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private loadPromise: Promise<ModelCatalogItem[]> | null = null;
	private loadPromiseKey: CatalogKey | null = null;
	private loadedKey: CatalogKey | null = null;
	private loadedUserKey: string | null = null;
	private loadedAt = 0;

	reset() {
		this.items = null;
		this.visibleItems = null;
		this.loading = false;
		this.error = null;
		this.loadPromise = null;
		this.loadPromiseKey = null;
		this.loadedKey = null;
		this.loadedUserKey = null;
		this.loadedAt = 0;
	}

	private applyItems(
		key: CatalogKey,
		userKey: string,
		items: ModelCatalogItem[],
		updatedAt: number,
	) {
		if (this.loadedKey !== key || this.loadedUserKey !== userKey) return;
		this.items = items;
		this.visibleItems = items.filter((item) => !isModelHidden(item));
		this.loadedAt = updatedAt;
	}

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
		const userKey = getCacheUserKey();
		if (this.loadedKey !== key || this.loadedUserKey !== userKey) {
			this.items = null;
			this.visibleItems = null;
			this.loadedAt = 0;
			this.loadedKey = key;
			this.loadedUserKey = userKey;
			const cached = readCachedModelsCatalog(origin, agentHarness);
			if (cached) this.applyItems(key, userKey, cached.items, cached.updatedAt);
		}
		if (this.loadPromise && this.loadPromiseKey === key) {
			return this.loadPromise;
		}
		if (this.items && !options.force) {
			if (Date.now() - this.loadedAt > MODEL_CATALOG_CACHE_REFRESH_AFTER_MS) {
				void this.load({ ...options, force: true }).catch((error) => {
					console.error("Failed to refresh models catalog:", error);
				});
			}
			return this.items;
		}

		this.loading = !this.items;
		this.error = null;
		const request = sdkForSpaceOrigin(origin)
			.models.list(agentHarness)
			.then((catalog) => {
				const items: ModelCatalogItem[] = [];
				for (const entries of Object.values(catalog)) {
					for (const entry of entries) items.push(entry);
				}
				const filteredItems =
					agentHarness === "cursor"
						? items.filter(isAllowedCursorModel)
						: items;
				if (filteredItems.length === 0) {
					throw new Error(
						agentHarness === "cursor"
							? "Cursor did not advertise the configured Grok or Fable models"
							: "The selected agent returned no models",
					);
				}
				if (
					this.loadPromise !== request ||
					this.loadedKey !== key ||
					this.loadedUserKey !== userKey
				)
					return items;
				this.applyItems(key, userKey, filteredItems, Date.now());
				if (getCacheUserKey() === userKey) {
					writeCachedModelsCatalog(
						origin,
						agentHarness,
						filteredItems,
						this.loadedAt,
					);
				}
				return filteredItems;
			})
			.catch((error) => {
				if (
					this.loadPromise !== request ||
					this.loadedKey !== key ||
					this.loadedUserKey !== userKey
				)
					throw error;
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

export function createModelsCatalogStore() {
	return new ModelsCatalogStore();
}

export const modelsCatalogStore = createModelsCatalogStore();
