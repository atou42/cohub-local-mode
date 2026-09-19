import type { AgentHarness } from "@cohub/protocol";
import { canUseUserScopedCache, getCacheUserKey } from "$lib/cache/keys";
import type { ModelCatalogItem } from "$lib/model-catalog";
import type { SpaceOrigin } from "$lib/space-origin";
import {
	clearModelsCatalogCache,
	MODEL_CATALOG_CACHE_MAX_AGE_MS,
	MODEL_CATALOG_CACHE_REFRESH_AFTER_MS,
	MODEL_CATALOG_CACHE_VERSION,
	readModelsCatalogCache,
	writeModelsCatalogCache,
} from "$lib/stores/models-catalog-cache-core";

export {
	MODEL_CATALOG_CACHE_MAX_AGE_MS,
	MODEL_CATALOG_CACHE_REFRESH_AFTER_MS,
	MODEL_CATALOG_CACHE_VERSION,
};

function storageFor(userKey: string): Storage | null {
	if (typeof window === "undefined" || !canUseUserScopedCache(userKey))
		return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function readCachedModelsCatalog(
	origin: SpaceOrigin,
	harness: AgentHarness,
): { items: ModelCatalogItem[]; updatedAt: number } | null {
	const userKey = getCacheUserKey();
	const storage = storageFor(userKey);
	return storage
		? readModelsCatalogCache(storage, userKey, origin, harness)
		: null;
}

export function writeCachedModelsCatalog(
	origin: SpaceOrigin,
	harness: AgentHarness,
	items: ModelCatalogItem[],
	updatedAt = Date.now(),
) {
	const userKey = getCacheUserKey();
	const storage = storageFor(userKey);
	if (!storage) return;
	try {
		writeModelsCatalogCache(
			storage,
			userKey,
			origin,
			harness,
			items,
			updatedAt,
		);
	} catch {
		// Cache persistence is optional; the live response remains authoritative.
	}
}

export function clearCachedModelsCatalog(
	origin: SpaceOrigin,
	harness: AgentHarness,
) {
	const userKey = getCacheUserKey();
	const storage = storageFor(userKey);
	if (!storage) return;
	try {
		clearModelsCatalogCache(storage, userKey, origin, harness);
	} catch {
		// A cache clear must never interrupt the live model picker.
	}
}
