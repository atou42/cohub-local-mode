import type { SpaceRecord } from "@neta-art/cohub";
import { createLocalListCache } from "$lib/stores/create-local-list-cache";
import { cacheSpaceRecordsSoon } from "$lib/stores/space-record-cache";
import { canUseUserScopedCache, getCacheUserKey } from "$lib/cache/keys";
import { PartialSpaceListError } from "$lib/merged-space-list";
import { getSpaceOrigin } from "$lib/space-origin";

const SPACE_LIST_SCOPE = "all";
// Incomplete reads are display-only; never persist them as a full fresh list.
const partialByUser = new Map<string, { spaces: SpaceRecord[]; message: string }>();

function dedupeSpaces(spaces: SpaceRecord[]) {
	const byId = new Map<string, SpaceRecord>();
	for (const space of spaces) {
		const normalized = { ...space, isPinned: space.isPinned ?? false };
		if (!byId.has(space.id)) {
			byId.set(space.id, normalized);
			continue;
		}
		byId.set(space.id, { ...byId.get(space.id), ...normalized });
	}
	return Array.from(byId.values());
}

const cache = createLocalListCache<SpaceRecord>({
	storagePrefix: "cohub:space-list",
	cacheVersion: 1,
	updatedEventName: "cohub:space-list-updated",
	ttlMs: 60_000,
	normalize: dedupeSpaces,
});

export function getCachedSpaceList(): SpaceRecord[] | null {
	if (!canUseUserScopedCache()) return null;
	const partial = partialByUser.get(getCacheUserKey());
	if (partial) return partial.spaces;
	return cache.getCached(SPACE_LIST_SCOPE);
}

export function getSpaceListLoadError(): string | null {
	return canUseUserScopedCache() ? partialByUser.get(getCacheUserKey())?.message ?? null : null;
}

export function getCachedSpaceListMeta() {
	if (getSpaceListLoadError()) return { updatedAt: cache.getCachedMeta(SPACE_LIST_SCOPE)?.updatedAt ?? 0, isStale: true };
	return cache.getCachedMeta(SPACE_LIST_SCOPE);
}

export function setCachedSpaceList(spaces: SpaceRecord[]): SpaceRecord[] {
	partialByUser.delete(getCacheUserKey());
	const next = cache.setCached(SPACE_LIST_SCOPE, spaces);
	cacheSpaceRecordsSoon(next);
	return next;
}

export function patchCachedSpaceList(
	updater: (spaces: SpaceRecord[]) => SpaceRecord[],
): SpaceRecord[] {
	const partial = partialByUser.get(getCacheUserKey());
	if (partial && canUseUserScopedCache()) {
		partial.spaces = dedupeSpaces(updater(partial.spaces));
		cacheSpaceRecordsSoon(partial.spaces);
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("cohub:space-list-updated", { detail: { scope: SPACE_LIST_SCOPE, data: partial.spaces } }));
		}
		return partial.spaces;
	}
	const next = cache.patchCached(SPACE_LIST_SCOPE, updater);
	cacheSpaceRecordsSoon(next);
	return next;
}

export function clearCachedSpaceList() {
	partialByUser.delete(getCacheUserKey());
	cache.clearCached(SPACE_LIST_SCOPE);
}

export function clearAllCachedSpaceLists() {
	partialByUser.delete(getCacheUserKey());
	cache.clearAllForCurrentUser();
}

export function onSpaceListCacheUpdated(
	handler: (event: { spaces: SpaceRecord[] }) => void,
) {
	return cache.onUpdated(({ data }) => {
		handler({ spaces: data });
	});
}

export async function fetchSpaceListWithCache(
	fetcher: () => Promise<SpaceRecord[]>,
	options?: { force?: boolean },
): Promise<SpaceRecord[]> {
	const userKey = getCacheUserKey();
	let spaces: SpaceRecord[];
	try {
		spaces = await cache.fetchWithCache(SPACE_LIST_SCOPE, async () => {
			const result = await fetcher();
			if (getCacheUserKey() !== userKey) throw new Error("Space list account changed during refresh");
			partialByUser.delete(userKey);
			return result;
		}, options);
	} catch (error) {
		if (error instanceof PartialSpaceListError && getCacheUserKey() === userKey && canUseUserScopedCache()) {
			const failedOrigins = new Set(error.failures.map(({ origin }) => origin));
			const retained = (getCachedSpaceList() ?? []).filter((space) => failedOrigins.has(getSpaceOrigin(space)));
			const partial = { spaces: dedupeSpaces([...retained, ...error.spaces]), message: error.message };
			const previous = partialByUser.get(userKey);
			partialByUser.set(userKey, partial);
			if (typeof window !== "undefined" && JSON.stringify(previous) !== JSON.stringify(partial)) {
				window.dispatchEvent(new CustomEvent("cohub:space-list-updated", { detail: { scope: SPACE_LIST_SCOPE, data: partial.spaces } }));
			}
		} else if (getCacheUserKey() === userKey && canUseUserScopedCache()) {
			const partial = partialByUser.get(userKey);
			const message = error instanceof Error ? error.message : String(error);
			if (partial && partial.message !== message) {
				partial.message = message;
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("cohub:space-list-updated", { detail: { scope: SPACE_LIST_SCOPE, data: partial.spaces } }));
				}
			}
		}
		throw error;
	}
	cacheSpaceRecordsSoon(spaces);
	return spaces;
}
