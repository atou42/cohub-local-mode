import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { serveRuntime } from "../src/runtime/connection.js";
import { RuntimeSessionStore } from "../src/runtime/session-store.js";

test("Runtime starts and reports more than 64 pending Sessions in bounded recovery frames", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-recovery-batches-"));
  const spaceId = crypto.randomUUID();
  const store = new RuntimeSessionStore(spaceId, join(root, "state"));
  const stateDirectory = join(store.root, "pi");
  await mkdir(stateDirectory, { recursive: true });
  const expected = Array.from({ length: 65 }, () => ({ sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), harness: "pi" as const }));
  await Promise.all(expected.map((execution) => writeFile(join(stateDirectory, `${execution.sessionId}.json`), JSON.stringify({
    version: 1, sessionId: execution.sessionId, harness: execution.harness, pendingTurnId: execution.turnId,
  }))));

  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController();
  const frames: Array<typeof expected> = [];
  const received = new Promise<void>((resolve, reject) => {
    server.on("connection", (socket) => socket.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "runtime.hello") {
          socket.send(JSON.stringify({ type: "runtime.ready", connectionId: crypto.randomUUID() }));
          return;
        }
        if (frame.type !== "runtime.recovery") return;
        frames.push(frame.executions);
        if (frames.flat().length === expected.length) resolve();
      } catch (error) { reject(error); }
    }));
  });
  const running = serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${address.port}`, capabilities: { harnesses: ["pi"], models: [] }, harnesses: {}, token: async () => "fixture-token", signal: controller.signal, store, onReady: () => {} });
  try {
    await received;
    assert.deepEqual(frames.map((frame) => frame.length), [64, 1]);
    const bySession = (value: typeof expected) => [...value].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    assert.deepEqual(bySession(frames.flat()), bySession(expected));
  } finally {
    controller.abort(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const harness of ["pi", "codex"] as const) for (const resolved of [false, true]) for (const archiveUnavailable of [false, true]) {
  test(`${harness} WebSocket execution restores context and ${resolved ? "retires a confirmed execution" : "acknowledges native resume"} (archive fallback: ${archiveUnavailable})`,  { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "cohub-runtime-ws-"));
    const binary = fileURLToPath(new URL(`./fixtures/runtime-${harness}.mjs`, import.meta.url));
    await chmod(binary, 0o755);
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const controller = new AbortController();
    const spaceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const previousId = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const turns = [crypto.randomUUID(), crypto.randomUUID()];
    let round = 0;
    let contextRequests = 0;
    let deltas = 0;
    const resumes: string[] = [];
    let rejectFailure: (error: unknown) => void = () => {};
    const completed = new Promise<void>((resolve, reject) => {
      rejectFailure = reject;
      server.on("connection", (socket) => {
        const send = (value: unknown) => socket.send(JSON.stringify(value));
        const start = () => send({ type: "turn.start", requestId: ids[round], input: {
          spaceId, sessionId, turnId: turns[round], userMessageId: turns[round], harness,
          messages: [{ turnId: turns[round], userMessageId: turns[round], userId: "author", content: [{ type: "text", text: "continue" }] }], accessMode: "full_access",
          context: { complete: false, revision: round === 0 ? "one" : "two", throughTurnId: round === 0 ? previousId : turns[0], messages: [] },
        } });
        socket.on("message", (raw) => {
          try {
            const value = JSON.parse(raw.toString());
            if (value.type === "runtime.hello") { send({ type: "runtime.ready", connectionId: crypto.randomUUID() }); start(); return; }
            if (value.type !== "runtime.event") return;
            const event = value.event;
            if (event.type === "context.required") {
              contextRequests++;
              if (resolved && round === 1) assert.deepEqual(event.pendingTurnIds, [turns[0]], "only the actual pending projection is queried");
              if (archiveUnavailable && round === 0 && contextRequests === 1) {
                assert.notEqual(event.historyOnly, true);
                send({ type: "session.context", requestId: value.requestId, context: { complete: false, revision: "one", throughTurnId: previousId, messages: [], archive: { sessionId, turnId: previousId, harness } } });
                return;
              }
              if (archiveUnavailable && round === 0) assert.equal(event.historyOnly, true, "failed archive requests DB history once before execution");
              send({ type: "session.context", requestId: value.requestId, context: { complete: true, revision: round === 0 ? "one" : "two", throughTurnId: round === 0 ? previousId : turns[0], ...(resolved && round === 1 ? { resolvedTurnIds: [turns[0]] } : {}), messages: [{ id: "history", turnId: previousId, role: "user", content: [{ type: "text", text: "historical fact" }] }] } });
            }
            if (event.type === "text.delta") deltas++;
            if (event.type === "turn.error") throw new Error(event.message);
            if (event.type === "turn.end") {
              assert(deltas > 0, "deltas must arrive before completion");
              if (round === 0) {
                // Pi receives durable history through its native session file; Codex handoff has no native history channel yet.
                const expected = harness === "pi" ? "history retained" : "native resumed";
                assert(event.message.content.some((block: { type: string; text?: string }) => block.type === "text" && block.text?.includes(expected)));
              }
              resumes.push(event.resume);
              if (resolved && round === 0) { round++; start(); return; }
              send({ type: "turn.ack", requestId: value.requestId, revision: round === 0 ? "two" : "three", turnId: turns[round] });
            }
            if (event.type === "turn.acknowledged") {
              if (round++ === 0) start();
              else resolve();
            }
          } catch (error) { reject(error); controller.abort(); }
        });
      });
    });
    const running = serveRuntime({ spaceId, cwd: root, url: `ws://127.0.0.1:${address.port}`, capabilities: { harnesses: [harness], models: [] }, harnesses: { [harness]: binary }, token: async () => "fixture-token", signal: controller.signal, store: new RuntimeSessionStore(spaceId, join(root, "state")), onReady: () => {} });
    void running.catch(rejectFailure);
    try {
      await completed;
      assert.equal(contextRequests, (resolved ? 2 : 1) + Number(archiveUnavailable));
      assert.deepEqual(resumes, ["handoff", resolved ? "handoff" : "native"]);
    } finally {
      controller.abort();
      await running;
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
