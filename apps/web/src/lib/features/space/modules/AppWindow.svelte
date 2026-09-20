<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import { ExternalLink, Loader2, RefreshCw } from "lucide-svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import type { AppSurfaceHost } from "$lib/features/app/surface-host";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { InlineAppPreview } from "./app-window-controller.svelte";
import PreviewHeader from "./PreviewHeader.svelte";
import type { PreviewChrome, PreviewHeaderAction } from "./preview-header";
import { previewHeaderVariant } from "./preview-header";
import type { Window } from "./windows";

type Props = {
	preview: InlineAppPreview;
	shell: AppRuntimeShellContext;
	windows: Window[];
	chrome: PreviewChrome;
	isMobile: boolean;
	/** Whether this App is the visible tab. Background tabs mount no chrome. */
	active?: boolean;
	onActivateWindow: (kind: Window["kind"], key: string) => void;
	onCloseWindow: (kind: Window["kind"], key: string) => void;
	onRetry: (appId: string) => void;
	onRegisterSurface: (appId: string, host: AppSurfaceHost | null) => void;
	onComposerChip: (appId: string, chip: AppComposerChip | null) => void;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
};

const {
	preview,
	shell,
	windows,
	chrome,
	isMobile,
	active = true,
	onActivateWindow,
	onCloseWindow,
	onRetry,
	onRegisterSurface,
	onComposerChip,
	onNavigationOpen = undefined,
}: Props = $props();

const locale = $derived(getLocale());

const detail = $derived(preview.detail);
const publicUrl = $derived(detail?.publicUrl ?? null);
const immersive = $derived(chrome.immersive);

/**
 * The app id of the surface that last registered.
 *
 * The surface reports `null` from its unmount cleanup, and that cleanup runs
 * while this panel is itself being destroyed: closing the last app tab clears
 * `preview` in the same update. Reading the prop there faults on a gone preview
 * and aborts the teardown half-done, which is what left the next open with a
 * blank stage. Keep the id in a plain local so unregistering never reaches back
 * into reactive state. It is deliberately not cleared on unregister — a remount
 * may mount the replacement before the outgoing surface reports, and the id is
 * the same app either way.
 */
let surfaceAppId: string | null = null;

function handleSurfaceHost(host: AppSurfaceHost | null) {
	if (host) surfaceAppId = preview.appId;
	if (surfaceAppId) onRegisterSurface(surfaceAppId, host);
}

function handleComposerChip(chip: AppComposerChip | null) {
	if (surfaceAppId) onComposerChip(surfaceAppId, chip);
}
const launchState = $derived({
	search: preview.launch?.search ?? "",
	hash: preview.launch?.hash ?? "",
});
const isDisabled = $derived(detail?.app.status === "disabled");

const headerActions = $derived.by((): PreviewHeaderAction[] => {
	const actions: PreviewHeaderAction[] = [
		{
			id: "reload",
			label: m.window_reload_app({}, { locale }),
			icon: RefreshCw,
			primary: true,
			run: () => onRetry(preview.appId),
		},
	];
	if (publicUrl) {
		actions.push({
			id: "open-external",
			label: m.window_open_in_new_tab({}, { locale }),
			icon: ExternalLink,
			primary: true,
			run: () => {
				window.open(publicUrl, "_blank", "noopener");
			},
		});
	}
	return actions;
});
</script>

<div class="flex h-full min-w-0 flex-col bg-bg-content">
	{#if active}
		<PreviewHeader
			{windows}
			variant={previewHeaderVariant({ isMobile, immersive })}
			actions={headerActions}
			{chrome}
			onActivate={onActivateWindow}
			onClose={onCloseWindow}
		/>
	{/if}

	<div class="relative min-h-0 flex-1" data-drawer-swipe-ignore>
		{#if preview.error}
			<div class="flex h-full items-center justify-center p-6">
				<div class="max-w-sm text-center">
					<div class="mb-1 text-sm font-medium text-text-primary">{m.app_unavailable({}, { locale })}</div>
					<div class="mb-4 text-xs leading-5 text-text-tertiary">{preview.error}</div>
					<button
						type="button"
						class="inline-flex min-h-8 items-center rounded-[5px] bg-bg-elevated px-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
						onclick={() => onRetry(preview.appId)}
					>
						{m.app_try_again({}, { locale })}
					</button>
				</div>
			</div>
		{:else if !detail}
			<CenteredLoading label={m.app_loading({}, { locale })} size="panel" />
		{:else if !detail.content}
			<div class="flex h-full items-center justify-center p-6 text-center text-xs leading-5 text-text-tertiary">
				{isDisabled
					? m.app_disabled_no_content({}, { locale })
					: m.app_no_content({}, { locale })}
			</div>
		{:else}
			{#key preview.mountKey}
				<AppSurface
					mode="app"
					app={detail.app}
					space={detail.space}
					owner={detail.owner}
					content={detail.content}
					{launchState}
					invocation={preview.invocation}
					{shell}
					onSurfaceHost={handleSurfaceHost}
					onComposerChip={handleComposerChip}
					onNavigationOpen={onNavigationOpen}
					onCloseRequest={() => onCloseWindow("app", preview.appId)}
				/>
			{/key}
		{/if}
		{#if preview.loading && detail}
			<div class="pointer-events-none absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-content/95 px-2 py-1 text-[11px] text-text-tertiary">
				<Loader2 class="h-3 w-3 animate-spin" />
				<span>{m.app_refreshing({}, { locale })}</span>
			</div>
		{/if}
		{#if preview.refreshError && detail}
			<div class="absolute bottom-2 left-2 right-2 z-10 flex items-center gap-2 rounded-md border border-error-soft/30 bg-bg-content/95 px-2.5 py-1.5 text-[11px] text-error-soft shadow-sm">
				<span class="min-w-0 flex-1 truncate">{preview.refreshError}</span>
				<button
					type="button"
					class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary"
					onclick={() => onRetry(preview.appId)}
				>
					Retry
				</button>
			</div>
		{/if}
	</div>
</div>
