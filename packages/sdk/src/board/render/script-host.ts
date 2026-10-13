import type { BoardDocument, BoardItem } from "@cohub/protocol";
import { Texture } from "pixi.js";
import { boardScriptItems } from "../model/script-index.js";
import { boardScriptScope } from "../model/script-scene.js";
import type { BoardScene } from "../model/scene.js";
import type { BoardViewport } from "../model/geometry.js";
import type {
  BoardScriptEvent,
  BoardScriptOutput,
  BoardScriptSnapshot,
} from "../model/script.js";
import type { BoardScriptHost } from "./renderers/board-renderer-registry.js";
import {
  loadBoardScriptSources,
  createBoardScriptModuleReader,
  type BoardScriptSources,
} from "./script-modules.js";
import { boardScriptFrameSource } from "./script-sandbox.js";
import type { ScriptRuntimeInput } from "./script-runtime.js";

type Entry = {
  id: string;
  signature: string;
  token: number;
  ready: boolean;
  sources: BoardScriptSources | null;
  input: ScriptRuntimeInput;
  sentInput?: ScriptRuntimeInput;
  inputKey: string;
  inputDocument: BoardDocument | null;
  startedAt: number;
  capture?: {
    promise: Promise<BoardScriptSnapshot | null>;
    resolve(value: BoardScriptSnapshot | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  texture: Texture | null;
  error: string | null;
  output: BoardScriptOutput | null;
  events: BoardScriptEvent[];
  dirty: boolean;
  request: number;
  pending: boolean;
  timer?: ReturnType<typeof setTimeout>;
  time: number;
  sentSources: boolean;
  visible: boolean;
};

export type BoardScriptHostOptions = {
  readModule(path: string): Promise<string>;
  host: HTMLElement;
  onFrame(): void;
  onOutput(id: string, output: BoardScriptOutput | null): void;
  capabilities?: Record<
    string,
    (id: string, input: unknown) => Promise<unknown>
  >;
  timeoutMs?: number;
  export?: boolean;
  snapshots?: Readonly<Record<string, BoardScriptSnapshot>>;
};

export type BrowserBoardScriptHost = BoardScriptHost & {
  sync(
    document: BoardDocument,
    scene: BoardScene,
    camera: BoardViewport,
    time: number,
    interactive: boolean,
    visibleIds?: ReadonlySet<string> | null,
  ): void;
  event(id: string, event: BoardScriptEvent): void;
  output(id: string): BoardScriptOutput | null;
  snapshot(id: string): Promise<BoardScriptSnapshot | null>;
  restore(id: string, snapshot: BoardScriptSnapshot): void;
  fault(id: string, message: string): void;
  readonly animated: boolean;
  invalidate(src?: string): void;
  destroy(): void;
};

export function createBoardScriptHost(
  options: BoardScriptHostOptions,
): BrowserBoardScriptHost {
  const revisions = new Map<string, number>();
  const entries = new Map<string, Entry>();
  const restored = new Map(Object.entries(options.snapshots ?? {}));
  const sources = new Map<string, Promise<BoardScriptSources>>();
  const dependencies = new Map<string, Set<string>>();
  const modules = createBoardScriptModuleReader(options.readModule);
  const tokens = new Map<number, Entry>();
  let nextToken = 0;
  let brokerReady = false;
  let broker: HTMLIFrameElement | null = null;
  const signatures = new WeakMap<BoardItem, string>();
  function entrySignature(item: BoardItem): string {
    let value = signatures.get(item);
    if (value === undefined) {
      value = JSON.stringify(item.script);
      signatures.set(item, value);
    }
    return value;
  }
  const focusTargets = new Map<string, HTMLButtonElement>();
  const layer = document.createElement("div");
  layer.style.cssText =
    "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2";
  layer.dataset.boardScripts = "";
  options.host.appendChild(layer);
  let disposed = false;

  function ensureBroker() {
    if (broker) return;
    broker = document.createElement("iframe");
    broker.setAttribute("sandbox", "allow-scripts");
    broker.setAttribute("aria-hidden", "true");
    broker.tabIndex = -1;
    broker.style.cssText =
      "position:absolute;visibility:hidden;width:0;height:0;border:0";
    broker.srcdoc = boardScriptFrameSource();
    layer.appendChild(broker);
  }
  function removeFrame(entry: Entry) {
    if (entry.capture) {
      clearTimeout(entry.capture.timer);
      entry.capture.reject(
        new Error("Script stopped before its snapshot completed."),
      );
      entry.capture = undefined;
    }
    tokens.delete(entry.token);
    broker?.contentWindow?.postMessage(
      { token: entry.token, data: { kind: "terminate" } },
      "*",
    );
  }
  function release(entry: Entry) {
    clearTimeout(entry.timer);
    if (entry.ready && !entry.error) {
      post(entry, { kind: "dispose" });
      entry.timer = setTimeout(() => removeFrame(entry), 100);
    } else removeFrame(entry);
    entry.texture?.destroy(true);
    entries.delete(entry.id);
    revisions.set(entry.id, (revisions.get(entry.id) ?? 0) + 1);
    options.onOutput(entry.id, null);
  }
  function fail(entry: Entry, error: string) {
    clearTimeout(entry.timer);
    entry.error = error;
    revisions.set(entry.id, (revisions.get(entry.id) ?? 0) + 1);
    entry.pending = false;
    removeFrame(entry);
    options.onOutput(entry.id, null);
    options.onFrame();
  }
  function post(entry: Entry, data: unknown) {
    broker?.contentWindow?.postMessage({ token: entry.token, data }, "*");
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const fromBroker = broker !== null && event.source === broker.contentWindow;
    if (fromBroker && data.kind === "ready" && data.token === undefined) {
      brokerReady = true;
      for (const entry of tokens.values()) entry.ready = true;
      options.onFrame();
      return;
    }
    if (!fromBroker) return;
    const entry = tokens.get(data.token);
    if (!entry || entry.error) {
      if (fromBroker || entry) data.bitmap?.close?.();
      return;
    }
    if (data.kind === "disposed") {
      clearTimeout(entry.timer);
      removeFrame(entry);
      return;
    }
    if (entries.get(entry.id) !== entry) return;
    if (data.kind === "ready") {
      entry.ready = true;
      options.onFrame();
      return;
    }
    if (data.kind === "dirty") {
      entry.dirty = true;
      options.onFrame();
      return;
    }
    if (data.kind === "call") {
      const capability =
        typeof data.name === "string" &&
        options.capabilities &&
        Object.hasOwn(options.capabilities, data.name)
          ? options.capabilities[data.name]
          : undefined;
      void Promise.resolve()
        .then(() => {
          if (!capability)
            throw new Error(`Capability unavailable: ${data.name}`);
          return capability(entry.id, data.input);
        })
        .then(
          (value) => post(entry, { kind: "result", call: data.call, value }),
          (error: unknown) =>
            post(entry, {
              kind: "result",
              call: data.call,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      return;
    }
    if (data.kind === "snapshot") {
      const capture = entry.capture;
      if (!capture) return;
      clearTimeout(capture.timer);
      entry.capture = undefined;
      if (data.error) capture.reject(new Error(String(data.error)));
      else
        capture.resolve(
          data.snapshot
            ? { ...data.snapshot, configuration: entry.signature }
            : null,
        );
      return;
    }
    if (data.kind === "error") {
      fail(entry, String(data.error));
      return;
    }
    if (data.kind !== "frame" || data.request !== entry.request) {
      data.bitmap?.close?.();
      return;
    }
    clearTimeout(entry.timer);
    entry.pending = false;
    revisions.set(entry.id, (revisions.get(entry.id) ?? 0) + 1);
    if (data.bitmap) {
      const previous = entry.texture;
      entry.texture = Texture.from(data.bitmap);
      previous?.destroy(true);
    }
    try {
      const output = data.output as BoardScriptOutput | undefined;
      if (output) {
        options.onOutput(entry.id, output);
        entry.output = output;
      }
    } catch (error) {
      fail(entry, error instanceof Error ? error.message : String(error));
      return;
    }
    options.onFrame();
  };
  window.addEventListener("message", onMessage);

  return {
    revision: (id) => revisions.get(id) ?? 0,
    ready: (id) =>
      entries.get(id)?.output !== null && entries.get(id)?.output !== undefined,
    frame: (item) => entries.get(item.id)?.texture ?? null,
    error: (id) => entries.get(id)?.error ?? null,
    release: () => {}, // Render culling never disposes the script instance.
    fault(id, message) {
      const entry = entries.get(id);
      if (entry) fail(entry, message);
    },
    snapshot(id) {
      const entry = entries.get(id);
      if (!entry?.output || entry.error) return Promise.resolve(null);
      if (entry.capture) return entry.capture.promise;
      let resolve: (value: BoardScriptSnapshot | null) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const promise = new Promise<BoardScriptSnapshot | null>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => {
        entry.capture = undefined;
        reject(new Error("Script snapshot timed out."));
      }, options.timeoutMs ?? 2_000);
      entry.capture = { promise, resolve, reject, timer };
      post(entry, { kind: "snapshot", events: entry.events.splice(0) });
      return promise;
    },
    restore(id, snapshot) {
      const entry = entries.get(id);
      if (
        entry &&
        snapshot.configuration &&
        snapshot.configuration !== entry.signature
      )
        throw new Error("Snapshot configuration does not match the script.");
      if (
        !Number.isFinite(snapshot.time) ||
        snapshot.time < 0 ||
        !Number.isInteger(snapshot.random)
      )
        throw new Error("Invalid script snapshot.");
      restored.set(id, structuredClone(snapshot));
      if (entry) release(entry);
      options.onFrame();
    },
    output: (id) => entries.get(id)?.output ?? null,
    get animated() {
      return [...entries.values()].some(
        (entry) =>
          !entry.error &&
          entry.output?.animated &&
          (entry.visible || entry.output.updating) &&
          !entry.pending,
      );
    },
    sync(board, scene, camera, time, interactive, visibleIds) {
      if (disposed) return;
      const alive = new Set<string>();
      const liveFocusTargets = new Set<string>();
      for (const [id, item] of boardScriptItems(board)) {
        if (!item.script?.enabled) continue;
        alive.add(id);
        const signature = entrySignature(item);
        let entry = entries.get(id);
        if (entry && entry.signature !== signature) {
          release(entry);
          entry = undefined;
        }
        const box = scene.layout.box(id);
        const scoped: Record<string, BoardItem> =
          entry?.inputDocument === board ? entry.input.items : { [id]: item };
        if (entry?.inputDocument !== board)
          for (const child of boardScriptScope(board, id)) {
            const value = board.items[child];
            if (value) scoped[child] = value;
          }
        const input: ScriptRuntimeInput =
          entry?.inputDocument === board &&
          entry.input.width === box.width &&
          entry.input.height === box.height
            ? entry.input
            : {
                id,
                item,
                items: scoped,
                width: box.width,
                height: box.height,
                capabilities: Object.keys(options.capabilities ?? {}),
                snapshot: restored.get(id),
              };
        if (!entry) {
          ensureBroker();
          entry = {
            id,
            signature,
            token: ++nextToken,
            ready: brokerReady,
            sources: null,
            input,
            inputKey: "",
            inputDocument: null,
            startedAt:
              (options.export ? 0 : time) - (input.snapshot?.time ?? 0),
            texture: null,
            error: null,
            output: null,
            events: [],
            dirty: true,
            request: 0,
            pending: false,
            time: -1,
            sentSources: false,
            visible: true,
          };
          entries.set(id, entry);
          restored.delete(id);
          tokens.set(entry.token, entry);
          const current = entry;
          let loading = sources.get(item.script.src);
          if (!loading) {
            const paths = new Set([item.script.src]);
            dependencies.set(item.script.src, paths);
            loading = loadBoardScriptSources(item.script.src, (path) => {
              paths.add(path);
              return modules.read(path);
            });
            sources.set(item.script.src, loading);
          }
          current.timer = setTimeout(
            () => fail(current, "Script loading timed out."),
            15_000,
          );
          void loading.then(
            (value) => {
              if (disposed || entries.get(id) !== current) return;
              current.sources = value;
              options.onFrame();
            },
            (error: unknown) => {
              if (!disposed && entries.get(id) === current)
                fail(current, String(error));
            },
          );
        }
        if (entry.error) continue;
        const visible = !visibleIds || visibleIds.has(id);
        if (entry.visible !== visible) {
          entry.visible = visible;
          if (visible) entry.dirty = true;
        }
        if (entry.input !== input || entry.inputDocument !== board) {
          const inputKey = JSON.stringify(input);
          if (entry.inputKey !== inputKey) {
            entry.inputKey = inputKey;
            entry.input = input;
            entry.dirty = true;
          }
          entry.inputDocument = board;
        }
        if (entry.output && !options.export) {
          const hits = Object.entries(entry.output.hits).filter(
            ([, hit]) => hit.label,
          );
          if (!hits.length && entry.output.listens.length)
            hits.push([
              id,
              {
                x: 0,
                y: 0,
                width: box.width,
                height: box.height,
                label:
                  "text" in item.props && typeof item.props.text === "string"
                    ? item.props.text
                    : item.script.src,
              },
            ]);
          for (const [target, hit] of hits) {
            const key = `${id}/${target}`;
            liveFocusTargets.add(key);
            let button = focusTargets.get(key);
            if (!button) {
              button = document.createElement("button");
              button.type = "button";
              const emit = (type: string, key?: string) => {
                const current = entries.get(id);
                if (!current || current.error) return;
                current.events.push({
                  type,
                  target,
                  key,
                  point: {
                    x: hit.x + hit.width / 2,
                    y: hit.y + hit.height / 2,
                  },
                });
                current.dirty = true;
                options.onFrame();
              };
              button.onfocus = () => emit("focus");
              button.onblur = () => emit("blur");
              button.onclick = () => emit("click");
              button.onkeydown = (event) => emit("keydown", event.key);
              button.onkeyup = (event) => emit("keyup", event.key);
              focusTargets.set(key, button);
              layer.appendChild(button);
            }
            button.setAttribute("aria-label", hit.label ?? target);
            button.tabIndex = interactive && visible ? 0 : -1;
            const [a, b, c, d, x, y] = scene.layout.matrix(id);
            button.style.cssText = `position:absolute;pointer-events:none;background:transparent;border:0;padding:0;transform-origin:0 0;width:${hit.width}px;height:${hit.height}px;transform:matrix(${a * camera.zoom},${b * camera.zoom},${c * camera.zoom},${d * camera.zoom},${(x + a * hit.x + c * hit.y) * camera.zoom + camera.x},${(y + b * hit.x + d * hit.y) * camera.zoom + camera.y})`;
          }
        }
        if (
          !entry.ready ||
          !entry.sources ||
          entry.pending ||
          (!entry.dirty &&
            (!entry.output?.animated ||
              (!visible && !entry.output.updating) ||
              entry.time === time))
        )
          continue;
        entry.pending = true;
        entry.dirty = false;
        entry.time = time;
        entry.request++;
        const current = entry;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(
          () => fail(current, "Script execution timed out."),
          options.timeoutMs ?? 2_000,
        );
        post(entry, {
          request: entry.request,
          input: entry.sentInput === entry.input ? undefined : entry.input,
          sources: entry.sentSources ? undefined : entry.sources,
          draw: visible,
          t: time - entry.startedAt,
          scale: Math.min(2, 2048 / Math.max(1, box.width, box.height)),
          events: entry.events.splice(0),
        });
        entry.sentInput = entry.input;
        entry.sentSources = true;
      }
      for (const [key, button] of focusTargets)
        if (!liveFocusTargets.has(key)) {
          button.remove();
          focusTargets.delete(key);
        }
      for (const entry of entries.values())
        if (!alive.has(entry.id)) release(entry);
    },
    event(id, event) {
      const entry = entries.get(id);
      if (
        !entry ||
        entry.error ||
        (entry.output && !entry.output.listens.includes(event.type))
      )
        return;
      if (
        event.type === "pointermove" &&
        entry.events.at(-1)?.type === "pointermove"
      )
        entry.events.pop();
      if (entry.events.length >= 128) return;
      entry.events.push(event);
      entry.dirty = true;
      options.onFrame();
    },
    invalidate(path) {
      modules.invalidate(path);
      const affected = new Set(
        [...sources.keys()].filter(
          (src) => !path || src === path || dependencies.get(src)?.has(path),
        ),
      );
      for (const src of affected) {
        sources.delete(src);
        dependencies.delete(src);
      }
      let changed = false;
      for (const entry of entries.values()) {
        if (path && !affected.has(entry.input.item.script?.src ?? "")) continue;
        restored.delete(entry.id);
        release(entry);
        changed = true;
      }
      if (!path) restored.clear();
      if (changed) options.onFrame();
    },
    destroy() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const entry of entries.values()) release(entry);
      layer.remove();
      sources.clear();
      dependencies.clear();
      modules.destroy();
      focusTargets.clear();
      restored.clear();
      tokens.clear();
      revisions.clear();
      broker = null;
    },
  };
}
