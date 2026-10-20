import type {
  BoardScriptContext,
  BoardScriptFrame,
  BoardScriptHostEvents,
  BoardScriptModule,
  BoardScriptSceneOptions,
  BoardScriptView,
} from "./script.js";

/**
 * A compact reference for Board script authors, printed by `cohub boards schema script`.
 * Each group is checked against its type, so a new member fails to compile until it is described.
 */
export const BOARD_SCRIPT_API = {
  runtime: [
    "Modules are .js or .mjs Space files that import only literal relative paths (at most 64 modules, 2 MB).",
    "They run in a worker with no DOM or network. Use Apps for HTML content.",
    "Exports replay deterministically from ctx.onFrame, the frame clock, ctx.random() and ctx.state; timers, Date.now() and Math.random() do not.",
  ],
  module: {
    draw: "draw(ctx, frame): synchronous Canvas 2D drawing in item-local units.",
    animated: "true redraws every frame; otherwise draw runs when its inputs change or after invalidate().",
    parameters: "Declares params as { name: { type: number | boolean | string | color, label?, default?, min?, max?, step? } }.",
    default: "Setup function (ctx) for behavior; may return a cleanup function.",
  } satisfies Record<keyof BoardScriptModule, string>,
  frame: {
    t: "Clock time in milliseconds.",
    dt: "Milliseconds since the previous frame.",
    width: "Item width in board units.",
    height: "Item height in board units.",
    seed: "script.seed, or the item id.",
    params: "script.params merged over parameter defaults.",
    state: "ctx.state.",
  } satisfies Record<keyof BoardScriptFrame, string>,
  context: {
    self: "The owner: id, base (its authored item) and present(patch | null).",
    params: "script.params merged over parameter defaults.",
    targets: "script.targets: names mapped to item ids.",
    state: "Mutable state kept across frames and restored in exports.",
    frame: "The latest frame.",
    view: "Camera, width, height and safeRect in screen pixels; null until a viewchange.",
    random: "random(): a seeded number in [0, 1).",
    on: "on(type, handler): input and host events; returns an unsubscribe function.",
    onFrame: "onFrame(handler): a 60 Hz fixed step; returns an unsubscribe function.",
    onDispose: "onDispose(handler): cleanup when the instance stops.",
    invalidate: "invalidate(): redraw a non-animated draw().",
    get: "get(id): an item in scope, as authored.",
    present: "present(id, patch | null): temporarily override an item in scope; never saved.",
    scene: "scene(items, options?): replace this instance's temporary Board items; never saved.",
    hitRegions: "hitRegions(regions): replace the input declarations.",
    emit: "emit(id, type, data?): send a custom event to another scripted item in scope.",
    commit: "commit(patch): save a Board patch through history and permissions; it may edit items in scope or add children to a scoped frame.",
    capabilities: "has(name) and call(name, input?) for adapters the host provides.",
  } satisfies Record<keyof BoardScriptContext, string>,
  scope: "The owner, a Frame owner's descendants, and script.targets.",
  hitRegions: {
    forms: [
      "{ target: \"self\" }: the owner.",
      "{ item: id }: a scene item.",
      "{ x, y, width, height }: a rectangle in owner coordinates.",
    ],
    options: "label (also a keyboard focus target) and cursor.",
    rule: "Only declared regions receive input; everything else passes through to the Board. Event target is the region's key.",
  },
  sceneOptions: {
    space: "world (default) follows the owner's transform; screen keeps screen-pixel size and is left out of exports.",
    anchor: "{ item, point }: pin a screen scene to an item, point in 0–1 box coordinates.",
  } satisfies Record<keyof BoardScriptSceneOptions, string>,
  events: {
    input: "pointerenter, pointerleave, pointerdown, pointermove, pointerup, pointercancel, click, focus, blur, keydown, keyup. Pointer events carry point in owner coordinates; key events carry key.",
    host: {
      selectionchange: "data.ids: selected items in scope.",
      transformend: "data.ids, data.operation (move | resize | rotate | arrow), data.cancelled.",
      viewchange: "data: the view; also stored in ctx.view.",
    } satisfies Record<keyof BoardScriptHostEvents, string>,
  },
  view: {
    camera: "x, y and zoom.",
    width: "Viewport width in screen pixels.",
    height: "Viewport height in screen pixels.",
    safeRect: "The viewport area not covered by editor chrome.",
  } satisfies Record<keyof BoardScriptView, string>,
} as const;
