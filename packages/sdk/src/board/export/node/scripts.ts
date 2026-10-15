import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Texture } from "pixi.js";
import { buildBoardScene, type BoardSceneItem } from "../../model/scene.js";
import {
  boardScriptScope,
  composeBoardScriptItems,
} from "../../model/script-scene.js";
import type { BoardScriptOutput } from "../../model/script.js";
import {
  loadBoardScriptSources,
  createBoardScriptModuleReader,
  type BoardScriptSources,
} from "../../render/script-modules.js";
import {
  createScriptRuntime,
  type ScriptRuntimeInput,
} from "../../render/script-runtime.js";
import type { BoardScriptHost } from "../../render/renderers/board-renderer-registry.js";
import type { BoardNodeRenderer } from "./index.js";

const WORKER = `
const {parentPort, workerData} = require('node:worker_threads');
const {createContext, Script, SourceTextModule} = require('node:vm');
const {createCanvas} = require(workerData.canvasModule);
const instances = new Map();
const graphs = new Map();
const update = new Script('__runtime.update(JSON.parse(__inputJson)); __runtime.step(__time)');
const draw = new Script('__runtime.draw(__drawing)');
const output = new Script('JSON.stringify(__runtime.output())');
const dispose = new Script('__runtime.destroy()');
function release(id) {
 const entry=instances.get(id);instances.delete(id);
 if(entry) {try {dispose.runInContext(entry.context,{timeout:workerData.timeout});} catch {}}
}
async function create(data) {
 const context = createContext({console:{log(){},warn(){},error(){}},structuredClone},{codeGeneration:{strings:false,wasm:false}});
 new Script("const __name=(value,name)=>Object.defineProperty(value,'name',{value:name,configurable:true})").runInContext(context);
 const sources = graphs.get(data.src);
 if(!sources) throw new Error('Module graph is unavailable.');
 const modules = new Map();
 const resolve = (from,name) => {
  const parts=from.split('/').slice(0,-1);
  for(const part of name.split('/')) { if(part==='..') parts.pop(); else if(part!=='.') parts.push(part); }
  return parts.join('/');
 };
 const link = (name,ref) => load(resolve(ref.identifier,name));
 function load(path) {
  if(modules.has(path)) return modules.get(path);
  const source=sources[path];
  if(!source) throw new Error('Module is unavailable: '+path);
  const module=new SourceTextModule(source.code,{context,identifier:path,importModuleDynamically:async name=>{
   const child=load(resolve(path,name));
   if(child.status==='unlinked') await child.link(link);
   if(child.status==='linked') await child.evaluate({timeout:workerData.timeout});
   return child;
  }});
  modules.set(path,module);return module;
 }
 const root=load(data.src);
 await root.link(link);await root.evaluate({timeout:workerData.timeout});
 context.__module=root.namespace;
 context.__inputJson=JSON.stringify(data.input);
 new Script('globalThis.__runtime=('+workerData.runtime+')(__module,JSON.parse(__inputJson),{call:async()=>{throw new Error("Capabilities are unavailable during export.")},invalidate(){}})').runInContext(context,{timeout:workerData.timeout});
 return {context,signature:data.signature,time:-1,draw:!!root.namespace.draw,canvas:null};
}
parentPort.on('message',async data=>{
 try {
  if(data.release) {for(const id of data.release) release(id);return;}
  if(data.sources) graphs.set(data.src,data.sources);
  let entry=instances.get(data.input.id);
  if(!entry || entry.signature!==data.signature || data.time<entry.time) {
   release(data.input.id);
   entry=await create(data);instances.set(data.input.id,entry);
  }
  const context=entry.context;
  context.__inputJson=JSON.stringify(data.input);context.__time=data.time;
  update.runInContext(context,{timeout:workerData.timeout});entry.time=data.time;
  let png;
  if(entry.draw) {
   const width=Math.max(1,Math.round(data.input.width*data.scale));
   const height=Math.max(1,Math.round(data.input.height*data.scale));
   const canvas=entry.canvas??=createCanvas(width,height);
   canvas.width=width;canvas.height=height;
   const drawing=canvas.getContext('2d');drawing.scale(data.scale,data.scale);
   context.__drawing=drawing;draw.runInContext(context,{timeout:workerData.timeout});
   png=canvas.toBuffer('image/png');delete context.__drawing;
  }
  parentPort.postMessage({png,output:JSON.parse(output.runInContext(context,{timeout:workerData.timeout}))});
 } catch(error) { instances.delete(data.input?.id);parentPort.postMessage({error:String(error.stack||error)}); }
});
`;

type Sample = { png?: Uint8Array; output: BoardScriptOutput; error?: string };
type Lane = {
  worker: Worker | null;
  tail: Promise<unknown>;
  graphs: Set<string>;
  reject?: (error: Error) => void;
};
export type BoardNodeScriptOptions = {
  readModule(src: string): Promise<string>;
  timeoutMs?: number;
  readTimeoutMs?: number;
};

export function createNodeBoardScriptHost(
  renderer: BoardNodeRenderer,
  options: BoardNodeScriptOptions,
): BoardScriptHost & {
  prepare(
    items: readonly BoardSceneItem[],
    times: readonly number[],
    zoom: number,
  ): Promise<void>;
  clearFrames(): void;
  destroy(): void;
} {
  const textures = new Map<string, Texture>();
  const outputs = new Map<number, Map<string, BoardScriptOutput>>();
  const errors = new Map<string, string>();
  const sources = new Map<string, Promise<BoardScriptSources>>();
  const modules = createBoardScriptModuleReader(options.readModule, options.readTimeoutMs);
  const lanes: Lane[] = Array.from({ length: 4 }, () => ({
    worker: null,
    tail: Promise.resolve(),
    graphs: new Set(),
  }));
  const assignments = new Map<string, Lane>();
  let disposed = false;
  let nextLane = 0;
  const timeout = options.timeoutMs ?? 2_000;
  const key = (id: string, time: number) => `${id}|${time}`;
  function stop(lane: Lane) {
    const worker = lane.worker;
    lane.worker = null;
    lane.graphs.clear();
    void worker?.terminate();
  }
  function sample(
    input: ScriptRuntimeInput,
    graph: BoardScriptSources,
    time: number,
    scale: number,
  ): Promise<Sample> {
    let lane = assignments.get(input.id);
    if (!lane) {
      lane = lanes[nextLane++ % lanes.length] as Lane;
      assignments.set(input.id, lane);
    }
    const selected = lane;
    const task = selected.tail.then(
      () =>
        new Promise<Sample>((resolve, reject) => {
          if (disposed) {
            reject(new Error("Script host is disposed."));
            return;
          }
          if (!Number.isFinite(time) || time < 0 || time > 600_000) {
            reject(
              new Error("Script export time must be between 0 and 600000 ms."),
            );
            return;
          }
          const freshWorker = !selected.worker;
          selected.worker ??= new Worker(WORKER, {
            eval: true,
            execArgv: [
              "--experimental-vm-modules",
              "--disable-warning=ExperimentalWarning",
            ],
            env: {},
            resourceLimits: { maxOldGenerationSizeMb: 128 },
            workerData: {
              runtime: createScriptRuntime.toString(),
              timeout,
              canvasModule: fileURLToPath(
                import.meta.resolve("@napi-rs/canvas"),
              ),
            },
          });
          const worker = selected.worker;
          if (freshWorker) {
            const stopped = (error: Error) => {
              if (selected.worker !== worker) return;
              if (selected.reject) selected.reject(error);
              else stop(selected);
            };
            worker.on("error", stopped);
            worker.on("exit", () => stopped(new Error("Script worker stopped.")));
          }
          const cleanup = () => {
            clearTimeout(timer);
            worker.off("message", message);
            selected.reject = undefined;
          };
          const failure = (error: Error) => {
            cleanup();
            stop(selected);
            reject(error);
          };
          const message = (value: Sample) => {
            cleanup();
            if (value.error) reject(new Error(value.error));
            else resolve(value);
          };
          const timer = setTimeout(
            () => failure(new Error("Script export timed out.")),
            Math.max(timeout, 15_000),
          );
          selected.reject = failure;
          worker.once("message", message);
          const src = input.item.script?.src ?? "";
          worker.postMessage({
            input,
            src,
            signature: JSON.stringify(input.item.script),
            sources: selected.graphs.has(src) ? undefined : graph,
            time,
            scale,
          });
          selected.graphs.add(src);
        }),
    );
    selected.tail = task.catch(() => undefined);
    return task;
  }
  return {
    ready: (id) => [...outputs.values()].some((at) => at.has(id)),
    frame: (item, time) => textures.get(key(item.id, time)) ?? null,
    error: (id) => errors.get(id) ?? null,
    release() {},
    document(document, time) {
      const at = outputs.get(time);
      if (!at?.size) return document;
      const items = { ...document.items };
      for (const [id, item] of composeBoardScriptItems(
        document,
        buildBoardScene(document),
        at,
      ))
        items[id] = item;
      return { ...document, items };
    },
    clearFrames() {
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      outputs.clear();
      errors.clear();
    },
    async prepare(items, times, zoom) {
      const scripted = items.filter((item) => item.script?.enabled);
      const alive = new Set(scripted.map((item) => item.id));
      for (const [id, lane] of assignments)
        if (!alive.has(id)) {
          lane.worker?.postMessage({ release: [id] });
          assignments.delete(id);
        }
      if (!scripted.length) return;
      const all = Object.fromEntries(items.map(({ id, frame: _frame, ...item }) => [id, item]));
      await Promise.all(
        scripted.map(async (item) => {
          const base = all[item.id];
          const src = item.script?.src;
          if (!base || !src) return;
          try {
            let graph = sources.get(src);
            if (!graph) {
              graph = loadBoardScriptSources(
                src,
                modules.read,
                options.readTimeoutMs,
              );
              sources.set(src, graph);
            }
            const resolved = await graph;
            const width = "size" in item ? item.size.width : item.frame.width;
            const height =
              "size" in item ? item.size.height : item.frame.height;
            const scale = Math.min(
              4,
              Math.max(0.25, zoom),
              2048 / Math.max(1, width, height),
            );
            const scoped = Object.fromEntries(
              [...boardScriptScope({ items: all }, item.id)].flatMap((id) =>
                all[id] ? [[id, all[id]]] : [],
              ),
            );
            for (const time of times) {
              const result = await sample(
                { id: item.id, item: base, items: scoped, width, height },
                resolved,
                time,
                scale,
              );
              if (disposed) return;
              if (result.png) {
                const frameKey = key(item.id, time);
                textures.get(frameKey)?.destroy(true);
                textures.set(
                  frameKey,
                  (await renderer.decodeImage(
                    result.png,
                  )) as unknown as Texture,
                );
              }
              let at = outputs.get(time);
              if (!at) {
                at = new Map();
                outputs.set(time, at);
              }
              at.set(item.id, result.output);
            }
          } catch (error) {
            errors.set(
              item.id,
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      );
    },
    destroy() {
      disposed = true;
      for (const lane of lanes) {
        lane.reject?.(new Error("Script host is disposed."));
        stop(lane);
      }
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      outputs.clear();
      sources.clear();
      modules.destroy();
      assignments.clear();
    },
  };
}
