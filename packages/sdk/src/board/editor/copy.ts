import {
	applyMatrix,
	arrowBindings,
	type BoardArrowItem,
	type BoardScene,
	type BoardItem,
	createBoardItemId,
	invertMatrix,
	resolveSceneArrow,
	type SceneItem,
	type WorldPoint,
} from "../model/index.js";
import {
	type BoardClipboardPayload,
	DUPLICATE_OFFSET,
	defaultPasteOffset,
	encodeClipboard,
	materializeClipboard,
	parseClipboard,
	remapItems,
} from "./clipboard.js";
import type { EditorContext } from "./context.js";

export function createCopyModule(ctx: EditorContext) {
	const { state, options } = ctx;
	let internalClipboard: BoardClipboardPayload | null = null;
	let pasteCount = 0;

	function detachedSubtrees(ids: Iterable<string>, scene: BoardScene): Record<string, BoardItem> {
		const items: Record<string, BoardItem> = {};
		for (const root of ctx.query.rootsOf(ids)) {
			const item = scene.get(root);
			if (!item || !state.base.items[root]) continue;
			const { id: _id, frame, ...stored } = item;
			items[root] = ctx.document.reparent(stored as BoardItem, frame, undefined, scene.layout.box(root));
			for (const child of scene.descendants(root)) {
				if (!state.base.items[child]) continue;
				const shown = scene.get(child);
				if (shown) {
					const { id: _id, frame: _frame, ...value } = shown;
					items[child] = value as BoardItem;
				}
			}
		}
		return items;
	}

	function arrowEndPoint(scene: BoardScene, id: string, which: "start" | "end") {
		const arrow = scene.get(id) as SceneItem<BoardArrowItem> | undefined;
		if (arrow?.type !== "arrow") return null;
		const resolved = resolveSceneArrow(arrow, scene);
		return applyMatrix(
			invertMatrix(scene.layout.matrix(id)),
			(which === "start" ? resolved.start : resolved.end).point,
		);
	}

	function duplicates(ids: string[], offset: number): Map<string, BoardItem> {
		const scene = ctx.document.copyScene();
		const copied = detachedSubtrees(ids, scene);
		for (const id of Object.keys(copied)) {
			for (const arrowId of scene.binders(id)) {
				if (!state.base.items[arrowId]) continue;
				const shown = scene.get(arrowId);
				if (copied[arrowId] || !shown || !arrowBindings(shown).every((bound) => copied[bound])) continue;
				const { id: _id, frame, ...arrow } = shown;
				copied[arrowId] = ctx.document.reparent(arrow as BoardItem, frame, undefined, scene.layout.box(arrowId));
			}
		}
		const idMap = new Map(Object.keys(copied).map((id) => [id, createBoardItemId()]));
		const moved = remapItems(
			copied,
			idMap,
			(item) =>
				item.parent && copied[item.parent]
					? item
					: { ...item, position: { x: item.position.x + offset, y: item.position.y + offset } },
			(id, which) => arrowEndPoint(scene, id, which),
		);
		let z = ctx.document.topZ(undefined, scene);
		return new Map(Object.entries(moved).map(([id, item]) => [id, item.parent ? item : { ...item, z: z++ }]));
	}

	function rootsOfCopies(copies: ReadonlyMap<string, BoardItem>): string[] {
		return [...copies].filter(([, item]) => !item.parent || !copies.has(item.parent)).map(([id]) => id);
	}

	function duplicateSelection() {
		if (options.readonly || state.selection.length === 0) return;
		const copies = duplicates(state.selection, DUPLICATE_OFFSET);
		if (copies.size === 0) return;
		const roots = rootsOfCopies(copies);
		ctx.document.markAdded(roots);
		state.selection = roots;
		ctx.document.commitItems(copies);
	}

	function copySelection(): BoardClipboardPayload | null {
		const { selection } = state;
		if (selection.length === 0) return null;
		const scene = ctx.document.copyScene();
		const copied = detachedSubtrees(selection, scene);
		const origin = ctx.query.contentBounds(ctx.query.rootsOf(selection), scene);
		const payload = origin ? encodeClipboard(copied, { x: origin.x, y: origin.y }) : null;
		if (payload) {
			internalClipboard = payload;
			pasteCount = 0;
		}
		return payload;
	}

	function cutSelection(): BoardClipboardPayload | null {
		const payload = copySelection();
		if (payload) ctx.deletion.deleteSelection();
		return payload;
	}

	function pasteClipboard(raw?: unknown, at?: WorldPoint) {
		if (options.readonly) return;
		const parsed = parseClipboard(raw) ?? (raw == null ? parseClipboard(internalClipboard) : null);
		if (!parsed) return;
		pasteCount += 1;
		const offset = at ?? {
			x: parsed.origin.x + defaultPasteOffset(pasteCount).x,
			y: parsed.origin.y + defaultPasteOffset(pasteCount).y,
		};
		const pasted = materializeClipboard(parsed, offset);
		const entries = Object.entries(pasted).map(([id, item]) => ({ id, item }));
		const roots = entries.filter(({ item }) => !item.parent).map(({ id }) => id);
		const changes = ctx.creation.placeNew(entries);
		ctx.document.markAdded(roots);
		state.selection = roots;
		ctx.document.commitItems(changes);
	}

	return { duplicates, rootsOfCopies, duplicateSelection, copySelection, cutSelection, pasteClipboard };
}

export type CopyModule = ReturnType<typeof createCopyModule>;
