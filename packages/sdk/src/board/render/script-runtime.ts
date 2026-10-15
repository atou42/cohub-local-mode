import type { BoardItem } from "@cohub/protocol";
import type {
  BoardScriptContext,
  BoardScriptEvent,
  BoardScriptEventOf,
  BoardScriptFrame,
  BoardScriptModule,
  BoardScriptOutput,
  BoardScriptSnapshot,
  BoardScriptView,
} from "../model/script.js";

export type ScriptRuntimeInput = {
  id: string;
  item: BoardItem;
  items: Record<string, BoardItem>;
  width: number;
  height: number;
  capabilities?: string[];
  snapshot?: BoardScriptSnapshot;
};

/** Self-contained so browser workers and Node execute exactly the same kernel. */
export function createScriptRuntime(
  module: BoardScriptModule,
  initial: ScriptRuntimeInput,
  host: {
    call(name: string, input: unknown): Promise<unknown>;
    invalidate(): void;
  },
) {
  if ("mount" in module)
    throw new Error(
      "Board scripts do not support DOM mount(). Use draw() or native scene items.",
    );
  let input = initial;
  let disposed = false;
  let revision = 0;
  let randomState = 2166136261;
  for (const char of initial.item.script?.seed ?? initial.id)
    randomState = Math.imul(randomState ^ char.charCodeAt(0), 16777619) >>> 0;
  const parameterDefaults = Object.fromEntries(
    Object.entries(module.parameters ?? {})
      .filter(([, spec]) => spec.default !== undefined)
      .map(([key, spec]) => [key, spec.default]),
  );
  let params = {
    ...parameterDefaults,
    ...initial.item.script?.params,
  } as BoardScriptFrame["params"];
  const state = structuredClone(initial.snapshot?.state ?? {});
  if (initial.snapshot) randomState = initial.snapshot.random;
  let time = initial.snapshot?.time ?? 0;
  let started = Boolean(initial.snapshot);
  const stepMs = 1000 / 60;
  let frame: BoardScriptFrame = {
    t: time,
    dt: 0,
    width: initial.width,
    height: initial.height,
    seed: initial.item.script?.seed ?? initial.id,
    params,
    state,
  };
  const handlers = new Map<string, Set<(event: BoardScriptEvent) => void>>();
  const frames = new Set<(frame: BoardScriptFrame) => void>();
  const cleanups: Array<() => void> = [];
  const effects = structuredClone(initial.snapshot?.effects);
  let patches: BoardScriptOutput["patches"] = effects?.patches ?? {};
  let items: BoardScriptOutput["items"] = effects?.items ?? {};
  let space: "world" | "screen" = effects?.space ?? "world";
  let anchor = effects?.anchor;
  let view: BoardScriptView | null = null;
  let hits: BoardScriptOutput["hits"] = effects?.hits ?? {};
  const invalidate = () => {
    if (disposed) return;
    revision++;
    host.invalidate();
  };
  const present: BoardScriptContext["present"] = (id, patch) => {
    if (patch === null) delete patches[id];
    else patches[id] = structuredClone(patch) as Record<string, unknown>;
    invalidate();
  };
  const context: BoardScriptContext = {
    self: {
      id: initial.id,
      get base() {
        return input.item;
      },
      present: (patch) => present(initial.id, patch),
    },
    get params() {
      return params;
    },
    get targets() {
      return input.item.script?.targets ?? {};
    },
    async emit(target, type, data) {
      await host.call("board.emit", { target, type, data });
    },
    state,
    get frame() {
      return frame;
    },
    get view() { return view; },
    random() {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    },
    on(type, handler) {
      let listeners = handlers.get(type);
      if (!listeners) {
        listeners = new Set();
        handlers.set(type, listeners);
      }
      const listener = (event: BoardScriptEvent) => handler(event as BoardScriptEventOf<typeof type>);
      listeners.add(listener);
      invalidate();
      return () => {
        listeners.delete(listener);
        invalidate();
      };
    },
    onFrame(handler) {
      frames.add(handler);
      invalidate();
      return () => {
        frames.delete(handler);
        invalidate();
      };
    },
    onDispose: (handler) => cleanups.push(handler),
    invalidate,
    get: (id) => input.items[id],
    present,
    scene(next, options) {
      items = structuredClone(next);
      space = options?.space ?? "world";
      anchor = options?.anchor ? structuredClone(options.anchor) : undefined;
      invalidate();
    },
    hitRegions(next) {
      hits = structuredClone(next);
      invalidate();
    },
    async commit(patch) {
      await host.call("board.commit", patch);
    },
    capabilities: {
      has: (name) => (input.capabilities ?? []).includes(name),
      call: (name, value) => host.call(name, value),
    },
  };
  const setup = module.default?.(context);
  if (typeof setup === "function") cleanups.push(setup);
  return {
    get animated() {
      return frames.size > 0 || module.animated === true;
    },
    update(next: ScriptRuntimeInput) {
      input = next;
      params = {
        ...parameterDefaults,
        ...next.item.script?.params,
      } as BoardScriptFrame["params"];
    },
    step(t: number) {
      if (disposed) return;
      if (!Number.isFinite(t) || t < time - 0.001)
        throw new Error("Reset the instance before seeking backwards.");
      const update = (at: number, dt: number) => {
        frame = {
          ...frame,
          t: at,
          dt,
          width: input.width,
          height: input.height,
          params: context.params,
        };
        for (const handler of frames) handler(frame);
      };
      if (!started) {
        started = true;
        update(time, 0);
      }
      if (frames.size) {
        while (time + stepMs <= t + 0.000001) {
          time += stepMs;
          update(time, stepMs);
        }
      } else time = t;
      frame = {
        ...frame,
        t,
        dt: 0,
        width: input.width,
        height: input.height,
        params: context.params,
      };
    },
    event(event: BoardScriptEvent) {
      if (disposed) return;
      if (event.type === "viewchange") view = event.data as BoardScriptView;
      const listeners = handlers.get(event.type);
      if (!listeners?.size) return;
      for (const handler of listeners) handler(event);
      invalidate();
    },
    draw(canvas: CanvasRenderingContext2D) {
      const result: unknown = module.draw?.(canvas, frame);
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("draw() must be synchronous.");
    },
    output(): BoardScriptOutput {
      return {
        parameters: module.parameters,
        space,
        anchor,
        patches,
        items,
        hits,
        listens: [...handlers]
          .filter(([, callbacks]) => callbacks.size)
          .map(([type]) => type),
        animated: this.animated,
        updating: frames.size > 0,
        version: revision,
      };
    },
    snapshot(includeEffects = true, clone = true): BoardScriptSnapshot {
      const snapshot = {
        state,
        time,
        random: randomState,
        effects: includeEffects ? { patches, items, hits, space, anchor } : undefined,
      };
      return clone ? structuredClone(snapshot) : snapshot;
    },
    destroy() {
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      handlers.clear();
      frames.clear();
      patches = {};
      items = {};
      hits = {};
    },
  };
}
