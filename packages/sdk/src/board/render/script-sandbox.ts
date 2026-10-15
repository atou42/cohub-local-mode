import type { BoardScriptEvent, BoardScriptModule } from "../model/script.js";
import {
  createScriptRuntime,
  type ScriptRuntimeInput,
} from "./script-runtime.js";
import { scriptModuleUrls, type BoardScriptSources } from "./script-modules.js";

type Request = {
  request: number;
  input?: ScriptRuntimeInput;
  sources?: BoardScriptSources;
  t: number;
  scale: number;
  draw?: boolean;
  events?: BoardScriptEvent[];
  kind?: string;
  call?: number;
  value?: unknown;
  error?: string;
};

function scriptAgent(
  runtimeFactory: typeof createScriptRuntime,
  moduleUrls: typeof scriptModuleUrls,
  load: (url: string) => Promise<BoardScriptModule>,
) {
  let runtime: ReturnType<typeof createScriptRuntime> | null = null;
  let input: ScriptRuntimeInput | null = null;
  let module: BoardScriptModule | null = null;
  let urls: ReturnType<typeof scriptModuleUrls> | null = null;
  let outputVersion = -1;
  let canvas: OffscreenCanvas | null = null;
  let callId = 0;
  const calls = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const send = (data: unknown, transfer: Transferable[] = []) => {
    (self as unknown as Worker).postMessage(data, transfer);
  };
  const call = (name: string, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++callId;
      calls.set(id, { resolve, reject });
      send({ kind: "call", call: id, name, input });
    });
  let processing = false;
  const queue: Request[] = [];
  async function process(data: Request) {
    try {
      if (data.input) input = data.input;
      if (!input) throw new Error("Missing script input.");
      if (!runtime) {
        if (!data.sources) throw new Error("Missing script modules.");
        urls = moduleUrls(data.sources);
        const src = input.item.script?.src;
        const url = src ? urls.urls[src] : undefined;
        if (!url) throw new Error("Missing entry module.");
        module = await load(url);
        runtime = runtimeFactory(module, input, {
          call,
          invalidate: () => {
            if (!processing) send({ kind: "dirty" });
          },
        });
      }
      if (data.input) runtime.update(input);
      for (const event of data.events ?? []) runtime.event(event);
      runtime.step(data.t);
      let bitmap: ImageBitmap | undefined;
      if (module?.draw && data.draw !== false) {
        const width = Math.max(1, Math.round(input.width * data.scale));
        const height = Math.max(1, Math.round(input.height * data.scale));
        canvas ??= new OffscreenCanvas(width, height);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is unavailable.");
        context.reset();
        context.scale(data.scale, data.scale);
        runtime.draw(context as unknown as CanvasRenderingContext2D);
        bitmap = canvas.transferToImageBitmap();
      }
      const output = runtime.output();
      const changed = output.version !== outputVersion;
      outputVersion = output.version;
      send(
        {
          kind: "frame",
          request: data.request,
          output: changed ? output : undefined,
          bitmap,
        },
        bitmap ? [bitmap] : [],
      );
    } catch (error) {
      send({
        kind: "error",
        request: data.request,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }
  }
  async function drain() {
    if (processing) return;
    processing = true;
    while (queue.length) {
      const request = queue.shift();
      if (request) await process(request);
    }
    processing = false;
  }
  self.addEventListener("message", (event: MessageEvent<Request>) => {
    const data = event.data;
    if (data.kind === "snapshot") {
      try {
        for (const event of data.events ?? []) runtime?.event(event);
        send({
          kind: "snapshot",
          snapshot: runtime?.snapshot(true, false) ?? null,
        });
      } catch (error) {
        send({ kind: "snapshot", error: String(error) });
      }
      return;
    }
    if (data.kind === "dispose") {
      try {
        runtime?.destroy();
        urls?.dispose();
      } finally {
        send({ kind: "disposed" });
      }
      return;
    }
    if (data.kind === "result" && data.call !== undefined) {
      const pending = calls.get(data.call);
      calls.delete(data.call);
      if (data.error) pending?.reject(new Error(data.error));
      else pending?.resolve(data.value);
      return;
    }
    queue.push(data);
    void drain();
  });
  self.addEventListener("unhandledrejection", (event) => {
    send({
      kind: "error",
      error: String((event as PromiseRejectionEvent).reason),
    });
  });
}

export function boardScriptFrameSource(): string {
  const runtime = createScriptRuntime.toString();
  const urls = scriptModuleUrls.toString();
  const agent = scriptAgent.toString();
  const prelude =
    "const __name = (value, name) => Object.defineProperty(value, 'name', { value: name, configurable: true });";
  const worker = `${prelude} (${agent})(${runtime}, ${urls}, url => import(url));`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>
${prelude}
const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(worker)}], {type:'text/javascript'}));
const workers = new Map();
addEventListener('message', event => {
 if(event.source !== parent) return;
 const {token, data} = event.data;
 if(typeof token !== 'number' || !data) return;
 let entry = workers.get(token);
 if(data.kind === 'terminate') {
  if(entry) { clearTimeout(entry.timer); entry.worker.terminate(); workers.delete(token); }
  return;
 }
 if(!entry) {
  if(!data.sources) return;
  const worker = new Worker(workerUrl);
  entry = {worker}; workers.set(token, entry);
  worker.onmessage = event => {
   parent.postMessage({...event.data, token}, '*', event.data.bitmap ? [event.data.bitmap] : []);
   if(event.data.kind === 'disposed') {
    clearTimeout(entry.timer); worker.terminate(); workers.delete(token);
   }
  };
  worker.onerror = event => parent.postMessage({token,kind:'error',error:event.message || 'Script worker failed to start.'}, '*');
 }
 entry.worker.postMessage(data);
 if(data.kind === 'dispose') entry.timer = setTimeout(() => {entry.worker.terminate(); workers.delete(token);},100);
});
parent.postMessage({kind:'ready'}, '*');
</script>`;
}
