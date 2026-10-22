<script lang="ts">
import {
	type BoardSceneItem,
	layoutBoardText,
	layoutShapeLabel,
	resolveSceneArrow,
	SHAPE_LABEL_PADDING,
} from "@neta-art/cohub/board";
import { boardTextStyle } from "@neta-art/cohub/board/render";
import { tick, untrack } from "svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { editor }: { editor: BoardEditor } = $props();

const locale = $derived(getLocale());

let textarea: HTMLTextAreaElement | null = $state(null);
let draft = $state("");

type TextProps = { fontSize: number; fontWeight: number; font: string; lineHeight: number; width?: number; align?: "left" | "center" | "right" };

function editableText(item: BoardSceneItem): string | null {
	const props = item.props as { text?: string; label?: string };
	if (item.type === "text" || item.type === "shape") return props.text ?? "";
	if (item.type === "arrow" || item.type === "frame") return props.label ?? "";
	return null;
}

const editingItem = $derived.by(() => {
	const id = editor.editingId;
	const item = id ? editor.itemById(id) : null;
	return item && editableText(item) !== null ? item : null;
});

const layout = $derived.by(() => {
	const item = editingItem;
	if (!item) return null;
	const { x, y, zoom } = editor.camera;
	const rotation = item.frame.rotation || 0;
	const props = item.props as TextProps;
	if (item.type === "frame" || item.type === "arrow") {
		const fontSize = 14;
		const height = 20;
		const width = Math.max(fontSize * 4, (editableText(item)?.length ?? 0) * fontSize * 0.62 + 16);
		const anchor = item.type === "frame"
			? { x: item.frame.x + 2, y: item.frame.y - 10 }
			: resolveSceneArrow(item, editor.scene).mid;
		return {
			left: anchor.x * zoom + x - width / 2,
			top: anchor.y * zoom + y - height / 2,
			width,
			height,
			padding: "0",
			scale: 1,
			rotation,
			fontFamily: null,
			fontSize: fontSize * zoom,
			fontWeight: "500",
			lineHeight: height * zoom,
			textAlign: "center",
			whiteSpace: "pre-wrap",
			plain: false,
		};
	}
	const center = {
		x: (item.frame.x + item.frame.width / 2) * zoom + x,
		y: (item.frame.y + item.frame.height / 2) * zoom + y,
	};
	const place = (width: number, height: number, scale: number, inset: { x: number; y: number }) => ({
		left: center.x - width / 2 - inset.x,
		top: center.y - height / 2 - inset.y,
		width,
		height,
		padding: `${inset.y}px ${inset.x}px`,
		scale,
		rotation,
	});
	if (item.type === "text") {
		const text = layoutBoardText({ ...props, text: draft });
		const scale = (zoom * item.frame.width) / text.width;
		return {
			...place(text.width, text.height, scale, { x: 1 / scale, y: 0 }),
			...boardTextStyle(props),
			lineHeight: text.lineHeight,
			textAlign: props.align ?? "left",
			whiteSpace: props.width ? "pre-wrap" : "pre",
			plain: true,
		};
	}
	const { width, height } = item.frame;
	const label = layoutShapeLabel({ text: draft, fontSize: props.fontSize }, width);
	return {
		...place(width - SHAPE_LABEL_PADDING * 2, Math.min(height, label.height), zoom, {
			x: SHAPE_LABEL_PADDING,
			y: Math.max(0, (height - label.height) / 2),
		}),
		...boardTextStyle({ font: "sans", fontSize: props.fontSize, fontWeight: 500 }),
		lineHeight: label.lineHeight,
		textAlign: props.align ?? "center",
		whiteSpace: "pre-wrap",
		plain: false,
	};
});

$effect(() => {
	const id = editor.editingId;
	if (!id) return;
	const item = untrack(() => editor.itemById(id));
	const text = item ? editableText(item) : null;
	if (text === null) return;
	draft = text;
	void tick().then(() => {
		if (editor.editingId !== id) return;
		textarea?.focus({ preventScroll: true });
		textarea?.select();
	});
});

function commit() {
	const item = editingItem;
	if (!item) return;
	editor.commitTextEdit(item.id, draft);
}

function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
	const item = editingItem;
	if (item?.type !== "text") return;
	editor.previewTextLayout(item.id, event.currentTarget.value);
}

function handleKeydown(event: KeyboardEvent) {
	event.stopPropagation();
	if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
		event.preventDefault();
		commit();
	}
}
</script>

{#if editingItem && layout}
	<textarea
		bind:this={textarea}
		bind:value={draft}
		class="board-text-editor"
		style:left="{layout.left}px"
		style:top="{layout.top}px"
		style:width="{layout.width}px"
		style:height="{layout.height}px"
		style:transform="rotate({layout.rotation}deg) scale({layout.scale})"
		style:--board-text-editor-scale={layout.scale}
		style:font-family={layout.fontFamily}
		style:font-size="{layout.fontSize}px"
		style:font-weight={layout.fontWeight}
		style:line-height="{layout.lineHeight}px"
		style:text-align={layout.textAlign}
		style:padding={layout.padding}
		style:white-space={layout.whiteSpace}
		class:board-text-editor--plain={layout.plain}
		oninput={handleInput}
		onblur={commit}
		onkeydown={handleKeydown}
		aria-label={m.board_edit_text({}, { locale })}
	></textarea>
{/if}

<style>
	.board-text-editor {
		--board-text-editor-scale: 1;
		position: absolute;
		z-index: 30;
		box-sizing: content-box;
		margin: 0;
		transform-origin: center center;
		resize: none;
		overflow: hidden;
		border: 0;
		border-radius: calc(10px / var(--board-text-editor-scale));
		outline: calc(1px / var(--board-text-editor-scale)) solid var(--brand-border);
		background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
		color: var(--text-primary);
		font-family: var(--font-sans);
		box-shadow: 0 0 0 calc(2px / var(--board-text-editor-scale)) color-mix(in srgb, var(--brand) 18%, transparent);
		overflow-wrap: break-word;
		word-break: normal;
		letter-spacing: 0;
		word-spacing: 0;
		font-kerning: auto;
		font-feature-settings: normal;
		font-variant: normal;
		text-rendering: auto;
		tab-size: 1;
	}

	.board-text-editor--plain {
		border-radius: 0;
		outline: none;
		background: transparent;
		box-shadow: none;
		caret-color: var(--brand);
	}
</style>
