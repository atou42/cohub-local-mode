import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPulseWatcher,
  loadPulseState,
  normalizePulseWatchEnvelope,
  PulseAccountMismatchError,
  PulseHttpError,
  PulseSpaceRejectedError,
  PulseStatePersistenceError,
  pulseStatePath,
} from "./pulse-watch.mjs";

const ownerUserId = "dec89612d5074605aeeb101a2918379a";
const spaceA = "11111111-1111-4111-8111-111111111111";
const spaceB = "22222222-2222-4222-8222-222222222222";
const spaceC = "33333333-3333-4333-8333-333333333333";
const spaceD = "44444444-4444-4444-8444-444444444444";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const turnId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const originConfigs = {
  local: { apiOrigin: "https://local.test", gatewayOrigin: "wss://local-gateway.test/ws" },
  cloud: { apiOrigin: "https://cloud.test", gatewayOrigin: "wss://cloud-gateway.test/ws" },
};

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function watchSnapshot({
  revision = 1,
  watchedSpaces = [{ origin: "local", spaceId: spaceA }],
  focus = null,
  now = Date.now(),
  owner = ownerUserId,
  expiresIn = 60 * 60_000,
  leaseIn = 60 * 60_000,
} = {}) {
  return {
    ownerUserId: owner,
    revision,
    expiresAt: iso(now + expiresIn),
    leaseExpiresAt: iso(now + leaseIn),
    watchedSpaces,
    focus,
  };
}

test("accepts only the exact Relay Activity watch envelope", () => {
  const envelope = {
    protocolVersion: 3,
    type: "activity-watch.replace",
    digest: "AB".repeat(32),
    ...watchSnapshot(),
  };
  assert.equal(normalizePulseWatchEnvelope(envelope).digest, "ab".repeat(32));
  assert.throws(() => normalizePulseWatchEnvelope({ ...envelope, source: "browser" }));
  assert.throws(() => normalizePulseWatchEnvelope({ ...envelope, protocolVersion: 1 }));
  assert.throws(() => normalizePulseWatchEnvelope({ ...envelope, digest: "bad" }));
});

function apiTurn({
  id = turnId,
  session = sessionId,
  status = "running",
  updatedAt = "2026-08-31T00:00:01.000Z",
  title = "Important session",
} = {}) {
  return {
    id,
    sessionId: session,
    status,
    updatedAt,
    userText: "secret user content",
    assistantText: "secret assistant content",
    session: { id: session, title },
  };
}

class FakeScheduler {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  delays() {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }

  runDelay(delayMs) {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.delayMs === delayMs);
    assert.ok(entry, `expected a scheduled ${delayMs}ms timer`);
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
  }
}

function createRealtimeHarness() {
  const connections = [];
  const factory = (options) => {
    const connection = {
      ...options,
      closed: false,
      async close() {
        this.closed = true;
      },
    };
    connections.push(connection);
    return connection;
  };
  return { connections, factory };
}

function createApiFixture({ cloudMe = ownerUserId } = {}) {
  const spaces = new Map();
  const requests = [];
  const responders = [];

  const setSpace = (origin, spaceId, { name = `${origin} Space`, turns = [] } = {}) => {
    spaces.set(`${origin}:${spaceId}`, { name, turns });
  };

  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    const origin = url.host === "cloud.test" ? "cloud" : "local";
    const request = {
      origin,
      pathname: url.pathname,
      search: url.search,
      authorization: new Headers(init.headers).get("authorization"),
    };
    requests.push(request);
    for (const responder of responders) {
      const response = await responder(request);
      if (response) return response;
    }
    if (url.pathname === "/api/me") return Response.json({ uuid: cloudMe });
    const spaceMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)$/);
    if (spaceMatch) {
      const value = spaces.get(`${origin}:${spaceMatch[1]}`);
      return value ? Response.json({ id: spaceMatch[1], name: value.name }) : Response.json({}, { status: 404 });
    }
    const turnsMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)\/turns$/);
    if (turnsMatch) {
      const value = spaces.get(`${origin}:${turnsMatch[1]}`);
      if (!value) return Response.json({}, { status: 404 });
      const focusSession = url.searchParams.get("sessionId");
      return Response.json({
        turns: focusSession
          ? value.turns.filter((turn) => turn.sessionId === focusSession)
          : value.turns,
      });
    }
    const turnMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)$/);
    if (turnMatch) {
      for (const value of spaces.values()) {
        const turn = value.turns.find(
          (candidate) => candidate.sessionId === turnMatch[1] && candidate.id === turnMatch[2],
        );
        if (turn) return Response.json({ session: turn.session, turn });
      }
      return Response.json({}, { status: 404 });
    }
    return Response.json({}, { status: 404 });
  };

  return { spaces, requests, responders, setSpace, fetcher };
}

async function createHarness(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-pulse-watch-"));
  const scheduler = options.scheduler ?? new FakeScheduler();
  const realtime = options.realtime ?? createRealtimeHarness();
  const events = [];
  const errors = [];
  const api = options.api ?? createApiFixture();
  const tokenCalls = [];
  const getAccessToken = options.getAccessToken ?? (async (forceRefresh = false) => {
    tokenCalls.push(Boolean(forceRefresh));
    return forceRefresh ? "fresh-token" : "initial-token";
  });
  const watcher = createPulseWatcher({
    dataDir,
    getAccessToken,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    fetcher: api.fetcher,
    originConfigs,
    createRealtimeConnection: realtime.factory,
    scheduler,
    now: options.now,
    writeState: options.writeState,
  });
  await watcher.start();
  t.after(async () => {
    await watcher.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, scheduler, realtime, events, errors, api, tokenCalls, watcher };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for pulse condition");
}

test("verifies the exact cloud account before reading a cloud Space", async (t) => {
  const api = createApiFixture({ cloudMe: "ffffffffffffffffffffffffffffffff" });
  api.setSpace("cloud", spaceA, { turns: [apiTurn()] });
  const harness = await createHarness(t, { api });

  assert.equal(
    await harness.watcher.replaceWatch(
      watchSnapshot({ watchedSpaces: [{ origin: "cloud", spaceId: spaceA }] }),
    ),
    true,
  );
  assert.deepEqual(api.requests.map((request) => request.pathname), ["/api/me"]);
  assert.equal(harness.errors.some((error) => error instanceof PulseAccountMismatchError), true);
});

test("keeps identical Space, Session, and Turn UUIDs separate across origins", async (t) => {
  const api = createApiFixture();
  api.setSpace("local", spaceA, { name: "Local Work", turns: [apiTurn()] });
  api.setSpace("cloud", spaceA, { name: "Cloud Work", turns: [apiTurn()] });
  const harness = await createHarness(t, { api });

  await harness.watcher.replaceWatch(watchSnapshot({
    watchedSpaces: [
      { origin: "local", spaceId: spaceA },
      { origin: "cloud", spaceId: spaceA },
    ],
  }));

  assert.deepEqual(harness.events.map((event) => event.origin).sort(), ["cloud", "local"]);
  assert.equal(harness.watcher.snapshot().knownTurns.length, 2);
});

test("monitors a focused fourth Space even when focus is automatic and Space-only", async (t) => {
  const api = createApiFixture();
  for (const spaceId of [spaceA, spaceB, spaceC]) api.setSpace("local", spaceId, { turns: [] });
  api.setSpace("cloud", spaceD, {
    name: "Fourth Space",
    turns: [apiTurn({ title: "Focused session" })],
  });
  const harness = await createHarness(t, { api });

  await harness.watcher.replaceWatch(watchSnapshot({
    watchedSpaces: [
      { origin: "local", spaceId: spaceA },
      { origin: "local", spaceId: spaceB },
      { origin: "local", spaceId: spaceC },
    ],
    focus: { origin: "cloud", spaceId: spaceD, sessionId: null, explicit: false },
  }));

  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].spaceId, spaceD);
  assert.equal(harness.events[0].spaceName, "Fourth Space");
});

test("uses realtime events only to wake an immediate authoritative reconcile", async (t) => {
  const api = createApiFixture();
  api.setSpace("cloud", spaceA, { turns: [] });
  const harness = await createHarness(t, { api });
  await harness.watcher.replaceWatch(watchSnapshot({ watchedSpaces: [{ origin: "cloud", spaceId: spaceA }] }));
  assert.equal(harness.events.length, 0);

  api.setSpace("cloud", spaceA, { name: "Cloud Work", turns: [apiTurn()] });
  harness.realtime.connections.find((connection) => connection.origin === "cloud").onWake({
    status: "completed",
    userText: "untrusted realtime content",
  });
  harness.scheduler.runDelay(0);
  await waitFor(() => harness.events.length === 1);

  assert.equal(harness.events[0].status, "running");
  assert.equal(JSON.stringify(harness.events[0]).includes("untrusted realtime content"), false);
});

test("switches from 30s reconcile to 5s polling when realtime disconnects", async (t) => {
  const api = createApiFixture();
  api.setSpace("local", spaceA, { turns: [] });
  const harness = await createHarness(t, { api });
  await harness.watcher.replaceWatch(watchSnapshot());
  const connection = harness.realtime.connections.find((candidate) => candidate.origin === "local");

  connection.onConnection("connected");
  harness.scheduler.runDelay(0);
  await waitFor(() => harness.scheduler.delays().includes(30_000));
  connection.onConnection("disconnected");
  assert.equal(harness.scheduler.delays().includes(5_000), true);
});

test("renews an unchanged watch lease without requiring a new scope revision", async (t) => {
  const currentTime = Date.parse("2026-08-31T00:00:00.000Z");
  const api = createApiFixture();
  api.setSpace("local", spaceA, { turns: [] });
  const harness = await createHarness(t, { api, now: () => currentTime });
  await harness.watcher.replaceWatch(
    watchSnapshot({ now: currentTime, leaseIn: 10_000, expiresIn: 60_000 }),
  );

  const renewed = watchSnapshot({
    now: currentTime,
    revision: 1,
    leaseIn: 20_000,
    expiresIn: 60_000,
  });
  assert.equal(await harness.watcher.replaceWatch(renewed), true);
  assert.equal(harness.watcher.snapshot().watch.leaseExpiresAt, renewed.leaseExpiresAt);
  assert.equal(harness.realtime.connections.length, 1);
});

test("recovers a missed terminal transition by authoritative reconciliation", async (t) => {
  const api = createApiFixture();
  api.setSpace("local", spaceA, { turns: [apiTurn()] });
  const harness = await createHarness(t, { api });
  await harness.watcher.replaceWatch(watchSnapshot());
  const running = harness.events[0];
  await harness.watcher.acknowledge(running.id);

  api.setSpace("local", spaceA, {
    turns: [apiTurn({ status: "completed", updatedAt: "2026-08-31T00:00:09.000Z" })],
  });
  await harness.watcher.reconcileNow();

  assert.deepEqual(harness.events.map((event) => event.status), ["running", "completed"]);
  assert.equal(harness.events[1].observedAt, "2026-08-31T00:00:09.000Z");
});

test("replays pending events with stable ids after restart and does not duplicate them", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-pulse-restart-"));
  const api = createApiFixture();
  api.setSpace("local", spaceA, { turns: [apiTurn()] });
  const firstEvents = [];
  const first = createPulseWatcher({
    dataDir,
    getAccessToken: async () => "token-not-persisted",
    onEvent: (event) => firstEvents.push(event),
    fetcher: api.fetcher,
    originConfigs,
    createRealtimeConnection: createRealtimeHarness().factory,
    scheduler: new FakeScheduler(),
  });
  await first.start();
  await first.replaceWatch(watchSnapshot());
  await first.stop();

  const resumedEvents = [];
  const resumed = createPulseWatcher({
    dataDir,
    getAccessToken: async () => "new-token-not-persisted",
    onEvent: (event) => resumedEvents.push(event),
    fetcher: api.fetcher,
    originConfigs,
    createRealtimeConnection: createRealtimeHarness().factory,
    scheduler: new FakeScheduler(),
  });
  t.after(async () => {
    await resumed.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  await resumed.start();

  assert.equal(resumedEvents.length, 1);
  assert.equal(resumedEvents[0].id, firstEvents[0].id);
});

test("rejects corrupt state without rewriting the evidence", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-pulse-corrupt-"));
  const path = pulseStatePath(dataDir);
  const corrupt = '{"version":1,"watch":{},"knownTurns":[],"pendingEvents":[]}\n';
  await writeFile(path, corrupt, "utf8");
  const watcher = createPulseWatcher({
    dataDir,
    getAccessToken: async () => "token",
    onEvent: () => {},
    fetcher: async () => Response.json({}),
    createRealtimeConnection: createRealtimeHarness().factory,
  });
  t.after(async () => {
    await watcher.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(() => watcher.start(), /state\.watch\.revision/);
  assert.equal(await readFile(path, "utf8"), corrupt);
});

test("lease expiry stops realtime and prevents later reconciliation", async (t) => {
  let currentTime = Date.parse("2026-08-31T00:00:00.000Z");
  const scheduler = new FakeScheduler();
  const api = createApiFixture();
  api.setSpace("local", spaceA, { turns: [apiTurn()] });
  const harness = await createHarness(t, { api, scheduler, now: () => currentTime });
  await harness.watcher.replaceWatch(watchSnapshot({ now: currentTime, leaseIn: 1_000 }));
  const connection = harness.realtime.connections[0];
  const requestCount = api.requests.length;

  currentTime += 1_000;
  scheduler.runDelay(1_000);
  await waitFor(() => connection.closed);
  await harness.watcher.reconcileNow();

  assert.equal(api.requests.length, requestCount);
  assert.equal(connection.closed, true);
  assert.equal(harness.watcher.snapshot().knownTurns.length, 0);
  assert.equal(harness.watcher.snapshot().pendingEvents.length, 0);
});

test("a 401 performs exactly one forced refresh and verifies the refreshed cloud token", async (t) => {
  const api = createApiFixture();
  api.setSpace("cloud", spaceA, { turns: [apiTurn()] });
  api.responders.push((request) => {
    if (request.authorization === "Bearer initial-token") {
      return Response.json({ message: "expired" }, { status: 401 });
    }
    return null;
  });
  const tokenCalls = [];
  const harness = await createHarness(t, {
    api,
    getAccessToken: async (forceRefresh = false) => {
      tokenCalls.push(Boolean(forceRefresh));
      return forceRefresh ? "fresh-token" : "initial-token";
    },
  });
  await harness.watcher.replaceWatch(watchSnapshot({ watchedSpaces: [{ origin: "cloud", spaceId: spaceA }] }));

  assert.deepEqual(tokenCalls, [false, true]);
  assert.equal(
    api.requests.some(
      (request) => request.pathname === "/api/me" && request.authorization === "Bearer fresh-token",
    ),
    true,
  );
  assert.equal(harness.events.length, 1);
});

test("surfaces a second 401 explicitly after the single refresh", async (t) => {
  const api = createApiFixture();
  api.responders.push(() => Response.json({ message: "expired" }, { status: 401 }));
  const harness = await createHarness(t, { api });

  assert.equal(
    await harness.watcher.replaceWatch(
      watchSnapshot({ watchedSpaces: [{ origin: "cloud", spaceId: spaceA }] }),
    ),
    true,
  );
  assert.deepEqual(harness.tokenCalls, [false, true]);
  assert.equal(
    harness.errors.some((error) => error instanceof PulseHttpError && error.status === 401),
    true,
  );
});

test("rejects a watch replacement when its atomic persistence fails", async (t) => {
  const api = createApiFixture();
  api.setSpace("local", spaceA, { turns: [] });
  const harness = await createHarness(t, {
    api,
    writeState: async () => {
      throw new Error("disk unavailable");
    },
  });

  await assert.rejects(
    () => harness.watcher.replaceWatch(watchSnapshot()),
    PulseStatePersistenceError,
  );
  assert.equal(harness.watcher.snapshot().watch, null);
  assert.equal(api.requests.length, 0);
});

test("a rejected Space produces no lifecycle event", async (t) => {
  const api = createApiFixture();
  api.responders.push((request) =>
    request.pathname === `/api/spaces/${spaceA}`
      ? Response.json({ message: "forbidden" }, { status: 403 })
      : null,
  );
  const harness = await createHarness(t, { api });
  await harness.watcher.replaceWatch(watchSnapshot());

  assert.equal(harness.events.length, 0);
  assert.equal(harness.errors.some((error) => error instanceof PulseSpaceRejectedError), true);
});

test("persists only metadata, removes ACKed events, and never writes an access token", async (t) => {
  const api = createApiFixture();
  api.setSpace("local", spaceA, { name: "Real Space", turns: [apiTurn({ title: "Real Session" })] });
  const secretToken = "this-token-must-never-reach-disk";
  const harness = await createHarness(t, {
    api,
    getAccessToken: async () => secretToken,
  });
  await harness.watcher.replaceWatch(watchSnapshot());
  const event = harness.events[0];
  const serialized = await readFile(pulseStatePath(harness.dataDir), "utf8");

  assert.equal(serialized.includes(secretToken), false);
  assert.equal(serialized.includes("secret user content"), false);
  assert.equal(serialized.includes("secret assistant content"), false);
  assert.equal(event.spaceName, "Real Space");
  assert.equal(event.sessionTitle, "Real Session");
  assert.equal(await harness.watcher.acknowledge(event.id), true);
  assert.equal((await loadPulseState(pulseStatePath(harness.dataDir))).pendingEvents.length, 0);
});
