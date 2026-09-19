import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { once } from "node:events";
import { test } from "node:test";
import vm from "node:vm";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const relayRequire = createRequire(new URL("../../apps/local-relay/package.json", import.meta.url));
const ts = webRequire("typescript");
const { WebSocket, WebSocketServer } = relayRequire("ws");

// Exercise the actual entry-point functions without starting production services.
function functionsFrom(path, names) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length);
  return ts.transpileModule(functions.map((node) => node.getText(source).replace(/^export /, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const statusCode = functionsFrom("../../apps/web/src/lib/local-relay-client.ts", ["getLocalRelayNodeStatus"]);
const connectionCode = functionsFrom("../../apps/local-relay/node/index.mjs", ["connect", "scheduleReconnect"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mounted page resumes polling after timeout without a reload", async (t) => {
  const path = "../../apps/web/src/lib/features/session-chat/session-chat-host.controller.svelte.ts";
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "$effect" && node.arguments[0]?.getText(source).includes("getLocalRelayNodeStatus(")) effect = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(effect, "status polling effect must exist");
  let requests = 0;
  const server = createServer((_req, res) => {
    if (++requests === 1) return;
    res.end(JSON.stringify({ connected: true }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  let cleanup;
  const statuses = ["offline"];
  const sandbox = {
    fetch, AbortController, AbortSignal, DOMException,
    spaceId: "existing-space", isLocalRelayEnabled: true, options: { isLocalSpace: () => true },
    relayNodePath: () => `http://127.0.0.1:${server.address().port}/status`,
    $effect(fn) { cleanup = fn(); }, untrack: (fn) => fn(),
    refreshPendingRelayCommands() {}, startRelayEventConnection() {},
    closeRelayEventConnection() {}, stopAllRelayCommandWatches() {},
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 80)), clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 20)), clearInterval,
  };
  Object.defineProperty(sandbox, "relayStatus", {
    get: () => statuses.at(-1), set: (value) => statuses.push(value),
  });
  t.after(() => { cleanup?.(); server.closeAllConnections(); server.close(); });
  const ctx = vm.createContext(sandbox);
  const effectCode = ts.transpileModule(effect.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(statusCode + effectCode, ctx);
  const deadline = Date.now() + 1000;
  while (statuses.at(-1) !== "connected" && Date.now() < deadline) await sleep(10);
  assert.ok(statuses.includes("cloud-error"), "timeout must be exposed");
  assert.equal(statuses.at(-1), "connected", "same mounted view must recover");
  assert.ok(requests >= 2);
  cleanup();
  const count = requests;
  await sleep(100);
  assert.equal(requests, count, "unmounted view must stop polling");
});

for (const stalledBody of [false, true]) {
  test(`status request recovers after stalled ${stalledBody ? "body" : "headers"}`, async (t) => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      if (requests === 1) {
        if (stalledBody) res.writeHead(200, { "content-type": "application/json" }).flushHeaders();
        return;
      }
      res.end(JSON.stringify({ connected: true }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const parent = new AbortController();
    const ctx = vm.createContext({
      fetch, AbortController, AbortSignal, DOMException,
      relayNodePath: () => `http://127.0.0.1:${server.address().port}/status`,
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 60)), clearTimeout,
    });
    vm.runInContext(statusCode, ctx);
    const result = await Promise.race([
      ctx.getLocalRelayNodeStatus(parent.signal).then(() => "unexpected success", (error) => error.name),
      sleep(400).then(() => "stuck"),
    ]);
    parent.abort();
    assert.equal(result, "TimeoutError");
    assert.equal(await ctx.getLocalRelayNodeStatus(), true);
    assert.equal(requests, 2);
  });
}

test("caller cancellation aborts status request without waiting for timeout", async () => {
  const ctx = vm.createContext({
    fetch, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout,
    relayNodePath: () => "http://127.0.0.1:1/status",
  });
  vm.runInContext(statusCode, ctx);
  const parent = new AbortController();
  parent.abort(new DOMException("View closed", "AbortError"));
  await assert.rejects(ctx.getLocalRelayNodeStatus(parent.signal), { name: "AbortError" });
});

async function relayFixture(t, autoPong) {
  let connections = 0;
  let pings = 0;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong });
  await once(server, "listening");
  server.on("connection", (client) => {
    connections++;
    client.on("ping", () => pings++);
  });
  const timers = new Set();
  const ctx = vm.createContext({
    WebSocket, stopping: false, socket: null, reconnectAttempt: 0, reconnectTimer: null,
    relayUrl: `ws://127.0.0.1:${server.address().port}`, nodeToken: "isolated-test",
    writeStatus() {}, handleMessage() {}, console: { error() {} },
    setTimeout(fn, ms) { const timer = setTimeout(fn, Math.min(ms, 20)); timers.add(timer); return timer; },
    setInterval(fn, ms) { const timer = setInterval(fn, Math.min(ms, 30)); timers.add(timer); return timer; },
    clearTimeout, clearInterval,
  });
  vm.runInContext(connectionCode, ctx);
  t.after(() => {
    ctx.stopping = true;
    for (const timer of timers) clearTimeout(timer);
    ctx.socket?.terminate();
    for (const client of server.clients) client.terminate();
    server.close();
  });
  ctx.connect();
  return { ctx, server, connections: () => connections, pings: () => pings };
}

test("idle half-open relay is terminated and reconnected without a server close", async (t) => {
  const fixture = await relayFixture(t, false);
  const deadline = Date.now() + 1000;
  while (fixture.connections() < 2 && Date.now() < deadline) await sleep(10);
  assert.ok(fixture.pings() > 0, "must actively probe idle connections");
  assert.ok(fixture.connections() >= 2, "missing pong must reconnect");
});

test("healthy idle relay answers probes without reconnect churn", async (t) => {
  const fixture = await relayFixture(t, true);
  await sleep(200);
  assert.ok(fixture.pings() >= 2, "must keep probing after pong");
  assert.equal(fixture.connections(), 1);
});

test("explicit close reconnects, but shutdown does not", async (t) => {
  const fixture = await relayFixture(t, true);
  while (!fixture.connections()) await sleep(10);
  for (const client of fixture.server.clients) client.close(1012, "restart");
  const deadline = Date.now() + 1000;
  while (fixture.connections() < 2 && Date.now() < deadline) await sleep(10);
  assert.equal(fixture.connections(), 2);
  fixture.ctx.stopping = true;
  fixture.ctx.socket.close(1000, "shutdown");
  await sleep(100);
  assert.equal(fixture.connections(), 2);
  assert.equal(fixture.ctx.socket, null);
});
