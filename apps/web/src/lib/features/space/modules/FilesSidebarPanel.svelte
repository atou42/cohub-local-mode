<script lang="ts">
import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import FileUploadPane from "$lib/components/FileUploadPane.svelte";
import MobileRightDrawer from "$lib/components/MobileRightDrawer.svelte";
import SpaceFileSidebar from "$lib/components/SpaceFileSidebar.svelte";
import { createDeferredMount } from "$lib/deferred-mount.svelte";
import { pointerDrag } from "$lib/drag/pointer-drag.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { DURATION_PANEL } from "$lib/motion.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { SpaceFsNode } from "$lib/space-fs";
import type { SpaceUploadedFile } from "$lib/space-upload";
import { uiState } from "$lib/stores/ui.svelte";
import type { LocalUploadEntry } from "$lib/upload-entries";

type Props = {
	spaceId: string;
	nodes: SpaceFsNode[];
	selectedPath: string;
	loading: boolean;
	error: string | null;
	subtitle: string;
	activePort: string | null;
	canWrite: boolean;
	showItemActions: boolean;
	draggable: boolean;
	previewEndpoints: SpacePublicEndpoints;
	desktopCollapsed: boolean;
	desktopFloating: boolean;
	desktopWidth: number;
	rightDragOffsetPx: number;
	rightIsDragging: boolean;
	isDrawerVisible: boolean;
	uploadPaneVisible: boolean;
	uploadPaneTargetDir: string;
	pendingUploadFiles: File[];
	pendingUploadEntries: LocalUploadEntry[];
	onToggle: (node: SpaceFsNode) => void | Promise<void>;
	onSelect: (node: SpaceFsNode, options: { mobile: boolean }) => void;
	onRefresh: () => void | Promise<void>;
	onCreateFile: (parentPath: string) => void | Promise<void>;
	onCreateBoard: (parentPath: string) => void | Promise<void>;
	onCreateDir: (parentPath: string) => void | Promise<void>;
	onRename: (node: SpaceFsNode) => void | Promise<void>;
	onMove?: (node: SpaceFsNode, targetDir: string) => void | Promise<void>;
	onDelete: (node: SpaceFsNode) => void | Promise<void>;
	onDownload: (node: SpaceFsNode) => void | Promise<void>;
	onUpload: (files: File[] | LocalUploadEntry[], targetDir: string) => void;
	onInsertReference: (path: string) => void;
	onPublishDirectory: (path: string, options: { mobile: boolean }) => void;
	onOpenPort: (port: string, url: string, options: { mobile: boolean }) => void;
	onUploadPaneClose: () => void;
	onUploadComplete: (uploaded: SpaceUploadedFile[]) => void | Promise<void>;
	onResizeStart: (event: PointerEvent) => void;
};

let {
	spaceId,
	nodes,
	selectedPath,
	loading,
	error,
	subtitle,
	activePort,
	canWrite,
	showItemActions,
	draggable,
	previewEndpoints,
	desktopCollapsed,
	desktopFloating,
	desktopWidth,
	rightDragOffsetPx,
	rightIsDragging,
	isDrawerVisible,
	uploadPaneVisible,
	uploadPaneTargetDir,
	pendingUploadFiles,
	pendingUploadEntries,
	onToggle,
	onSelect,
	onRefresh,
	onCreateFile,
	onCreateBoard,
	onCreateDir,
	onRename,
	onMove = undefined,
	onDelete,
	onDownload,
	onUpload,
	onInsertReference,
	onPublishDirectory,
	onOpenPort,
	onUploadPaneClose,
	onUploadComplete,
	onResizeStart,
}: Props = $props();

const locale = $derived(getLocale());

/**
 * Keep the desktop tree mounted through the collapse width tween so the
 * clip animation has real content. Floating mode has no width tween — unmount ASAP.
 */
const treeMount = createDeferredMount(
	() => !desktopCollapsed,
	() => (desktopFloating ? 0 : DURATION_PANEL),
);
const desktopMounted = $derived(treeMount.mounted);

const desktopShellWidth = $derived(desktopCollapsed ? 0 : desktopWidth);

// Mirror the drag controller's retract signal onto the drawer. Kept here rather
// than inside the controller so the drawer stays the only owner of its own
// visibility, and desktop (no drawer) is unaffected.
$effect(() => {
	uiState.mobileRightDrawerRetracted = pointerDrag.retracted;
});

// A drop committed outside the retracted drawer (i.e. onto the board) means the
// user is done with the tree: close it so the new card is visible instead of
// snapping the drawer back over the result.
let handledCommit = $state(0);
$effect(() => {
	const version = pointerDrag.commitVersion;
	if (version === handledCommit) return;
	handledCommit = version;
	if (pointerDrag.committedOutsideSurface) {
		uiState.mobileRightDrawerOpen = false;
	}
});
</script>

<div
	class="panel-shell files-sidebar-shell hidden lg:flex border-l border-border-subtle"
	class:panel-shell--collapsed={desktopCollapsed}
	class:files-sidebar-shell--floating={desktopFloating}
	style={`width: ${desktopShellWidth}px; --files-sidebar-width: ${desktopWidth}px`}
	aria-hidden={desktopCollapsed}
	inert={desktopCollapsed ? true : undefined}
>
	{#if desktopMounted}
		<div class="panel-shell-inner relative" style={`width: ${desktopWidth}px`}>
			<div class="panel-shell-fade">
				<SpaceFileSidebar
					{nodes}
					{selectedPath}
					{loading}
					{error}
					{subtitle}
					onToggle={onToggle}
					onSelect={(node) => onSelect(node, { mobile: false })}
					onRefresh={onRefresh}
					onCreateFile={onCreateFile}
					onCreateBoard={onCreateBoard}
					onCreateDir={onCreateDir}
					onRename={onRename}
					onMove={onMove}
					onDelete={onDelete}
					onDownload={onDownload}
					onUpload={onUpload}
					onInsertReference={onInsertReference}
					onPublishDirectory={(path) =>
						onPublishDirectory(path, { mobile: false })}
					onOpenPort={(port, url) => onOpenPort(port, url, { mobile: false })}
					{activePort}
					{draggable}
					touchDraggable={draggable}
					{showItemActions}
					{canWrite}
					{previewEndpoints}
				/>
				<FileUploadPane
					{spaceId}
					targetDir={uploadPaneTargetDir}
					files={pendingUploadFiles}
					entries={pendingUploadEntries}
					open={uploadPaneVisible}
					onClose={onUploadPaneClose}
					onComplete={onUploadComplete}
				/>
			</div>
			{#if !desktopCollapsed}
				<button
					type="button"
					class="right-sidebar-resize-handle"
					aria-label={m.files_resize_sidebar({}, { locale })}
					title={m.files_resize_sidebar({}, { locale })}
					onpointerdown={onResizeStart}
				></button>
			{/if}
		</div>
	{/if}
</div>

<MobileRightDrawer
	dragOffsetPx={rightDragOffsetPx}
	isDragging={rightIsDragging}
	{isDrawerVisible}
>
	<!-- Retract surface: dragging a tree item out of here slides the drawer away
	     so the board behind it can receive the drop. -->
	<div class="h-full" data-pointer-drag-surface>
	<SpaceFileSidebar
		{nodes}
		{selectedPath}
		{loading}
		{error}
		{subtitle}
		onToggle={onToggle}
		onSelect={(node) => onSelect(node, { mobile: true })}
		onRefresh={onRefresh}
		onCreateFile={onCreateFile}
		onCreateBoard={onCreateBoard}
		onCreateDir={onCreateDir}
		onRename={onRename}
		onMove={onMove}
		onDelete={onDelete}
		onDownload={onDownload}
		onUpload={onUpload}
		onInsertReference={onInsertReference}
		onPublishDirectory={(path) => onPublishDirectory(path, { mobile: true })}
		onOpenPort={(port, url) => onOpenPort(port, url, { mobile: true })}
		{activePort}
		draggable={false}
		touchDraggable={draggable}
		showItemActions={false}
		{canWrite}
		{previewEndpoints}
	/>
	<FileUploadPane
		{spaceId}
		targetDir={uploadPaneTargetDir}
		files={pendingUploadFiles}
		entries={pendingUploadEntries}
		open={uploadPaneVisible}
		onClose={onUploadPaneClose}
		onComplete={onUploadComplete}
	/>
	</div>
</MobileRightDrawer>

<style>
	@media (min-width: 960px) {
		.files-sidebar-shell--floating {
			position: absolute;
			top: 10px;
			right: 10px;
			bottom: 10px;
			z-index: 30;
			width: var(--files-sidebar-width);
			overflow: hidden;
			border: 1px solid var(--border-subtle);
			border-radius: 10px;
			background: var(--bg-elevated);
			box-shadow: 0 10px 26px
				color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
			/* Floating mode is a free card, not a flex clip target. */
			transition: none;
			pointer-events: auto;
			opacity: 1;
		}

		.files-sidebar-shell--floating.panel-shell--collapsed {
			/* When immersive + tree collapsed, hide the floating card. */
			width: 0;
			pointer-events: none;
			opacity: 0;
		}
	}
</style>
