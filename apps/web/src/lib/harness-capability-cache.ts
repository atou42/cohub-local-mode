import type { AgentHarness, HarnessCapabilityCatalog } from "@neta-art/cohub";
import {
	canUseUserScopedCache,
	encodeKeyPart,
	getCacheUserKey,
} from "$lib/cache/keys";
import {
	HARNESS_CAPABILITY_CACHE_VERSION,
	isHarnessCapabilityCatalog,
} from "$lib/harness-capability-validation";

function getCacheKey(spaceId: string, harness: AgentHarness, userKey: string) {
	return `cohub:harness-capabilities:${[userKey, spaceId, harness, `v${HARNESS_CAPABILITY_CACHE_VERSION}`].map(encodeKeyPart).join(":")}`;
}

export function readCachedHarnessCapabilities(
	spaceId: string,
	harness: AgentHarness,
) {
	if (typeof localStorage === "undefined") return null;
	const userKey = getCacheUserKey();
	if (!canUseUserScopedCache(userKey)) return null;
	try {
		const raw = localStorage.getItem(getCacheKey(spaceId, harness, userKey));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		return isHarnessCapabilityCatalog(parsed) && parsed.harness === harness
			? parsed
			: null;
	} catch {
		return null;
	}
}

export function writeCachedHarnessCapabilities(
	spaceId: string,
	catalog: HarnessCapabilityCatalog,
) {
	if (typeof localStorage === "undefined") return;
	const userKey = getCacheUserKey();
	if (!canUseUserScopedCache(userKey)) return;
	try {
		localStorage.setItem(
			getCacheKey(spaceId, catalog.harness, userKey),
			JSON.stringify(catalog),
		);
	} catch {
		// Cache writes are best-effort; live data remains authoritative.
	}
}
