<script lang="ts">
import { GanttChart, LocateFixed, Minus, Plus } from "lucide-svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	immersive = false,
	timelineOpen = false,
	onToggleTimeline,
}: {
	editor: BoardEditor;
	immersive?: boolean;
	timelineOpen?: boolean;
	onToggleTimeline?: () => void;
} = $props();

const locale = $derived(getLocale());

const zoomPercent = $derived(Math.round(editor.camera.zoom * 100));
const hasFocusableSelection = $derived(editor.hasFocusableSelection);
const focusLabel = $derived(
	hasFocusableSelection
		? m.board_zoom_selection({}, { locale })
		: m.board_zoom_fit({}, { locale }),
);

function focusContent() {
	if (hasFocusableSelection) editor.focusSelection({ padding: 48 });
	else editor.fitView();
}
</script>

<div class="board-zoom-menu toolbar-surface" class:board-zoom-menu--immersive={immersive}>
	{#if onToggleTimeline}
		<button type="button" class="tool-key" title={m.board_timeline({}, { locale })} aria-label={m.board_timeline({}, { locale })} aria-expanded={timelineOpen} onclick={onToggleTimeline}>
			<GanttChart class="h-3.5 w-3.5" />
		</button>
		<div class="toolbar-divider"></div>
	{/if}
	<button type="button" class="tool-key" title={m.board_zoom_out({}, { locale })} aria-label={m.board_zoom_out({}, { locale })} onclick={() => editor.zoomOut()}>
		<Minus class="h-3.5 w-3.5" />
	</button>
	<button
		type="button"
		class="tool-key zoom-value"
		title="Reset to 100%"
		aria-label="Reset zoom to 100%"
		onclick={() => editor.resetZoom()}
	>
		{zoomPercent}%
	</button>
	<button type="button" class="tool-key" title={m.board_zoom_in({}, { locale })} aria-label={m.board_zoom_in({}, { locale })} onclick={() => editor.zoomIn()}>
		<Plus class="h-3.5 w-3.5" />
	</button>
	<div class="toolbar-divider"></div>
	<button type="button" class="tool-key" title={focusLabel} aria-label={focusLabel} onclick={focusContent}>
		<LocateFixed class="h-3.5 w-3.5" />
	</button>
</div>

<style>
	.board-zoom-menu {
		position: absolute;
		right: 14px;
		bottom: 14px;
		z-index: 25;
	}

	.board-zoom-menu--immersive {
		right: var(--preview-safe-right, 10px);
	}

	.zoom-value {
		min-width: 44px;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	@media (pointer: coarse) {
		.board-zoom-menu {
			--tool-key-size: 34px;
			top: calc(12px + var(--safe-area-top));
			right: 10px;
			bottom: auto;
			padding: 5px;
		}
		.zoom-value { min-width: 48px; font-size: 12px; }
	}

	@media (pointer: coarse) and (max-width: 480px) {
		.board-zoom-menu {
			max-width: calc(100vw - 20px);
		}
	}
</style>
