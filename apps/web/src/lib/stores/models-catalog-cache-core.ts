import type { AgentHarness } from "@cohub/protocol";
import type { ModelCatalogItem } from "$lib/model-catalog";
import type { SpaceOrigin } from "$lib/space-origin";

export const MODEL_CATALOG_CACHE_VERSION = 4;
export const MODEL_CATALOG_CACHE_REFRESH_AFTER_MS = 5 * 60 * 1000;
export const MODEL_CATALOG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CURSOR_ALLOWED_MODEL_NAMES = new Set(["grok-4.6", "claude-fable-5"]);

type PersistedModelCatalog = {
	version: typeof MODEL_CATALOG_CACHE_VERSION;
	origin: SpaceOrigin;
	harness: AgentHarness;
	updatedAt: number;
	items: ModelCatalogItem[];
};

function storageKey(
	userKey: string,
	origin: SpaceOrigin,
	harness: AgentHarness,
) {
	return `cohub:model-catalog:v${MODEL_CATALOG_CACHE_VERSION}:${[
		userKey,
		origin,
		harness,
	]
		.map(encodeURIComponent)
		.join(":")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isModelCatalogItem(value: unknown): value is ModelCatalogItem {
	if (
		!isRecord(value) ||
		typeof value.provider !== "string" ||
		!value.provider.trim()
	)
		return false;
	if (
		typeof value.id !== "string" ||
		!value.id.trim() ||
		!isRecord(value.model)
	)
		return false;
	return (
		typeof value.model.name === "string" && Boolean(value.model.name.trim())
	);
}

export function readModelsCatalogCache(
	storage: Storage,
	userKey: string,
	origin: SpaceOrigin,
	harness: AgentHarness,
	now = Date.now(),
): { items: ModelCatalogItem[]; updatedAt: number } | null {
	try {
		const parsed = JSON.parse(
			storage.getItem(storageKey(userKey, origin, harness)) ?? "null",
		) as unknown;
		if (!isRecord(parsed) || parsed.version !== MODEL_CATALOG_CACHE_VERSION)
			return null;
		if (parsed.origin !== origin || parsed.harness !== harness) return null;
		if (
			typeof parsed.updatedAt !== "number" ||
			!Number.isFinite(parsed.updatedAt)
		)
			return null;
		if (now - parsed.updatedAt > MODEL_CATALOG_CACHE_MAX_AGE_MS) return null;
		if (
			!Array.isArray(parsed.items) ||
			parsed.items.length === 0 ||
			!parsed.items.every(isModelCatalogItem)
		)
			return null;
		if (
			harness === "cursor" &&
			!parsed.items.every((item) =>
				CURSOR_ALLOWED_MODEL_NAMES.has(
					item.id.split("[", 1)[0]?.trim() ?? item.id,
				),
			)
		)
			return null;
		return { items: parsed.items, updatedAt: parsed.updatedAt };
	} catch {
		return null;
	}
}

export function writeModelsCatalogCache(
	storage: Storage,
	userKey: string,
	origin: SpaceOrigin,
	harness: AgentHarness,
	items: ModelCatalogItem[],
	updatedAt = Date.now(),
) {
	if (items.length === 0 || !items.every(isModelCatalogItem)) return;
	const value: PersistedModelCatalog = {
		version: MODEL_CATALOG_CACHE_VERSION,
		origin,
		harness,
		updatedAt,
		items,
	};
	storage.setItem(storageKey(userKey, origin, harness), JSON.stringify(value));
}

export function clearModelsCatalogCache(
	storage: Storage,
	userKey: string,
	origin: SpaceOrigin,
	harness: AgentHarness,
) {
	storage.removeItem(storageKey(userKey, origin, harness));
}
