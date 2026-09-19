import type {
	SpaceBootstrapStatus,
	SpaceMember,
	SpaceRecord,
	SpaceUsageResponse,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import {
	fetchSpaceMembersWithCache,
	fetchSpaceUsageWithCache,
	getCachedSpaceMembers,
	getCachedSpaceUsage,
} from "$lib/stores/space-profile-cache";
import { getCachedSpaceRecord } from "$lib/stores/space-record-cache";
import { createRequestDedupe } from "./request-dedupe";

export type SpaceSandboxSnapshot = {
	status: string | null;
	runtimeStatus?: string | null;
	lastHeartbeatAt?: string | null;
	lastActivityAt?: string | null;
	stoppedAt?: string | null;
	stopReason?: string | null;
};

export type BootstrapStatus = SpaceBootstrapStatus | null;

function readBootstrapStatus(space: SpaceRecord): BootstrapStatus {
	return space.meta?.bootstrap?.status ?? null;
}

export function createSpaceStatusController(options: {
	getSpaceId: () => string;
	getBootstrapStatus: () => BootstrapStatus;
	getPageVisible: () => boolean;
	getPageOnline: () => boolean;
	getPageMounted: () => boolean;
	getIsLocalSpace?: () => boolean;
	onSpaceLoaded: (space: SpaceRecord) => void;
}) {
	let loadError = $state("");
	let loadErrorStatus = $state<number | null>(null);
	let members = $state<SpaceMember[]>([]);
	let membersLoadedFor = $state<string | null>(null);
	let usage = $state<SpaceUsageResponse | null>(null);
	let usageLoadedFor = $state<string | null>(null);
	let sandbox = $state<SpaceSandboxSnapshot | null>(null);
	let sandboxLoadedFor = $state<string | null>(null);
	let notice = $state("");
	let noticeTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	const requests = createRequestDedupe();

	function clearNoticeTimer() {
		if (!noticeTimer) return;
		clearTimeout(noticeTimer);
		noticeTimer = null;
	}

	function showNotice(message: string) {
		notice = message;
		clearNoticeTimer();
		noticeTimer = setTimeout(() => {
			notice = "";
			noticeTimer = null;
		}, 2800);
	}

	async function loadSpace() {
		const currentSpaceId = options.getSpaceId();
		loadError = "";
		loadErrorStatus = null;
		const cached = await getCachedSpaceRecord(currentSpaceId);
		if (cached?.space && options.getSpaceId() === currentSpaceId) {
			options.onSpaceLoaded(cached.space);
		}
		try {
			const nextSpace = await requests.run(
				`space:${currentSpaceId}:record`,
				() => sdk.space(currentSpaceId).get(),
			);
			if (options.getSpaceId() !== currentSpaceId) return false;
			options.onSpaceLoaded(nextSpace);
			return true;
		} catch (error) {
			if (options.getSpaceId() !== currentSpaceId) return false;
			if (cached?.space && options.getIsLocalSpace?.()) return true;
			loadError =
				options.getIsLocalSpace?.() && !(error instanceof HttpError)
					? "Local Mac is offline"
					: error instanceof Error
						? error.message
						: "Failed to load space";
			loadErrorStatus = error instanceof HttpError ? error.status : null;
			return false;
		}
	}

	async function loadMembers(currentSpaceId = options.getSpaceId()) {
		const cached = getCachedSpaceMembers(currentSpaceId);
		if (cached && options.getSpaceId() === currentSpaceId) {
			members = cached;
			membersLoadedFor = currentSpaceId;
		}
		try {
			const nextMembers = await requests.run(
				`space:${currentSpaceId}:members`,
				() => fetchSpaceMembersWithCache(currentSpaceId),
			);
			if (options.getSpaceId() !== currentSpaceId) return;
			members = nextMembers;
			membersLoadedFor = currentSpaceId;
		} catch {
			if (options.getSpaceId() !== currentSpaceId) return;
			if (!cached) members = [];
			membersLoadedFor = currentSpaceId;
		}
	}

	async function loadUsage(currentSpaceId = options.getSpaceId()) {
		const days = 7;
		const cached = getCachedSpaceUsage(currentSpaceId, days);
		if (cached && options.getSpaceId() === currentSpaceId) {
			usage = cached;
			usageLoadedFor = currentSpaceId;
		}
		try {
			const result = await requests.run(
				`space:${currentSpaceId}:usage:${days}`,
				() => fetchSpaceUsageWithCache(currentSpaceId, days),
			);
			if (options.getSpaceId() !== currentSpaceId) return;
			usage = result;
			usageLoadedFor = currentSpaceId;
		} catch {
			if (options.getSpaceId() !== currentSpaceId) return;
			if (!cached) usage = null;
			usageLoadedFor = currentSpaceId;
		}
	}

	async function loadSandbox(currentSpaceId = options.getSpaceId()) {
		try {
			const result = await requests.run(`space:${currentSpaceId}:sandbox`, () =>
				sdk.space(currentSpaceId).sandbox.get(),
			);
			if (options.getSpaceId() !== currentSpaceId) return;
			sandbox = result.sandbox;
			sandboxLoadedFor = currentSpaceId;
		} catch {
			if (options.getSpaceId() !== currentSpaceId) return;
			sandbox = null;
			sandboxLoadedFor = currentSpaceId;
		}
	}

	function getRefreshIntervalMs() {
		if (!options.getPageVisible() || !options.getPageOnline()) return null;
		const status = options.getBootstrapStatus();
		if (status === "pending" || status === "running") return 4000;
		if (status === "failed") return 15000;
		return null;
	}

	async function refreshStatus() {
		const currentSpaceId = options.getSpaceId();
		const previousBootstrapStatus = options.getBootstrapStatus();
		const nextSpace = await requests.run(`space:${currentSpaceId}:record`, () =>
			sdk.space(currentSpaceId).get(),
		);
		if (options.getSpaceId() !== currentSpaceId) return;
		options.onSpaceLoaded(nextSpace);
		if (
			previousBootstrapStatus !== "ready" &&
			readBootstrapStatus(nextSpace) === "ready"
		) {
			showNotice("Workspace prepared");
		}
	}

	function scheduleRefresh() {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		const intervalMs = getRefreshIntervalMs();
		if (!intervalMs || !options.getPageMounted()) return;
		refreshTimer = setTimeout(async () => {
			await refreshStatus().catch(() => undefined);
			scheduleRefresh();
		}, intervalMs);
	}

	function reset() {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = null;
		requests.clear();
		loadError = "";
		loadErrorStatus = null;
		members = [];
		membersLoadedFor = null;
		usage = null;
		usageLoadedFor = null;
		sandbox = null;
		sandboxLoadedFor = null;
		notice = "";
		clearNoticeTimer();
	}

	function dispose() {
		requests.clear();
		clearNoticeTimer();
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = null;
	}

	return {
		get loadError() {
			return loadError;
		},
		get loadErrorStatus() {
			return loadErrorStatus;
		},
		get members() {
			return members;
		},
		get membersLoadedFor() {
			return membersLoadedFor;
		},
		get usage() {
			return usage;
		},
		get usageLoadedFor() {
			return usageLoadedFor;
		},
		get sandbox() {
			return sandbox;
		},
		get sandboxLoadedFor() {
			return sandboxLoadedFor;
		},
		get notice() {
			return notice;
		},
		loadSpace,
		loadMembers,
		loadUsage,
		loadSandbox,
		showNotice,
		refreshStatus,
		scheduleRefresh,
		reset,
		dispose,
	};
}
