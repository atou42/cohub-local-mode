import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseNodeMessage } from "../src/protocol.ts";
import {
  atomicWriteJson,
  createTurnWatcher,
  isWatchTimedOut,
  loadWatchState,
  normalizeWatchState,
  pollIntervalMs,
  TURN_PAYLOAD_MAX_BYTES,
  truncateTurnPayload,
  watchStatePath,
} from "./turn-watch.mjs";

const spaceId = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";
const sessionId = "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02";
const turnId = "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01";
const eventId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const runningUpdatedAt = "2026-08-26T00:00:01.000Z";
const completedUpdatedAt = "2026-08-26T00:00:02.000Z";

function watchRecord(overrides = {}) {
  return {
    eventId,
    spaceId,
    sessionId,
    turnId,
    responseReplacements: [],
    nodeId: "mac-mini",
    startedAt: new Date().toISOString(),
    spaceName: "Local Mac",
    sessionTitle: "Ship Agent Pulse",
    ...overrides,
  };
}

function completedEvent(events) {
  return events.find((event) => event.kind === "turn.completed");
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for watcher condition");
}

function trackWatcher(t, dataDir, watcher) {
  t.after(async () => {
    await watcher.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return watcher;
}

test("polls faster in the first minute then slower until the 24h cap", () => {
  assert.equal(pollIntervalMs(0), 1_000);
  assert.equal(pollIntervalMs(59_999), 1_000);
  assert.equal(pollIntervalMs(60_000), 5_000);
  assert.equal(isWatchTimedOut(24 * 60 * 60 * 1000 - 1), false);
  assert.equal(isWatchTimedOut(24 * 60 * 60 * 1000), true);
});

test("strips a turn payload that exceeds 256KB", () => {
  const small = { session: { id: sessionId }, turn: { id: turnId, status: "completed" } };
  assert.deepEqual(truncateTurnPayload(small), { turn: small, truncated: false });
  const huge = { session: { id: sessionId }, turn: { blob: "x".repeat(TURN_PAYLOAD_MAX_BYTES) } };
  assert.deepEqual(truncateTurnPayload(huge), { turn: null, truncated: true });
});

test("measures the turn payload limit in UTF-8 bytes", () => {
  const cjk = { turn: { blob: "汉".repeat(100) } };
  assert.ok(JSON.stringify(cjk).length <= 200);
  assert.deepEqual(truncateTurnPayload(cjk, 200), { turn: null, truncated: true });
});

test("persists watch state atomically and reloads it", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = watchStatePath(dataDir);
  const stored = {
    watches: [watchRecord()],
    pendingEvents: [
      {
        id: eventId,
        kind: "turn.completed",
        spaceId,
        sessionId,
        turnId,
        completedAt: "2026-08-26T00:00:01.000Z",
        turn: null,
        truncated: true,
      },
    ],
  };
  await atomicWriteJson(path, stored);
  assert.deepEqual(await loadWatchState(path), {
    ...stored,
    watches: stored.watches.map((watch) => ({
      ...watch,
      lastStatus: null,
      lastObservedAt: null,
    })),
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), stored);
});

test("rejects structurally invalid persisted state without rewriting the evidence", async (t) => {
  const fixtures = [
    {
      name: "top-level watches is not an array",
      value: { watches: {}, pendingEvents: [] },
      path: "state.watches",
    },
    {
      name: "watch replacement pair is incomplete",
      value: {
        watches: [watchRecord({ responseReplacements: [["only-one-value"]] })],
        pendingEvents: [],
      },
      path: "state.watches[0].responseReplacements[0]",
    },
    {
      name: "completed event is missing its payload schema",
      value: {
        watches: [],
        pendingEvents: [{ id: eventId, kind: "turn.completed" }],
      },
      path: "state.pendingEvents[0].spaceId",
    },
    {
      name: "lifecycle event has an unsupported status",
      value: {
        watches: [],
        pendingEvents: [
          {
            id: eventId,
            kind: "turn.lifecycle",
            nodeId: "mac-mini",
            spaceId,
            sessionId,
            turnId,
            status: "waiting_for_magic",
            observedAt: "2026-08-26T00:00:01.000Z",
          },
        ],
      },
      path: "state.pendingEvents[0].status",
    },
    {
      name: "local watcher state rejects a cloud lifecycle origin",
      value: {
        watches: [],
        pendingEvents: [
          {
            id: eventId,
            kind: "turn.lifecycle",
            origin: "cloud",
            nodeId: "mac-mini",
            spaceId,
            sessionId,
            turnId,
            status: "running",
            observedAt: runningUpdatedAt,
            spaceName: "Local Mac",
            sessionTitle: "Ship Agent Pulse",
          },
        ],
      },
      path: "state.pendingEvents[0].origin",
    },
    {
      name: "local watcher state rejects an unknown lifecycle origin",
      value: {
        watches: [],
        pendingEvents: [
          {
            id: eventId,
            kind: "turn.lifecycle",
            origin: "nearby",
            nodeId: "mac-mini",
            spaceId,
            sessionId,
            turnId,
            status: "running",
            observedAt: runningUpdatedAt,
            spaceName: "Local Mac",
            sessionTitle: "Ship Agent Pulse",
          },
        ],
      },
      path: "state.pendingEvents[0].origin",
    },
    {
      name: "persisted space name contains a control character",
      value: {
        watches: [watchRecord({ spaceName: "Local\nMac" })],
        pendingEvents: [],
      },
      path: "state.watches[0].spaceName",
    },
    {
      name: "persisted session title exceeds the database scalar limit",
      value: {
        watches: [watchRecord({ sessionTitle: "汉".repeat(256) })],
        pendingEvents: [],
      },
      path: "state.watches[0].sessionTitle",
    },
    {
      name: "persisted lifecycle ordering timestamp is invalid",
      value: {
        watches: [watchRecord({ lastObservedAt: "not-a-timestamp" })],
        pendingEvents: [],
      },
      path: "state.watches[0].lastObservedAt",
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-invalid-"));
      try {
        const serialized = `${JSON.stringify(fixture.value, null, 2)}\n`;
        await writeFile(watchStatePath(dataDir), serialized, "utf8");
        const watcher = createTurnWatcher({ dataDir, delay: async () => {} });
        await assert.rejects(
          () => watcher.start(),
          (error) => {
            assert.equal(error instanceof TypeError, true);
            assert.match(error.message, new RegExp(fixture.path.replaceAll("[", "\\[").replaceAll("]", "\\]")));
            return true;
          },
        );
        assert.equal(await readFile(watchStatePath(dataDir), "utf8"), serialized);
        await watcher.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("normalizes the pre-lifecycle watch schema without losing valid legacy state", () => {
  const legacyWatch = watchRecord();
  delete legacyWatch.spaceName;
  delete legacyWatch.sessionTitle;
  const legacy = {
    watches: [legacyWatch],
    pendingEvents: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "turn.completed",
        spaceId,
        sessionId,
        turnId,
        completedAt: "2026-08-26T00:00:01.000Z",
        turn: null,
        truncated: true,
      },
    ],
  };

  assert.deepEqual(normalizeWatchState(legacy), {
    watches: [{
      ...legacyWatch,
      lastStatus: null,
      lastObservedAt: null,
      spaceName: null,
      sessionTitle: null,
    }],
    pendingEvents: legacy.pendingEvents,
  });
});

test("migrates only the known origin-less local lifecycle state deterministically", () => {
  const legacyLifecycle = {
    id: eventId,
    kind: "turn.lifecycle",
    nodeId: "mac-mini",
    spaceId,
    sessionId,
    turnId,
    status: "running",
    observedAt: runningUpdatedAt,
    spaceName: "Local Mac",
    sessionTitle: "Ship Agent Pulse",
  };
  const normalized = normalizeWatchState({
    watches: [],
    pendingEvents: [legacyLifecycle],
  });
  assert.deepEqual(normalized.pendingEvents, [
    { ...legacyLifecycle, origin: "local" },
  ]);
  assert.deepEqual(normalizeWatchState(normalized), normalized);
});

test("fetches real display names once, persists them, and reuses them after restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-names-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const firstEvents = [];
  const delays = [];
  const requested = [];
  const first = createTurnWatcher({
    dataDir,
    delay: (_ms, signal) =>
      new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        delays.push(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      }),
    fetcher: async (url, init = {}) => {
      const target = String(url);
      requested.push({ target, authorization: init.headers?.authorization });
      if (target.endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (target.endsWith(`/api/spaces/${spaceId}`)) {
        return Response.json({ id: spaceId, name: " Local Mac " });
      }
      return Response.json({
        session: { id: sessionId, title: " Ship Agent Pulse " },
        turn: { id: turnId, status: "running", updatedAt: runningUpdatedAt },
      });
    },
    onEvent: (event) => firstEvents.push(event),
  });
  await first.start();
  await first.watch(watchRecord({ spaceName: null, sessionTitle: null }));
  await waitFor(() => firstEvents.some((event) => event.kind === "turn.lifecycle"));
  const running = firstEvents.find((event) => event.kind === "turn.lifecycle");
  assert.equal(running.origin, "local");
  assert.equal(running.spaceName, "Local Mac");
  assert.equal(running.sessionTitle, "Ship Agent Pulse");
  assert.equal(
    requested.find((request) => request.target.endsWith(`/api/spaces/${spaceId}`))
      ?.authorization,
    "Bearer host-access-token",
  );
  const persisted = await loadWatchState(watchStatePath(dataDir));
  assert.equal(persisted.watches[0].spaceName, "Local Mac");
  assert.equal(persisted.watches[0].sessionTitle, "Ship Agent Pulse");
  assert.equal(persisted.watches[0].lastStatus, "running");
  assert.equal(persisted.watches[0].lastObservedAt, runningUpdatedAt);
  assert.equal(persisted.pendingEvents[0].spaceName, "Local Mac");
  assert.equal(persisted.pendingEvents[0].sessionTitle, "Ship Agent Pulse");
  assert.equal(persisted.pendingEvents[0].origin, "local");
  await first.stop();

  const resumedEvents = [];
  let resumedSpaceRequests = 0;
  const resumed = createTurnWatcher({
    dataDir,
    delay: async () => {},
    fetcher: async (url) => {
      const target = String(url);
      if (target.endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (target.includes("/api/spaces/")) {
        resumedSpaceRequests += 1;
        return new Response(null, { status: 503 });
      }
      return Response.json({
        session: { id: sessionId },
        turn: { id: turnId, status: "completed", updatedAt: completedUpdatedAt },
      });
    },
    onEvent: (event) => resumedEvents.push(event),
  });
  await resumed.start();
  await waitFor(
    () => resumedEvents.some((event) => event.kind === "turn.lifecycle" && event.status === "completed"),
  );
  const completed = resumedEvents.find(
    (event) => event.kind === "turn.lifecycle" && event.status === "completed",
  );
  assert.equal(completed.spaceName, "Local Mac");
  assert.equal(completed.sessionTitle, "Ship Agent Pulse");
  assert.equal(completed.origin, "local");
  assert.equal(resumedSpaceRequests, 0);
  await resumed.stop();
});

test("emits a lifecycle fixture accepted by the Relay protocol at database limits", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-protocol-"));
  const events = [];
  const maxScalarName = "😀".repeat(255);
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      delay: () => new Promise((resolve) => setTimeout(resolve, 1)),
      fetcher: async (url) =>
        String(url).endsWith("/api/local-mode/auth")
          ? Response.json({ accessToken: "host-access-token" })
          : Response.json({
              session: { id: sessionId },
              turn: { id: turnId, status: "completed", updatedAt: completedUpdatedAt },
            }),
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(
    watchRecord({
      spaceName: maxScalarName,
      sessionTitle: maxScalarName,
    }),
  );
  await waitFor(() => events.some((event) => event.kind === "turn.lifecycle"));
  const lifecycle = events.find((event) => event.kind === "turn.lifecycle");
  assert.ok(lifecycle);
  const parsed = parseNodeMessage({
    protocolVersion: 2,
    type: "turn-event",
    event: lifecycle,
  });
  assert.equal(parsed.type, "turn-event");
  assert.equal(lifecycle.origin, "local");
  assert.equal(parsed.event.kind, "turn.lifecycle");
  assert.equal(parsed.event.id, lifecycle.id);
});

test("does not record or emit lifecycle state until both display names validate", async (t) => {
  const invalidCases = [
    {
      name: "missing session title",
      firstSessionTitle: null,
      firstSpaceName: "Local Mac",
    },
    {
      name: "session title with a control character",
      firstSessionTitle: "Ship\nAgent Pulse",
      firstSpaceName: "Local Mac",
    },
    {
      name: "space name contains U+2028",
      firstSessionTitle: "Ship Agent Pulse",
      firstSpaceName: "Local\u2028Mac",
    },
    {
      name: "session title exceeds 255 Unicode scalars",
      firstSessionTitle: "汉".repeat(256),
      firstSpaceName: "Local Mac",
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-invalid-name-"));
      const events = [];
      const delays = [];
      let poll = 0;
      try {
        const watcher = createTurnWatcher({
          dataDir,
          delay: (_ms, signal) =>
            new Promise((resolve, reject) => {
              const abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              delays.push(() => {
                signal.removeEventListener("abort", abort);
                resolve();
              });
            }),
          fetcher: async (url) => {
            const target = String(url);
            if (target.endsWith("/api/local-mode/auth")) {
              return Response.json({ accessToken: "host-access-token" });
            }
            if (target.endsWith(`/api/spaces/${spaceId}`)) {
              return Response.json({
                id: spaceId,
                name: poll === 1 ? invalidCase.firstSpaceName : "Local Mac",
              });
            }
            poll += 1;
            return Response.json({
              session: {
                id: sessionId,
                title: poll === 1 ? invalidCase.firstSessionTitle : "Ship Agent Pulse",
              },
              turn: { id: turnId, status: "running", updatedAt: runningUpdatedAt },
            });
          },
          onEvent: (event) => events.push(event),
        });
        await watcher.start();
        await watcher.watch(watchRecord({ spaceName: null, sessionTitle: null }));
        await waitFor(() => delays.length === 1);
        assert.deepEqual(events, []);
        assert.equal(watcher.watches()[0].lastStatus, null);
        assert.equal(watcher.watches()[0].spaceName, null);
        assert.equal(watcher.watches()[0].sessionTitle, null);
        delays.shift()();
        await waitFor(() => events.some((event) => event.kind === "turn.lifecycle"));
        assert.equal(events[0].spaceName, "Local Mac");
        assert.equal(events[0].sessionTitle, "Ship Agent Pulse");
        await watcher.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("requires a real monotonic turn.updatedAt before emitting lifecycle state", async (t) => {
  for (const invalidUpdatedAt of [undefined, "not-a-timestamp"]) {
    await t.test(invalidUpdatedAt === undefined ? "missing" : "invalid", async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-updated-at-"));
      const events = [];
      const logs = [];
      const delays = [];
      let poll = 0;
      try {
        const watcher = createTurnWatcher({
          dataDir,
          delay: (_ms, signal) =>
            new Promise((resolve, reject) => {
              const abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              delays.push(() => {
                signal.removeEventListener("abort", abort);
                resolve();
              });
            }),
          logError: (message) => logs.push(String(message)),
          fetcher: async (url) => {
            if (String(url).endsWith("/api/local-mode/auth")) {
              return Response.json({ accessToken: "host-access-token" });
            }
            poll += 1;
            return Response.json({
              session: { id: sessionId },
              turn: {
                id: turnId,
                status: "running",
                updatedAt: poll === 1 ? invalidUpdatedAt : runningUpdatedAt,
              },
            });
          },
          onEvent: (event) => events.push(event),
        });
        await watcher.start();
        await watcher.watch(watchRecord());
        await waitFor(() => delays.length === 1);
        assert.deepEqual(events, []);
        assert.equal(watcher.watches()[0].lastStatus, null);
        assert.equal(watcher.watches()[0].lastObservedAt, null);
        assert.match(logs[0], /turn\.updatedAt is missing, invalid, or non-monotonic/);
        delays.shift()();
        await waitFor(() => events.some((event) => event.kind === "turn.lifecycle"));
        assert.equal(events[0].observedAt, runningUpdatedAt);
        assert.equal(watcher.watches()[0].lastStatus, "running");
        assert.equal(watcher.watches()[0].lastObservedAt, runningUpdatedAt);
        await watcher.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }

  await t.test("non-monotonic", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-updated-at-"));
    const events = [];
    const logs = [];
    const delays = [];
    let poll = 0;
    const newerUpdatedAt = "2026-08-26T00:00:03.000Z";
    try {
      const watcher = createTurnWatcher({
        dataDir,
        delay: (_ms, signal) =>
          new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            delays.push(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            });
          }),
        logError: (message) => logs.push(String(message)),
        fetcher: async (url) => {
          if (String(url).endsWith("/api/local-mode/auth")) {
            return Response.json({ accessToken: "host-access-token" });
          }
          poll += 1;
          return Response.json({
            session: { id: sessionId },
            turn: {
              id: turnId,
              status: poll === 1 ? "queued" : "running",
              updatedAt:
                poll === 1
                  ? completedUpdatedAt
                  : poll === 2
                    ? runningUpdatedAt
                    : newerUpdatedAt,
            },
          });
        },
        onEvent: (event) => events.push(event),
      });
      await watcher.start();
      await watcher.watch(watchRecord());
      await waitFor(() => events.length === 1 && delays.length === 1);
      assert.equal(events[0].status, "queued");
      assert.equal(events[0].observedAt, completedUpdatedAt);
      delays.shift()();
      await waitFor(() => logs.length === 1 && delays.length === 1);
      assert.equal(events.length, 1);
      assert.equal(watcher.watches()[0].lastStatus, "queued");
      assert.equal(watcher.watches()[0].lastObservedAt, completedUpdatedAt);
      delays.shift()();
      await waitFor(() => events.length === 2);
      assert.equal(events[1].status, "running");
      assert.equal(events[1].observedAt, newerUpdatedAt);
      await watcher.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("watch surfaces the original persistence failure and leaves no phantom watch", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-write-"));
  const failure = new Error("disk is read-only");
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      persistState: async () => {
        throw failure;
      },
    }),
  );
  await watcher.start();
  await assert.rejects(() => watcher.watch(watchRecord()), (error) => error === failure);
  assert.deepEqual(watcher.watches(), []);
});

test("retries a polled lifecycle after the second persistence write fails", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-retry-"));
  const failure = new Error("transient lifecycle write failed");
  const events = [];
  let writes = 0;
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      delay: () => new Promise((resolve) => setTimeout(resolve, 1)),
      persistState: async (path, value) => {
        writes += 1;
        if (writes === 2) throw failure;
        await atomicWriteJson(path, value);
      },
      fetcher: async (url) =>
        String(url).endsWith("/api/local-mode/auth")
          ? Response.json({ accessToken: "host-access-token" })
          : Response.json({
              session: { id: sessionId },
              turn: { id: turnId, status: "running", updatedAt: runningUpdatedAt },
            }),
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => events.some((event) => event.kind === "turn.lifecycle"));
  assert.ok(writes >= 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "running");
  assert.equal(watcher.watches()[0].lastStatus, "running");
  assert.equal(watcher.pendingEvents()[0].id, events[0].id);
});

test("retries terminal finish persistence failures without losing the watch", async (t) => {
  for (const failureWrite of [3, 4]) {
    await t.test(`write ${failureWrite}`, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-terminal-retry-"));
      const events = [];
      let writes = 0;
      try {
        const watcher = createTurnWatcher({
          dataDir,
          delay: async () => {},
          persistState: async (path, value) => {
            writes += 1;
            if (writes === failureWrite) {
              throw new Error(`transient terminal write ${failureWrite} failed`);
            }
            await atomicWriteJson(path, value);
          },
          fetcher: async (url) =>
            String(url).endsWith("/api/local-mode/auth")
              ? Response.json({ accessToken: "host-access-token" })
              : Response.json({
                  session: { id: sessionId },
                  turn: {
                    id: turnId,
                    status: "completed",
                    updatedAt: completedUpdatedAt,
                    assistantText: "done",
                  },
                }),
          onEvent: (event) => events.push(event),
        });
        await watcher.start();
        await watcher.watch(watchRecord());
        await waitFor(
          () =>
            watcher.watches().length === 0 &&
            events.some((event) => event.kind === "turn.completed"),
        );
        assert.ok(writes > failureWrite);
        assert.equal(
          events.filter((event) => event.kind === "turn.completed").length,
          1,
        );
        assert.equal(
          events.filter(
            (event) => event.kind === "turn.lifecycle" && event.status === "completed",
          ).length,
          1,
        );
        assert.equal(
          watcher.pendingEvents().filter((event) => event.kind === "turn.completed").length,
          1,
        );
        await watcher.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("ack surfaces persistence failure and keeps the pending event retryable", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-write-"));
  const pending = {
    id: eventId,
    kind: "turn.completed",
    spaceId,
    sessionId,
    turnId,
    completedAt: "2026-08-26T00:00:01.000Z",
    turn: null,
    truncated: true,
  };
  await atomicWriteJson(watchStatePath(dataDir), {
    watches: [],
    pendingEvents: [pending],
  });
  const failure = new Error("ack write failed");
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      persistState: async () => {
        throw failure;
      },
    }),
  );
  await watcher.start();
  await assert.rejects(() => watcher.ack(eventId), (error) => error === failure);
  assert.deepEqual(watcher.pendingEvents(), [pending]);
});

test("pending lifecycle replay preserves the required local origin", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-replay-"));
  const replayed = [];
  const pending = {
    id: eventId,
    kind: "turn.lifecycle",
    origin: "local",
    nodeId: "mac-mini",
    spaceId,
    sessionId,
    turnId,
    status: "running",
    observedAt: runningUpdatedAt,
    spaceName: "Local Mac",
    sessionTitle: "Ship Agent Pulse",
  };
  await atomicWriteJson(watchStatePath(dataDir), {
    watches: [],
    pendingEvents: [pending],
  });
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      onEvent: (event) => replayed.push(event),
    }),
  );
  await watcher.start();
  watcher.flushPending();
  assert.deepEqual(replayed, [pending]);
  assert.equal(replayed[0].origin, "local");
  assert.deepEqual(watcher.pendingEvents(), [pending]);
});

test("resumes unfinished watches and unacked events from disk", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const events = [];
  await atomicWriteJson(watchStatePath(dataDir), {
    watches: [watchRecord()],
    pendingEvents: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "turn.completed",
        spaceId,
        sessionId,
        turnId,
        completedAt: "2026-08-26T00:00:01.000Z",
        turn: null,
        truncated: true,
      },
    ],
  });
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      delay: async () => {},
      fetcher: async (url) => {
        if (String(url).endsWith("/api/local-mode/auth")) {
          return Response.json({ accessToken: "host-access-token" });
        }
        return Response.json({
          session: { id: sessionId },
          turn: {
            id: turnId,
            status: "completed",
            updatedAt: completedUpdatedAt,
            assistantText: "restored",
          },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  assert.equal(watcher.pendingEvents().length, 1);
  watcher.flushPending();
  await waitFor(
    () => events.some((item) => item.id === eventId) && watcher.watches().length === 0,
  );
  const completed = events.find((item) => item.id === eventId);
  assert.equal(completed.truncated, false);
  assert.equal(completed.turn.turn.assistantText, "restored");
  await watcher.ack(eventId);
  await watcher.ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  for (const pending of watcher.pendingEvents()) await watcher.ack(pending.id);
  assert.equal(watcher.pendingEvents().length, 0);
  assert.deepEqual((await loadWatchState(watchStatePath(dataDir))).watches, []);
});

test("watch timeout never fabricates a completed turn", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const events = [];
  let nowMs = 0;
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      now: () => nowMs,
      timeoutMs: 10,
      fastMs: 10,
      slowMs: 10,
      delay: async (ms) => {
        nowMs += ms;
      },
      fetcher: async (url) => {
        if (String(url).endsWith("/api/local-mode/auth")) {
          return Response.json({ accessToken: "host-access-token" });
        }
        return Response.json({
          session: { id: sessionId },
          turn: { id: turnId, status: "running", updatedAt: runningUpdatedAt },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord({ startedAt: new Date(0).toISOString() }));
  await waitFor(() => watcher.watches().length === 0);
  assert.equal(completedEvent(events), undefined);
  assert.equal(events.at(-1)?.kind, "turn.lifecycle");
  assert.equal(events.at(-1)?.status, "running");
  assert.deepEqual(watcher.watches(), []);
});

test("a null turn never becomes a completed event", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const events = [];
  let nowMs = 0;
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      now: () => nowMs,
      timeoutMs: 10,
      fastMs: 10,
      slowMs: 10,
      delay: async (ms) => {
        nowMs += ms;
      },
      fetcher: async (url) =>
        String(url).endsWith("/api/local-mode/auth")
          ? Response.json({ accessToken: "host-access-token" })
          : Response.json({ session: { id: sessionId }, turn: null }),
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord({ startedAt: new Date(0).toISOString() }));
  await waitFor(() => watcher.watches().length === 0);
  assert.equal(events.length, 0);
});

test("relays assistant-linked files when the watched turn completes", async (t) => {
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const workspaceRoot = join(spaceStorageRoot, spaceId, "workspace");
  await mkdir(join(workspaceRoot, "output"), { recursive: true });
  await writeFile(join(workspaceRoot, "output", "report.txt"), "returned artifact bytes", "utf8");
  const attachmentId = "a6d6ae8f-205b-4e91-bdc4-e46f818ad505";
  let uploaded = Buffer.alloc(0);
  let persistedProjection = null;
  const events = [];
  const watcher = trackWatcher(
    t,
    spaceStorageRoot,
    createTurnWatcher({
    dataDir: spaceStorageRoot,
    spaceStorageRoot,
    relayNodeBaseUrl: "https://relay.example/v1/nodes/mac-mini",
    relayNodeToken: "node-secret",
    maxAttachmentBytes: 1024 * 1024,
    nodeId: "mac-mini",
    delay: async () => {},
    fetcher: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (target.includes("/api/sessions/") && target.includes("/turns/")) {
        return Response.json({
          session: { id: sessionId },
          turn: {
            id: turnId,
            status: "completed",
            updatedAt: completedUpdatedAt,
            assistantText: "Download [report](output/report.txt)",
            assistantContent: [
              { type: "text", text: "Download [report](output/report.txt)" },
            ],
            summary: { text: "Download [report](output/report.txt)" },
          },
        });
      }
      if (target.endsWith("/attachments")) {
        const planned = JSON.parse(init.body);
        assert.equal(planned.name, "report.txt");
        assert.equal(planned.size, 23);
        assert.equal(planned.contentType, "text/plain");
        assert.match(planned.sha256, /^[0-9a-f]{64}$/);
        return Response.json({
          attachment: { id: attachmentId, nodeId: "mac-mini" },
          upload: {
            url: `https://relay.example/v1/nodes/mac-mini/attachments/${attachmentId}/content?uploadToken=one-use`,
          },
        });
      }
      if (target.includes(`/attachments/${attachmentId}/content`)) {
        const chunks = [];
        for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return Response.json({ ok: true });
      }
      if (target.endsWith("/api/local-mode/relay-artifacts")) {
        persistedProjection = JSON.parse(init.body);
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fetch ${target}`);
    },
    onEvent: (event) => events.push(event),
  }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => completedEvent(events) && watcher.watches().length === 0);
  const completed = completedEvent(events);
  assert.ok(completed);
  const relayPath = `/relay/v1/nodes/mac-mini/attachments/${attachmentId}/content`;
  assert.equal(uploaded.toString("utf8"), "returned artifact bytes");
  assert.equal(completed.truncated, false);
  assert.equal(completed.turn.turn.assistantText, `Download [report](${relayPath})`);
  assert.equal(completed.turn.turn.assistantContent[0].text, `Download [report](${relayPath})`);
  assert.equal(completed.turn.turn.summary.text, `Download [report](${relayPath})`);
  assert.deepEqual(persistedProjection, {
    sessionId,
    turnId,
    replacements: [{ from: "output/report.txt", to: relayPath }],
  });
  assert.doesNotMatch(JSON.stringify(completed), new RegExp(workspaceRoot));
});

test("does not relay assistant links outside the Space workspace", async (t) => {
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  await mkdir(join(spaceStorageRoot, spaceId, "workspace"), { recursive: true });
  const events = [];
  let extraCalls = 0;
  const watcher = trackWatcher(
    t,
    spaceStorageRoot,
    createTurnWatcher({
      dataDir: spaceStorageRoot,
      spaceStorageRoot,
      relayNodeBaseUrl: "https://relay.example/v1/nodes/mac-mini",
      relayNodeToken: "node-secret",
      maxAttachmentBytes: 1024 * 1024,
      delay: async () => {},
      fetcher: async (url) => {
        const target = String(url);
        if (target.endsWith("/api/local-mode/auth")) {
          return Response.json({ accessToken: "host-access-token" });
        }
        if (target.includes("/api/sessions/") && target.includes("/turns/")) {
          return Response.json({
            session: { id: sessionId },
            turn: {
              id: turnId,
              status: "completed",
              updatedAt: completedUpdatedAt,
              assistantText: "Do not export [secret](/etc/passwd)",
            },
          });
        }
        extraCalls += 1;
        throw new Error(`Unexpected fetch ${target}`);
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => completedEvent(events) && watcher.watches().length === 0);
  const completed = completedEvent(events);
  assert.ok(completed);
  assert.equal(extraCalls, 0);
  assert.match(completed.turn.turn.assistantText, /\[secret\]\(\/etc\/passwd\)/);
});

test("restores inbound attachment URIs and drops an oversized completed turn", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const localPath = "/tmp/cohub-relay-node-/note.txt";
  const relayUrl = "/relay/v1/nodes/mac-mini/attachments/669526bb-bf65-4013-a825-4f61adf199f8/content";
  const events = [];
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      delay: async () => {},
      fetcher: async (url) => {
        if (String(url).endsWith("/api/local-mode/auth")) {
          return Response.json({ accessToken: "host-access-token" });
        }
        return Response.json({
          session: { id: sessionId },
          turn: {
            id: turnId,
            status: "completed",
            updatedAt: completedUpdatedAt,
            userContent: [{ type: "text", text: localPath }],
            blob: "x".repeat(TURN_PAYLOAD_MAX_BYTES),
          },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(
    watchRecord({
      responseReplacements: [[localPath, relayUrl]],
    }),
  );
  await waitFor(() => completedEvent(events) && watcher.watches().length === 0);
  const completed = completedEvent(events);
  assert.ok(completed);
  assert.equal(completed.turn, null);
  assert.equal(completed.truncated, true);
});

test("survives transient auth failures instead of crashing the watch", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const events = [];
  let authCalls = 0;
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      delay: async () => {},
      fetcher: async (url) => {
        if (String(url).endsWith("/api/local-mode/auth")) {
          authCalls += 1;
          if (authCalls === 1) throw new Error("local API is down");
          return Response.json({ accessToken: "host-access-token" });
        }
        return Response.json({
          session: { id: sessionId },
          turn: {
            id: turnId,
            status: "completed",
            updatedAt: completedUpdatedAt,
            assistantText: "recovered",
          },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => completedEvent(events) && watcher.watches().length === 0);
  const completed = completedEvent(events);
  assert.ok(completed);
  assert.ok(authCalls >= 2);
  assert.equal(completed.turn.turn.assistantText, "recovered");
});

test("rejects corrupt persisted state without overwriting the evidence", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  await mkdir(dataDir, { recursive: true });
  await writeFile(watchStatePath(dataDir), "not json", "utf8");
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({ dataDir, delay: async () => {} }),
  );
  await assert.rejects(() => watcher.start(), SyntaxError);
  assert.equal(await readFile(watchStatePath(dataDir), "utf8"), "not json");
});

test("watches a running turn until it completes without uploading artifacts", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  const events = [];
  let polls = 0;
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({
      dataDir,
      delay: async () => {},
      fetcher: async (url) => {
        if (String(url).endsWith("/api/local-mode/auth")) {
          return Response.json({ accessToken: "host-access-token" });
        }
        polls += 1;
        return Response.json({
          session: { id: sessionId },
          turn: {
            id: turnId,
            status: polls < 2 ? "running" : "completed",
            updatedAt: polls < 2 ? runningUpdatedAt : completedUpdatedAt,
            assistantText: "done",
          },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => completedEvent(events) && watcher.watches().length === 0);
  const completed = completedEvent(events);
  assert.ok(completed);
  assert.ok(polls >= 2);
  assert.equal(completed.truncated, false);
  assert.equal(completed.turn.turn.assistantText, "done");
});
