import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import { serveRuntime } from "../src/runtime/connection.js";
import { idleExecutor } from "./fixtures/runtime-native.js";
import { scratch } from "./fixtures/scratch.js";

test("hourly catalog refresh retains failures, skips overlaps, and registers changes on reconnect", { timeout: 10_000 }, async (t) => {
  const originalInterval = globalThis.setInterval;
  let refresh!: () => Promise<void>;
  let catalogTimer: ReturnType<typeof setInterval> | undefined;
  t.mock.method(globalThis, "setInterval", (callback, milliseconds, ...args) => {
    const timer = originalInterval(callback, milliseconds, ...args);
    if (milliseconds === 60 * 60 * 1000) {
      refresh = async () => { await callback(...args); };
      catalogTimer = timer;
    }
    return timer;
  });
  const clear = t.mock.method(globalThis, "clearInterval");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const initial: RuntimeCapabilities = { harnesses: ["codex"], models: [{ harness: "codex", provider: "openai", id: "old", name: "Old" }] };
  const updated: RuntimeCapabilities = { ...initial, models: [...initial.models, { harness: "codex", provider: "openai", id: "new", name: "New" }] };
  const hellos: RuntimeCapabilities[] = [];
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "runtime.hello") {
      hellos.push(frame.capabilities);
      socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
    }
  }));
  const controller = new AbortController();
  const events = new EventEmitter();
  const spaceId = crypto.randomUUID();
  let discover = async () => structuredClone(initial);
  const discovery = t.mock.fn(() => discover());
  const ready = once(events, "ready");
  const running = serveRuntime({
    spaceId, cwd: scratch, url: `ws://127.0.0.1:${address.port}`, capabilities: initial,
    discoverCapabilities: discovery, token: async () => "fixture-token", signal: controller.signal,
    executor: idleExecutor(spaceId), onReady: () => events.emit("ready"),
  });
  try {
    await ready;
    await refresh();
    discover = async () => { throw new Error("Discovery temporarily unavailable"); };
    await refresh();
    assert.deepEqual(hellos, [initial]);

    let finish!: (value: RuntimeCapabilities) => void;
    discover = () => new Promise((resolve) => { finish = resolve; });
    const pending = refresh();
    await refresh();
    assert.equal(discovery.mock.callCount(), 3, "only one discovery may run at a time");
    const changed = once(events, "ready");
    finish(updated);
    await pending;
    await changed;
    assert.deepEqual(hellos, [initial, updated]);

    const reconnected = once(events, "ready");
    for (const socket of server.clients) socket.terminate();
    await reconnected;
    assert.deepEqual(hellos, [initial, updated, updated]);
  } finally {
    controller.abort();
    await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert(catalogTimer && clear.mock.calls.some((call) => call.arguments[0] === catalogTimer));
  await refresh();
  assert.equal(discovery.mock.callCount(), 3, "shutdown must stop discovery");
});
