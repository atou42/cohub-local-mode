<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import {
	type BoardCommitHandler,
	type BoardRuntimeData,
	type BoardRuntimeViewState,
	resolveBoardRuntime,
} from "$lib/board/runtime/board-runtime";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import PreviewHeader from "./PreviewHeader.svelte";
import type { PreviewChrome } from "./preview-header";
import { previewHeaderVariant } from "./preview-header";
import type { Window } from "./windows";

type InlineBoardPanelState = {
	path: string;
	boardId: string | null;
	document: BoardDocument | null;
	runtime: BoardRuntimeData | null;
	loading: boolean;
	saving: boolean;
	error: string | null;
	saveError: string | null;
};

type Props = {
	board: InlineBoardPanelState;
	windows: Window[];
	spaceId: string;
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
	active?: boolean;
	chrome: PreviewChrome;
	isMobile: boolean;
	collaborators?: Map<string, BoardCollaboratorProfile>;
	activities?: BoardAutomationActivity[];
	onOpenActivity?: (activity: BoardAutomationActivity) => void | Promise<void>;
	onCommit: (
		boardId: string,
		path: string,
		document: Parameters<BoardCommitHandler>[0],
		before: Parameters<BoardCommitHandler>[1],
		commands: Parameters<BoardCommitHandler>[2],
	) => void | Promise<void>;
	onRetrySave: (boardId: string) => void | Promise<void>;
	onActivateWindow: (kind: Window["kind"], key: string) => void;
	onCloseWindow: (kind: Window["kind"], key: string) => void;
	onViewStateChange?: (state: BoardRuntimeViewState) => void;
	/** Open a workspace file in the window panel (file cards route here). */
	onOpenFile?: (path: string) => void | Promise<void>;
	/** Open a task detail view (task cards route here). */
	onOpenTask?: (taskRunId: string) => void | Promise<void>;
};

let {
	board,
	windows,
	spaceId,
	shell,
	onNavigationOpen,
	active = true,
	chrome,
	isMobile,
	collaborators = new Map(),
	activities = [],
	onOpenActivity,
	onCommit,
	onRetrySave,
	onActivateWindow,
	onCloseWindow,
	onViewStateChange,
	onOpenFile,
	onOpenTask,
}: Props = $props();

const locale = $derived(getLocale());
const immersive = $derived(chrome.immersive);

let boardRuntimeLoadAttempt = $state(0);
const boardRuntimeModulePromise = $derived.by(() => {
	boardRuntimeLoadAttempt;
	if (!board.document) throw new Error("Board data is unavailable.");
	return resolveBoardRuntime(board.document).load();
});
</script>

{#snippet Header()}
	<PreviewHeader
		{windows}
		variant={previewHeaderVariant({ isMobile, immersive })}
		actions={[]}
		{chrome}
		onActivate={onActivateWindow}
		onClose={onCloseWindow}
	/>
{/snippet}

<div class="flex h-full min-w-0 flex-col bg-bg-primary">
	{@render Header()}
	{#if board.loading}
		<div class="flex flex-1 items-center justify-center text-xs text-text-tertiary">{m.common_loading({}, { locale })}</div>
	{:else if board.error}
		<div class="m-4 rounded-lg border border-error-soft/30 bg-error-bg p-4 text-sm text-error-soft">{board.error}</div>
	{:else if board.boardId && board.document && board.runtime}
		{#await boardRuntimeModulePromise}
			<div class="flex flex-1 items-center justify-center text-xs text-text-tertiary">{m.common_loading({}, { locale })}</div>
		{:then boardRuntimeModule}
			{@const BoardRuntime = boardRuntimeModule.default}
			<div class="min-h-0 flex-1">
				{#key board.boardId}
					<BoardRuntime
						path={board.path}
						boardId={board.boardId}
						document={board.document}
						runtime={board.runtime}
						spaceId={spaceId}
						shell={shell}
						onNavigationOpen={onNavigationOpen}
						{active}
						{immersive}
						{isMobile}
						{collaborators}
						{activities}
						{onOpenActivity}
						syncError={board.saveError}
						onCommit={(document, before, commands) => onCommit(board.boardId as string, board.path, document, before, commands)}
						onRetrySync={() => onRetrySave(board.boardId as string)}
						{onViewStateChange}
						{onOpenFile}
						{onOpenTask}
					/>
				{/key}
			</div>
		{:catch}
			<div class="m-4 flex flex-col items-start gap-2 rounded-lg border border-error-soft/30 bg-error-bg p-4 text-sm text-error-soft">
				<span>{m.board_failed_load({}, { locale })}</span>
				<button type="button" class="action-btn" onclick={() => { boardRuntimeLoadAttempt += 1; }}>{m.common_retry({}, { locale })}</button>
			</div>
		{/await}
	{:else}
		<div class="m-4 rounded-lg border border-error-soft/30 bg-error-bg p-4 text-sm text-error-soft">{m.board_data_unavailable({}, { locale })}</div>
	{/if}
</div>
