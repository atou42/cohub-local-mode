import type { HarnessReadinessResponse } from "@cohub/protocol";
import { canUseUserScopedCache, getCacheUserKey } from "$lib/cache/keys";
import {
	readHarnessReadinessCache,
	writeHarnessReadinessCache,
} from "$lib/stores/harness-readiness-cache-core";

function storageFor(userKey: string): Storage | null {
	if (typeof window === "undefined" || !canUseUserScopedCache(userKey))
		return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function readCachedHarnessReadiness() {
	const userKey = getCacheUserKey();
	const storage = storageFor(userKey);
	return storage ? readHarnessReadinessCache(storage, userKey) : null;
}

export function writeCachedHarnessReadiness(
	response: HarnessReadinessResponse,
	updatedAt = Date.now(),
) {
	const userKey = getCacheUserKey();
	const storage = storageFor(userKey);
	if (!storage) return;
	try {
		writeHarnessReadinessCache(storage, userKey, response, updatedAt);
	} catch {
		// The validated live response remains authoritative when browser storage fails.
	}
}
