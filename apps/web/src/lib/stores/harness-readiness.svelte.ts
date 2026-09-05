import type {
	AgentHarness,
	HarnessReadinessEntry,
	HarnessReadinessResponse,
} from "@cohub/protocol";
import { getCacheUserKey } from "$lib/cache/keys";
import { sdkForSpaceOrigin } from "$lib/sdk";
import {
	readCachedHarnessReadiness,
	writeCachedHarnessReadiness,
} from "$lib/stores/harness-readiness-cache";
import {
	HARNESS_READINESS_REFRESH_AFTER_MS,
	isHarnessReadinessResponse,
} from "$lib/stores/harness-readiness-cache-core";

class HarnessReadinessStore {
	entries = $state<HarnessReadinessEntry[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	private updatedAt = 0;
	private loadedUserKey: string | null = null;
	private inflight: Promise<HarnessReadinessResponse> | null = null;

	entry(harness: AgentHarness) {
		return this.entries?.find((entry) => entry.harness === harness) ?? null;
	}

	async load(options: { force?: boolean } = {}) {
		const userKey = getCacheUserKey();
		if (this.loadedUserKey !== userKey) {
			this.entries = null;
			this.updatedAt = 0;
			this.loadedUserKey = userKey;
			const cached = readCachedHarnessReadiness();
			if (cached) {
				this.entries = cached.response.harnesses;
				this.updatedAt = cached.updatedAt;
			}
		}
		if (this.inflight) return this.inflight;
		if (this.entries && !options.force) {
			if (Date.now() - this.updatedAt > HARNESS_READINESS_REFRESH_AFTER_MS) {
				void this.load({ force: true }).catch((error) => {
					console.error("Failed to refresh harness readiness:", error);
				});
			}
			return {
				checkedAt: new Date(this.updatedAt).toISOString(),
				harnesses: this.entries,
			};
		}

		this.loading = !this.entries;
		this.error = null;
		const request = sdkForSpaceOrigin("local").harnessReadiness.list({
			force: options.force,
		});
		this.inflight = request;
		try {
			const response = await request;
			if (!isHarnessReadinessResponse(response)) {
				throw new Error("Local Agent readiness response is invalid");
			}
			if (this.inflight !== request || this.loadedUserKey !== userKey)
				return response;
			this.entries = response.harnesses;
			this.updatedAt = Date.now();
			writeCachedHarnessReadiness(response, this.updatedAt);
			return response;
		} catch (error) {
			if (this.inflight === request) {
				this.error =
					error instanceof Error
						? error.message
						: "Local Agent status could not be loaded";
			}
			throw error;
		} finally {
			if (this.inflight === request) {
				this.inflight = null;
				this.loading = false;
			}
		}
	}
}

export const harnessReadinessStore = new HarnessReadinessStore();
