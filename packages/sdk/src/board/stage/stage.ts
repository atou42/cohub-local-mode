import type { BoardPlaybackSnapshot, BoardPatch } from "@cohub/protocol";
import { applyMatrix, invertMatrix, boardScriptScope, composeBoardScriptItems, prepareBoardScriptOutput, boardScriptTarget, validateBoardScriptCommit, type BoardScriptEvent, type BoardScriptOutput, type BoardScriptSnapshot } from "../model/index.js";
import { Application, Container, Graphics, type Renderer, RendererType } from "pixi.js";
import type { BoardEditor, BoardPointerEvent } from "../editor/index.js";
import { isCreationBoardTool, resizeCursorForHandle } from "../editor/index.js";
import {
	type BoardArrowItem,
	type BoardAssetSource,
	type BoardItem,
	type BoardScene,
	type BoardSceneItem,
	type BoardShapeColors,
	type BoardViewport,
	buildFallbackShapeColors,
	createBoardAnimationSampler,
	resolveBoardAnimationCamera,
	featuredTaskArtifact,
	pickBoardColor,
	type Rect,
	resolveItemColor,
	resolveSceneArrow,
	type SceneItem,
	type ScreenPoint,
	screenPoint,
	screenToWorld,
	stableCullRect,
	visibleWorldRect,
	type WorldPoint,
	worldPoint,
} from "../model/index.js";
import { type BoardPlayerFrame, createBoardPlayer } from "../player/index.js";
import {
	type BoardCardRendererResolver,
	type BoardRenderContext,
	type BoardRenderPalette,
	type BrowserBoardScriptHost,
	createBoardBackground,
	createBoardScriptHost,
	defaultBoardPalette,
	getBoardCardRenderer,
	itemAlpha,
	getBoardResolution,
	parseBoardCssColor,
	textZoomBucket,
	updateBoardBackground,
} from "../render/index.js";
import type { BoardAssetManager } from "./assets.js";
import { scheduleBoardMaintenance } from "./maintenance.js";
import { toBoardPointerEvent } from "./pointer.js";
import { createBoardScriptPointerRouter } from "./script-pointer.js";
import { type BoardLiveStroke, createBoardScene } from "./scene.js";
import { type BoardItemView, createBoardItemViewLayer } from "./views.js";

export type BoardStageTheme = {
	key: string;
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	colorScheme: "dark" | "light";
	imageBackground?: boolean;
};

export type BoardStagePointerPhase = "down" | "move" | "up" | "leave";

export type BoardStageOptions = {
	editor: BoardEditor;
	assets: BoardAssetManager;
	source: BoardAssetSource;
	renderers?: BoardCardRendererResolver;
	views?: readonly BoardItemView[];
	theme?: () => BoardStageTheme;
	playback?: () => BoardPlaybackSnapshot | null;
	fileState?: (path: string) => "ok" | "missing" | "unavailable";
	previews?: () => ReadonlyMap<string, BoardItem>;
	strokes?: () => readonly BoardLiveStroke[];
	drawOverlay?: (overlay: Graphics, frame: { zoom: number; theme: BoardStageTheme; scene: BoardScene }) => void;
	onPointer?: (phase: BoardStagePointerPhase, event: PointerEvent, input: BoardPointerEvent) => boolean | undefined;
	onDoubleClick?: (item: BoardSceneItem | null, point: WorldPoint) => boolean | undefined;
	onSurfaceChange?: (size: { width: number; height: number }) => void;
	onVisibleChange?: (ids: ReadonlySet<string> | null) => void;
	scriptCapabilities?: Record<string, (id: string, input: unknown) => Promise<unknown>>;
};

export type BoardStage = {
	readonly ready: Promise<boolean>;
	readonly renderer: Renderer | null;
	readonly camera: BoardViewport;
	readonly theme: BoardStageTheme;
	setActive(active: boolean): void;
	setScriptMode(mode: "edit" | "interact" | "paused"): void;
	resetScripts(): void;
	invalidateScript(path: string): void;
	scriptError(id: string): string | null;
	scriptOutput(id: string): BoardScriptOutput | null;
	snapshotScripts(): Promise<Record<string, BoardScriptSnapshot>>;
	restoreScript(id: string, snapshot: BoardScriptSnapshot): void;
	subscribeScripts(listener: () => void): () => void;
	invalidate(options?: { cards?: boolean }): void;
	isMaterialized(id: string): boolean;
	toWorld(clientX: number, clientY: number): WorldPoint;
	destroy(): void;
};

const LIVE_CHANNELS = ["document", "scene", "selection", "camera", "tool", "interaction", "hover", "editing", "playback"] as const;

function defaultTheme(): BoardStageTheme {
	return {
		key: "dark",
		palette: defaultBoardPalette("dark"),
		colors: buildFallbackShapeColors("dark"),
		colorScheme: "dark",
	};
}

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5' fill='none' stroke='%23fff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5' fill='none' stroke='%231d1d1f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 12 12, crosshair`;

export function mountBoardStage(host: HTMLElement, options: BoardStageOptions): BoardStage {
	const { editor, assets } = options;
	const theme = options.theme ?? defaultTheme;
	const resolveRenderer = options.renderers ?? getBoardCardRenderer;
	let app: Application | null = null;
	let world: Container | null = null;
	let overlay: Graphics | null = null;
	let background: Container | null = null;
	let scene: ReturnType<typeof createBoardScene> | null = null;
	let scripts: BrowserBoardScriptHost | null = null;
	let scriptMode: "edit" | "interact" | "paused" = editor.readonly ? "interact" : "edit";
	let scriptTime = 0;
	let scriptLastTick = performance.now();
	const scriptOutputs = new Map<string, BoardScriptOutput>();
	const scriptListeners = new Set<() => void>();
	let scriptVersion = 0;
	let composedVersion = -1;
	let composedZoom = 0;
	let composedPlayhead = "";
	let composedMoving = false;
	let composedDocument: BoardEditor["document"] | null = null;
	let scriptHover: { owner: string; target: string } | null = null;
	const scriptPointers = createBoardScriptPointerRouter();
	let stopMaintenance: (() => void) | null = null;
	let active = true;
	let disposed = false;
	let renderFrame = 0;
	let tickFrame = 0;
	let resizeFrame = 0;
	let cardEpoch = 0;
	let assetVersion = 0;
	let surface = { width: 0, height: 0 };
	let playbackCamera: BoardViewport | null = null;
	let cursor = "";
	const renderCamera = () => playbackCamera ?? editor.camera;
	const views = createBoardItemViewLayer(host, editor, options.views ?? [], renderCamera);

	const player = createBoardPlayer({
		resolveColor: (color) => {
			const current = theme();
			return { color: resolveItemColor(color, "brand", current.colors, current.colorScheme, parseBoardCssColor), alpha: itemAlpha(current, color) };
		},
	});

	let cull: { rect: Rect | null; ids: Set<string> | null; scene: BoardScene | null } = { rect: null, ids: null, scene: null };
	function visibleIds(): Set<string> | null {
		if (surface.width === 0 || surface.height === 0) return null;
		const rect = stableCullRect(visibleWorldRect(renderCamera(), surface.width, surface.height));
		const same =
			cull.rect &&
			cull.rect.x === rect.x &&
			cull.rect.y === rect.y &&
			cull.rect.width === rect.width &&
			cull.rect.height === rect.height;
		if (same && cull.scene === editor.scene) return cull.ids;
		cull = { rect: same ? cull.rect : rect, ids: new Set(editor.idsInRect(rect, true)), scene: editor.scene };
		options.onVisibleChange?.(cull.ids);
		requestAssets = true;
		return cull.ids;
	}

	let requestAssets = true;
	function syncAssets(ids: Set<string> | null) {
		if (!requestAssets || !ids) return;
		requestAssets = false;
		const sizes: Array<{ id: string; width: number; height: number }> = [];
		for (const id of ids) {
			const item = editor.itemById(id);
			if (!item) continue;
			const key = assets.assetKey(item);
			if (!key) continue;
			assets.requestItem(item);
			const artifact = item.type === "task" ? featuredTaskArtifact(item.props.snapshot.artifacts) : null;
			const recorded =
				artifact?.type === "image" || artifact?.type === "video"
					? artifact
					: item.type === "image" || item.type === "video"
						? item.props.snapshot
						: null;
			if (!recorded || (recorded.naturalWidth && recorded.naturalHeight)) continue;
			const natural = assets.getNaturalSize(key);
			if (natural?.width && natural.height) sizes.push({ id: item.id, ...natural });
		}
		if (sizes.length > 0) editor.adoptMediaNaturalSizes(sizes);
	}

	function renderContext(current: BoardStageTheme, renderScene: BoardScene, time: number): BoardRenderContext {
		const interaction = editor.interaction;
		return {
			settings: editor.settings,
			scene: renderScene,
			time,
			...(scripts ? { scripts } : {}),
			selectedIds: new Set(editor.selection),
			hoveredId: editor.hoverId,
			resizingIds: interaction.type === "resizing" ? new Set(interaction.origin.keys()) : new Set<string>(),
			palette: current.palette,
			colors: current.colors,
			colorScheme: current.colorScheme,
			rendererType: app?.renderer.type === RendererType.CANVAS ? "canvas" : "gpu",
			zoom: renderCamera().zoom,
			assetKey: assets.assetKey,
			getTexture: (key) => assets.getTexture(key),
			hasError: (key) => assets.hasError(key),
			fileState: (path) => options.fileState?.(path) ?? "ok",
			acquireTexture: (key) => assets.acquire(key),
			releaseTexture: (key) => assets.release(key),
		};
	}

	function syncBackground(current: BoardStageTheme) {
		if (!app) return;
		const context = {
			app,
			settings: editor.settings,
			viewport: editor.camera,
			colorScheme: current.colorScheme,
			palette: current.palette,
			hasImageBackground: current.imageBackground === true,
		};
		if (background) updateBoardBackground(background, context);
		else {
			background = createBoardBackground(context);
			app.stage.addChildAt(background, 0);
		}
	}

	function localGestureItemIds(): Set<string> {
		const interaction = editor.interaction;
		switch (interaction.type) {
			case "translating":
			case "resizing":
			case "rotating":
				return new Set(interaction.origin.keys());
			case "draggingArrowHandle":
				return new Set([interaction.arrowId]);
			default:
				return new Set();
		}
	}

	function previewItems(): Map<string, BoardItem> {
		const previews = new Map<string, BoardItem>();
		const remote = options.previews?.();
		if (!remote?.size) return previews;
		const local = localGestureItemIds();
		for (const [id, item] of remote) if (!local.has(id)) previews.set(id, item);
		return previews;
	}

	function liveStrokes(): BoardLiveStroke[] {
		const strokes = [...(options.strokes?.() ?? [])];
		const interaction = editor.interaction;
		if (interaction.type === "drawing")
			strokes.push({ id: interaction.id, points: interaction.points, color: interaction.color, size: interaction.size });
		return strokes;
	}

	function followCamera(frame: BoardPlayerFrame, renderScene: BoardScene): BoardViewport {
		return resolveBoardAnimationCamera(frame.camera, (id) => renderScene.get(id)?.frame, surface, frame.time, editor.camera);
	}

	let effectSampler: ReturnType<typeof createBoardAnimationSampler> | undefined;
	let effectDocument: BoardEditor["document"] | undefined;
	let effectAnimation: string | null = null;

	function arrowHead(target: Graphics, from: WorldPoint, to: WorldPoint, color: number, width: number, inv: number, alpha: number) {
		const angle = Math.atan2(to.y - from.y, to.x - from.x);
		const head = Math.max(14, 16 * inv);
		const spread = Math.PI / 6;
		target
			.moveTo(to.x - head * Math.cos(angle - spread), to.y - head * Math.sin(angle - spread))
			.lineTo(to.x, to.y)
			.lineTo(to.x - head * Math.cos(angle + spread), to.y - head * Math.sin(angle + spread))
			.stroke({ color, width, alpha, cap: "round", join: "round" });
	}

	function drawTransient(target: Graphics, current: BoardStageTheme) {
		const inv = 1 / Math.max(editor.camera.zoom, 0.0001);
		const interaction = editor.interaction;
		for (const guide of editor.snapGuides) {
			const vertical = guide.axis === "x";
			target
				.moveTo(vertical ? guide.at : guide.from, vertical ? guide.from : guide.at)
				.lineTo(vertical ? guide.at : guide.to, vertical ? guide.to : guide.at)
				.stroke({ color: current.palette.brand, width: inv, alpha: 0.9 });
		}
		if (interaction.type === "creatingArrow") {
			const color = pickBoardColor(current.colors, interaction.color, current.colorScheme);
			const target_ = interaction.targetItemId ? editor.itemById(interaction.targetItemId) : null;
			const end = target_
				? worldPoint(target_.frame.x + target_.frame.width / 2, target_.frame.y + target_.frame.height / 2)
				: interaction.current;
			const width = Math.max(interaction.size, 1.5 * inv);
			target.moveTo(interaction.start.x, interaction.start.y).lineTo(end.x, end.y).stroke({ color: color.stroke, width, alpha: 0.9 });
			arrowHead(target, interaction.start, end, color.stroke, width, inv, 0.95);
		}
		if (interaction.type === "creatingBox") {
			const color = pickBoardColor(current.colors, interaction.color, current.colorScheme);
			const { start, current: corner } = interaction;
			const w = Math.abs(corner.x - start.x);
			const h = Math.abs(corner.y - start.y);
			if (w > 1 || h > 1)
				target
					.roundRect(Math.min(start.x, corner.x), Math.min(start.y, corner.y), Math.max(w, 1), Math.max(h, 1), 4)
					.fill({ color: color.fill, alpha: 0.04 })
					.stroke({ color: color.stroke, width: 1.5 * inv, alpha: 0.85 });
		}
	}

	function cursorFor(): string {
		if (scriptMode === "interact" && scriptHover) {
			const output = scriptOutputs.get(scriptHover.owner);
			return output?.hits[scriptHover.target]?.cursor ?? (output?.listens.includes("click") ? "pointer" : "default");
		}
		const interaction = editor.interaction;
		switch (interaction.type) {
			case "panning":
			case "translating":
				return "grabbing";
			case "resizing":
				return resizeCursorForHandle(interaction.handle, interaction.single?.rotation ?? 0);
			case "rotating":
				return ROTATE_CURSOR;
			case "draggingArrowHandle":
			case "brushing":
				return "crosshair";
		}
		if (editor.spaceHeld || editor.tool === "hand") return "grab";
		const control = editor.hoveredTransformControl;
		if (control?.kind === "resize")
			return resizeCursorForHandle(control.handle, editor.selectionTransform?.frame.rotation ?? 0);
		if (control?.kind === "rotate") return ROTATE_CURSOR;
		if (isCreationBoardTool(editor.tool)) return "crosshair";
		const hovered = editor.hoverId ? editor.itemById(editor.hoverId) : null;
		return hovered && !hovered.locked && editor.registry.capabilities(hovered).canMove ? "move" : "default";
	}

	function scheduleRender() {
		if (renderFrame || !app || !active) return;
		renderFrame = requestAnimationFrame(() => {
			renderFrame = 0;
			app?.render();
		});
	}

	function scheduleTick() {
		if (tickFrame || !active || disposed) return;
		tickFrame = requestAnimationFrame(() => {
			tickFrame = 0;
			sync();
		});
	}

	function createScripts() {
		return createBoardScriptHost({
			host,
			capabilities: {
				...options.scriptCapabilities,
				"board.emit": async (id: string, value: unknown) => {
					const message = value as { target?: string; type?: string; data?: unknown };
					if (!message || typeof message.target !== "string" || typeof message.type !== "string" || !boardScriptScope(editor.document, id).has(message.target)) throw new Error("Invalid script event target.");
					scripts?.event(message.target, { type: message.type, data: message.data });
				},
				...(!editor.readonly ? { "board.commit": async (id: string, value: unknown) => {
					validateBoardScriptCommit(editor.document, id, value as BoardPatch);
					await editor.commitPatch(value as BoardPatch);
				} } : {}),
			},
			onOutput: (id, output) => {
				if (output) {
					prepareBoardScriptOutput(editor.document, id, output);
					scriptOutputs.set(id, output);
				} else scriptOutputs.delete(id);
				scriptVersion++;
				scheduleTick();
			},
			readModule: async (src) => {
				const url = await options.source.resolveFileUrl(src);
				if (!url) throw new Error(`${src} is not available.`);
				const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
				if (!response.ok) throw new Error(`${src} could not be read.`);
				return response.text();
			},
			onFrame: () => { scheduleTick(); for (const listener of scriptListeners) listener(); },
		});
	}

	function sync() {
		if (!app || !world || !scene || !overlay) return;
		const current = theme();
		const hasScripts = editor.hasScripts;
		if (hasScripts && !scripts) {
			scripts = createScripts();
			scriptTime = 0;
			scriptLastTick = performance.now();
		} else if (!hasScripts && scripts) {
			const previous = scripts;
			scripts = null;
			previous.destroy();
			scriptOutputs.clear();
			editor.setScriptItems(new Map());
			scriptHover = null;
			composedVersion = -1;
			composedDocument = null;
		}
		syncBackground(current);

		player.enter(editor.consumeRecentlyAdded(), editor.document);
		const playback = options.playback?.() ?? null;
		const frame = player.frame(editor.document, playback, performance.now(), Date.now(), editor.playhead?.animationId ?? null);
		const previews = previewItems();
		const moving = new Map<string, BoardItem>(previews);
		for (const [id, item] of frame.items) moving.set(id, item);
		editor.setPlayedItems(moving);
		if (scripts && (scriptOutputs.size || composedVersion !== scriptVersion)) {
			const playheadKey = `${editor.playhead?.animationId ?? ""}:${editor.playhead?.time ?? ""}`;
			if (scriptVersion !== composedVersion || composedDocument !== editor.document || moving.size || composedMoving || composedZoom !== editor.camera.zoom || composedPlayhead !== playheadKey) {
				const animationItems = editor.animationItems();
				const composed = composeBoardScriptItems(editor.document, editor.scene, scriptOutputs, animationItems, editor.camera,
					(owner, error) => scripts?.fault(owner, error instanceof Error ? error.message : String(error)));
				const scriptedIds = new Set([...scriptOutputs.values()].flatMap((output) => Object.keys(output.patches)));
				for (const id of animationItems.keys()) if (!scriptedIds.has(id)) composed.delete(id);
				editor.setScriptItems(composed);
				composedMoving = moving.size > 0;
				composedPlayhead = playheadKey;
				composedZoom = editor.camera.zoom;
				composedVersion = scriptVersion;
				composedDocument = editor.document;
			}
		}

		const renderScene = editor.scene;
		const animationId = editor.playhead?.animationId ?? (frame.playbackTime !== null ? playback?.animationId : null) ?? null;
		if (animationId && (effectDocument !== editor.document || effectAnimation !== animationId)) {
			effectDocument = editor.document;
			effectAnimation = animationId;
			effectSampler = createBoardAnimationSampler(editor.document, animationId);
		}
		if (editor.playhead && effectSampler) {
			frame.camera = effectSampler.at(editor.playhead.time).evaluation.camera;
			frame.time = editor.playhead.time;
		}
		const follows = editor.cameraPolicy === "follow" && Object.keys(frame.camera).length > 0;
		playbackCamera = follows ? followCamera(frame, renderScene) : null;
		const camera = renderCamera();
		if (scripts) {
			const now = performance.now();
			if (scriptMode !== "paused") scriptTime += Math.min(250, Math.max(0, now - scriptLastTick));
			scriptLastTick = now;
			scripts.sync(editor.document, renderScene, camera, scriptTime, scriptMode === "interact", visibleIds());
		}
		world.position.set(camera.x, camera.y);
		world.scale.set(camera.zoom);

		const ids = visibleIds();
		syncAssets(ids);
		const context = renderContext(current, renderScene, frame.time);
		if (animationId && effectSampler) {
			context.time = editor.playhead?.time ?? frame.time;
			const sampler = effectSampler;
			context.frameAt = sampler.frameAt;
		}
		const pinnedIds = new Set(editor.selection);
		for (const item of renderScene.items) {
			if (item.type === "effect" && item.props.kind === "trail" && renderScene.opacity(item.id) > 0) pinnedIds.add(item.id);
		}
		for (const id of previews.keys()) pinnedIds.add(id);
		if (editor.editingId) pinnedIds.add(editor.editingId);
		for (const id of frame.items.keys()) {
			pinnedIds.add(id);
			for (const child of renderScene.descendants(id)) pinnedIds.add(child);
			for (const binder of renderScene.binders(id)) pinnedIds.add(binder);
		}
		scene.sync({
			items: renderScene.items,
			strokes: liveStrokes(),
			scene: renderScene,
			context,
			getItem: (id) => renderScene.get(id) ?? null,
			visibleIds: ids,
			pinnedIds,
			globalSig: [assetVersion, cardEpoch, current.key, textZoomBucket(camera.zoom)].join("|"),
			structureVersion: editor.structureVersion,
			geometryVersion: editor.geometryVersion,
			gestureActive: editor.gestureActive && editor.interaction.type !== "panning",
		});

		const single = editor.selection.length === 1 ? renderScene.get(editor.selection[0] as string) : null;
		let arrowEndpoints: Array<{ x: number; y: number }> | undefined;
		if (single?.type === "arrow" && !single.locked) {
			const resolved = resolveSceneArrow(single as SceneItem<BoardArrowItem>, renderScene);
			arrowEndpoints = [resolved.start.point, resolved.mid, resolved.end.point];
		}
		const interaction = editor.interaction;
		scene.drawOverlay(
			{
				zoom: camera.zoom,
				pointerType: editor.pointerType,
				marquee: editor.marquee,
				selection: editor.selection,
				transform: editor.selectionTransform,
				controls: editor.tool === "select",
				hoveredControl: editor.hoveredTransformControl,
				rotationPointer: interaction.type === "rotating" ? interaction.current : null,
				arrowEndpoints,
				ports: editor.connectionPorts,
				hoveredPort: editor.hoveredConnectionPort,
				arrowDraft: null,
				bindTarget: editor.bindTargetFrame ?? editor.arrowDraft?.targetFrame ?? null,
			},
			current.palette,
		);
		options.drawOverlay?.(overlay, { zoom: camera.zoom, theme: current, scene: renderScene });
		drawTransient(overlay, current);

		views.sync({ ids, scene: renderScene, camera, surface, selection: context.selectedIds });
		const nextCursor = cursorFor();
		if (nextCursor !== cursor) host.style.cursor = cursor = nextCursor;

		scheduleRender();
		if (frame.running || scene.animated || (scriptMode !== "paused" && scripts?.animated)) scheduleTick();
	}

	function resize() {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			if (!app) return;
			app.resize();
			surface = { width: app.screen.width, height: app.screen.height };
			editor.surfaceSize = surface;
			options.onSurfaceChange?.(surface);
			sync();
		});
	}

	const rectOf = () => host.getBoundingClientRect();
	const inViews = (event: Event) => event.target instanceof Node && views.element.contains(event.target);

	function toInput(event: PointerEvent): BoardPointerEvent {
		return toBoardPointerEvent(event, rectOf(), renderCamera(), event.type === "pointermove" && editor.interaction.type === "drawing");
	}

	function scriptTarget(input: BoardPointerEvent) {
		if (!scriptOutputs.size) return null;
		const point = input.world;
		const candidates = editor.idsInRect({ x: point.x - 0.01, y: point.y - 0.01, width: 0.02, height: 0.02 }, true);
		return boardScriptTarget(editor.scene, candidates, point, scriptOutputs, editor.registry.hitTest);
	}

	function sendScriptEvent(target: { owner: string; target: string }, type: string, event: PointerEvent, input: BoardPointerEvent, related?: { owner: string; target: string } | null) {
		if (!scripts) return;
		const point = applyMatrix(invertMatrix(editor.scene.layout.matrix(target.owner)), input.world);
		scripts?.event(target.owner, { type, target: target.target, relatedTarget: related?.target, relatedOwner: related?.owner, point, pointerId: event.pointerId, pointerType: event.pointerType, buttons: event.buttons, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
	}

	function scriptPointer(type: "down" | "move" | "up" | "leave", event: PointerEvent, input: BoardPointerEvent): boolean {
		if (!scriptPointers.needsRouting(event.pointerId, scripts !== null)) return false;
		const enabled = scriptMode === "interact" && !editor.gestureActive && !editor.spaceHeld && event.button !== 1;
		const target = type === "leave" || !enabled || scriptPointers.owner(event.pointerId) === "editor" ? null : scriptTarget(input);
		if (target?.owner !== scriptHover?.owner || target?.target !== scriptHover?.target) {
			if (scriptHover) sendScriptEvent(scriptHover, "pointerleave", event, input, target);
			if (target) sendScriptEvent(target, "pointerenter", event, input, scriptHover);
			scriptHover = target;
		}
		const { recipient, click } = scriptPointers.route(type, event.pointerId, target, { x: event.clientX, y: event.clientY }, event.type !== "pointerup");
		if (type === "down" && recipient) { host.setPointerCapture(event.pointerId); host.focus({ preventScroll: true }); }
		if (recipient && type !== "leave") sendScriptEvent(recipient, input.cancelled ? "pointercancel" : `pointer${type}`, event, input);
		if (click) sendScriptEvent(click, "click", event, input);
		return recipient !== null;
	}

	function handleScriptKey(event: KeyboardEvent) {
		if (scriptMode !== "interact" || !scriptHover || event.target !== host) return;
		const input: BoardScriptEvent = { type: event.type, target: scriptHover.target, key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
		scripts?.event(scriptHover.owner, input);
		event.stopPropagation();
	}

	function handlePointerDown(event: PointerEvent) {
		if (inViews(event)) return;
		editor.takeCameraControl();
		const input = toInput(event);
		if (scriptPointer("down", event, input)) return;
		if (options.onPointer?.("down", event, input) === false) return;
		host.setPointerCapture(event.pointerId);
		editor.pointerDown(input);
	}

	function handlePointerMove(event: PointerEvent) {
		if (inViews(event)) return;
		const input = toInput(event);
		if (scriptPointer("move", event, input)) return;
		if (options.onPointer?.("move", event, input) === false) return;
		editor.pointerMove(input);
	}

	function handlePointerUp(event: PointerEvent) {
		if (inViews(event)) return;
		const input = toInput(event);
		if (scriptPointer("up", event, input)) return;
		if (options.onPointer?.("up", event, input) === false) return;
		editor.pointerUp(input);
		if (event.type === "pointercancel" || event.pointerType !== "mouse") editor.pointerLeave();
	}

	function handlePointerLeave(event: PointerEvent) {
		if (event.buttons !== 0) return;
		scriptPointer("leave", event, toInput(event));
		if (options.onPointer?.("leave", event, toInput(event)) === false) return;
		editor.pointerLeave();
	}

	function handleWheel(event: WheelEvent) {
		if (inViews(event)) return;
		event.preventDefault();
		editor.takeCameraControl();
		const rect = rectOf();
		const point: ScreenPoint = screenPoint(event.clientX - rect.left, event.clientY - rect.top);
		editor.wheel(point, event.deltaX, event.deltaY, event.ctrlKey || event.metaKey, event.deltaMode);
	}

	function handleDoubleClick(event: MouseEvent) {
		if (inViews(event)) return;
		const point = screenToWorld(event.clientX, event.clientY, rectOf(), renderCamera());
		const item = editor.itemAt(point);
		if (options.onDoubleClick?.(item, point) === true || editor.readonly) return;
		if (item && !item.locked && editor.registry.capabilities(item).canEdit) {
			editor.editingId = item.id;
			return;
		}
		if (item && item.type !== "frame" && item.type !== "arrow") return;
		const label = editor.labelItemAt(point);
		if (label) editor.editingId = label.id;
		else if (!item) editor.beginTextDraft(point);
	}

	const listeners: Array<[string, (event: never) => void, AddEventListenerOptions?]> = [
		["keydown", handleScriptKey],
		["keyup", handleScriptKey],
		["pointerdown", handlePointerDown],
		["pointermove", handlePointerMove],
		["pointerup", handlePointerUp],
		["pointercancel", handlePointerUp],
		["lostpointercapture", handlePointerUp],
		["pointerleave", handlePointerLeave],
		["wheel", handleWheel, { passive: false }],
		["dblclick", handleDoubleClick],
	];

	const stopEditor = editor.subscribe(LIVE_CHANNELS, scheduleTick);
	const stopAssets = assets.subscribe(() => {
		assetVersion += 1;
		requestAssets = true;
		scheduleTick();
	});
	const resizeObserver = new ResizeObserver(resize);

	const ready = (async () => {
		const instance = new Application();
		try {
			await instance.init({
				antialias: true,
				autoDensity: true,
				backgroundAlpha: 0,
				resizeTo: host,
				resolution: getBoardResolution(),
				autoStart: false,
			});
		} catch (error) {
			console.error("Board canvas failed to start", error);
			instance.destroy({ removeView: true });
			return false;
		}
		if (disposed) {
			instance.destroy({ removeView: true });
			return false;
		}
		app = instance;
		stopMaintenance = scheduleBoardMaintenance(instance.renderer);
		Object.assign(instance.canvas.style, {
			position: "relative",
			zIndex: "1",
			display: "block",
			touchAction: "none",
		});
		host.insertBefore(instance.canvas, views.element);
		world = new Container({ isRenderGroup: true, label: "board-world" });
		const nodes = new Container({ isRenderGroup: true, label: "board-nodes" });
		overlay = new Graphics({ label: "board-interaction-overlay" });
		world.addChild(nodes, overlay);
		instance.stage.addChild(world);
		scene = createBoardScene({ world: nodes, overlay, getRenderer: resolveRenderer, onFarLayerFrame: scheduleTick });

		for (const [type, listener, listenerOptions] of listeners)
			host.addEventListener(type, listener as EventListener, listenerOptions);
		resizeObserver.observe(host);
		resize();
		return true;
	})();

	return {
		ready,
		get renderer() {
			return app ? (app.renderer as unknown as Renderer) : null;
		},
		get camera() {
			return renderCamera();
		},
		get theme() {
			return theme();
		},
		setScriptMode(mode) { if (mode === scriptMode) return; scriptMode = mode; scriptLastTick = performance.now(); scheduleTick(); },
		resetScripts() { scriptTime = 0; scripts?.invalidate(); },
		invalidateScript(path) { scripts?.invalidate(path); },
		scriptOutput: (id) => scripts?.output(id) ?? null,
		async snapshotScripts() {
			const result: Record<string, BoardScriptSnapshot> = {};
			await Promise.all([...scriptOutputs.keys()].map(async (id) => { const snapshot = await scripts?.snapshot(id); if (snapshot) result[id] = snapshot; }));
			return result;
		},
		restoreScript(id, snapshot) { scripts?.restore(id, snapshot); },
		subscribeScripts(listener) { scriptListeners.add(listener); return () => { scriptListeners.delete(listener); }; },
		scriptError: (id) => scripts?.error(id) ?? null,
		setActive(next) {
			if (active === next) return;
			active = next;
			if (!active) {
				cancelAnimationFrame(renderFrame);
				cancelAnimationFrame(tickFrame);
				renderFrame = 0;
				tickFrame = 0;
				return;
			}
			player.reset();
			scriptLastTick = performance.now();
			resize();
		},
		invalidate(invalidation) {
			if (invalidation?.cards) {
				cardEpoch += 1;
				requestAssets = true;
			}
			scheduleTick();
		},
		isMaterialized: (id) => Boolean(scene?.getNode(id)),
		toWorld: (clientX, clientY) => screenToWorld(clientX, clientY, rectOf(), renderCamera()),
		destroy() {
			disposed = true;
			scriptPointers.clear();
			scriptListeners.clear();
			stopMaintenance?.();
			stopEditor();
			stopAssets();
			resizeObserver.disconnect();
			cancelAnimationFrame(resizeFrame);
			cancelAnimationFrame(renderFrame);
			cancelAnimationFrame(tickFrame);
			for (const [type, listener] of listeners) host.removeEventListener(type, listener as EventListener);
			editor.setPlayedItems(new Map());
			editor.setScriptItems(new Map());
			scene?.destroy(renderContext(theme(), editor.scene, 0));
			scene = null;
			scripts?.destroy();
			scripts = null;
			background?.destroy({ children: true });
			background = null;
			views.destroy();
			world = null;
			overlay = null;
			app?.destroy({ removeView: true });
			app = null;
		},
	};
}
