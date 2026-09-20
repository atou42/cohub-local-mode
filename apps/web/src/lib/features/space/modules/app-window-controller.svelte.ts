import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type { AppDetailResponse } from "@neta-art/cohub";
import { appDisplayTitle } from "$lib/app-page-meta";
import { loadAppPreview } from "$lib/features/app/app-open";
import { isNewerAppSnapshot } from "$lib/features/app/app-realtime";
import type { AppSurfaceRegistry } from "$lib/features/app/surface-registry";
import { createRequestDedupe } from "./request-dedupe";
import {
	createWorkspaceAppInvocation,
	type WorkspaceAppInvocation,
	type WorkspaceAppOpenContext,
} from "./workspace-app-context";

export type AppLaunchState = { search?: string; hash?: string };

export type InlineAppPreview = {
	appId: string;
	mountKey: number;
	label: string;
	detail: AppDetailResponse | null;
	loading: boolean;
	error: string | null;
	refreshError: string | null;
	launch: AppLaunchState | null;
	invocation: WorkspaceAppInvocation;
	composerChip: AppComposerChip | null;
};

type AppPreviewControllerOptions = {
	getSpaceId: () => string;
	surfaces: AppSurfaceRegistry;
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	/** A tab actually went away, so a coordinator can re-derive the active ref. */
	onAppClosed?: (appId: string) => void;
	loadApp?: (appId: string) => Promise<AppDetailResponse>;
	loadPublicApp?: (appId: string) => Promise<AppDetailResponse>;
};

function invocationContextsEqual(
	left: WorkspaceAppInvocation,
	right: WorkspaceAppInvocation,
) {
	return (
		left?.surface === right?.surface &&
		left?.source === right?.source &&
		left?.spaceId === right?.spaceId &&
		left?.sessionId === right?.sessionId &&
		left?.turnId === right?.turnId &&
		left?.toolCallId === right?.toolCallId
	);
}

export function createAppPreviewController(
	options: AppPreviewControllerOptions,
) {
	let previews = $state<InlineAppPreview[]>([]);
	let activeAppId = $state<string | null>(null);
	let nextMountKey = 0;
	const requests = createRequestDedupe();
	const detailSettled = new Map<string, Promise<void>>();
	const loadTokens = new Map<string, number>();

	const loadApp =
		options.loadApp ??
		(async (appId: string) => (await import("$lib/sdk")).sdk.apps.get(appId));
	const loadPublicApp =
		options.loadPublicApp ??
		(async (appId: string) =>
			(await import("$lib/sdk")).sdk.apps.getPublicById(appId));

	/**
	 * A public App in a Space we cannot view is still previewable, and
	 * desktop commands accept public references, so a denied member read falls
	 * back to the public one rather than showing a permission error.
	 */
	async function loadDetailFor(appId: string): Promise<AppDetailResponse> {
		return loadAppPreview(
			{ get: loadApp, getPublicById: loadPublicApp },
			appId,
		);
	}

	function patch(appId: string, next: Partial<InlineAppPreview>) {
		previews = previews.map((item) =>
			item.appId === appId ? { ...item, ...next } : item,
		);
	}

	async function loadDetail(
		appId: string,
		loadOptions: { force?: boolean; remount?: boolean } = {},
	) {
		const requestSpaceId = options.getSpaceId();
		const token = (loadTokens.get(appId) ?? 0) + 1;
		loadTokens.set(appId, token);
		patch(appId, { loading: true, error: null, refreshError: null });
		const settle = (async () => {
			try {
				const detail = await requests.run(
					`app:${appId}`,
					() => loadDetailFor(appId),
					{ force: loadOptions.force },
				);
				const current = previews.find((item) => item.appId === appId);
				if (
					options.getSpaceId() !== requestSpaceId ||
					loadTokens.get(appId) !== token ||
					!current
				)
					return;
				const changed = isNewerAppSnapshot(
					current.detail?.app ?? null,
					detail.app,
				);
				if (current.detail && !changed) {
					patch(appId, { loading: false, refreshError: null });
					return;
				}
				patch(appId, {
					detail,
					loading: false,
					error: null,
					refreshError: null,
					label: appDisplayTitle(detail.app.meta, detail.app.slug),
					...(loadOptions.remount && changed
						? { mountKey: ++nextMountKey }
						: {}),
				});
			} catch (cause) {
				if (
					options.getSpaceId() !== requestSpaceId ||
					loadTokens.get(appId) !== token
				)
					return;
				const current = previews.find((item) => item.appId === appId);
				if (current?.detail) {
					patch(appId, {
						loading: false,
						refreshError:
							cause instanceof Error
								? cause.message
								: "Failed to refresh this App.",
					});
					return;
				}
				patch(appId, {
					loading: false,
					error:
						cause instanceof Error ? cause.message : "Failed to load this App.",
				});
			}
		})();
		detailSettled.set(appId, settle);
		await settle;
	}

	function openApp(input: {
		appId: string;
		label?: string;
		launch?: AppLaunchState | null;
		openContext: WorkspaceAppOpenContext;
	}) {
		const invocation = createWorkspaceAppInvocation(
			options.getSpaceId(),
			input.openContext,
		);
		const existing = previews.find((item) => item.appId === input.appId);
		if (existing) {
			const launch = input.launch ?? null;
			const launchChanged =
				input.launch !== undefined &&
				((existing.launch?.search ?? "") !== (launch?.search ?? "") ||
					(existing.launch?.hash ?? "") !== (launch?.hash ?? ""));
			const invocationChanged = !invocationContextsEqual(
				existing.invocation,
				invocation,
			);
			if (launchChanged || invocationChanged) {
				patch(input.appId, {
					...(launchChanged ? { launch } : {}),
					invocation,
				});
			}
			activeAppId = input.appId;
			options.onOpenPanel?.();
			if (!existing.detail && !existing.loading) void loadDetail(input.appId);
			return;
		}
		previews = [
			...previews,
			{
				appId: input.appId,
				mountKey: ++nextMountKey,
				label: input.label?.trim() || "App",
				detail: null,
				loading: true,
				error: null,
				launch: input.launch ?? null,
				invocation,
				composerChip: null,
				refreshError: null,
			},
		];
		activeAppId = input.appId;
		options.onOpenPanel?.();
		void loadDetail(input.appId);
	}

	function activateApp(appId: string) {
		if (!previews.some((item) => item.appId === appId)) return;
		activeAppId = appId;
		options.onOpenPanel?.();
	}

	function closeApp(appId = activeAppId) {
		if (!appId) return;
		const index = previews.findIndex((item) => item.appId === appId);
		if (index < 0) return;
		const nextPreviews = previews.filter((item) => item.appId !== appId);
		previews = nextPreviews;
		options.surfaces.unregister({ appId, surface: "app" });
		detailSettled.delete(appId);
		if (activeAppId === appId) {
			activeAppId =
				nextPreviews[Math.max(0, index - 1)]?.appId ??
				nextPreviews[0]?.appId ??
				null;
		}
		if (nextPreviews.length === 0) options.onClosePanel?.();
		options.onAppClosed?.(appId);
	}

	function closeAll() {
		for (const item of [...previews]) closeApp(item.appId);
	}

	function retry(appId: string) {
		if (!previews.some((item) => item.appId === appId)) return;
		void loadDetail(appId, { force: true, remount: true });
	}

	function refreshIfOpen(appId: string) {
		if (!previews.some((item) => item.appId === appId)) return;
		void loadDetail(appId, { force: true, remount: true });
	}

	function setComposerChip(appId: string, chip: AppComposerChip | null) {
		if (!previews.some((item) => item.appId === appId)) return;
		patch(appId, { composerChip: chip });
	}

	function callSurface(input: {
		appId: string;
		method: string;
		input?: unknown;
		commandId: string;
	}) {
		return options.surfaces.call({
			key: { appId: input.appId, surface: "app" },
			method: input.method,
			input: input.input,
			commandId: input.commandId,
			// A call right after showing races the fetch and the iframe mount.
			settled: detailSettled.get(input.appId),
			getTarget: () =>
				previews.find((item) => item.appId === input.appId) ?? null,
		});
	}

	function dispose() {
		requests.clear();
		detailSettled.clear();
		loadTokens.clear();
	}

	return {
		get previews() {
			return previews;
		},
		get preview() {
			return previews.find((item) => item.appId === activeAppId) ?? null;
		},
		get activeAppId() {
			return activeAppId;
		},
		openApp,
		activateApp,
		closeApp,
		closeAll,
		retry,
		refreshIfOpen,
		setComposerChip,
		callSurface,
		dispose,
	};
}

export type AppPreviewController = ReturnType<
	typeof createAppPreviewController
>;
