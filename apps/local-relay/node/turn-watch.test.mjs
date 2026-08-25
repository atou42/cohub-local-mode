import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  createTurnWatcher,
  isWatchTimedOut,
  loadWatchState,
  pollIntervalMs,
  TURN_PAYLOAD_MAX_BYTES,
  truncateTurnPayload,
  watchStatePath,
} from "./turn-watch.mjs";

const spaceId = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";
const sessionId = "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02";
const turnId = "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01";
const eventId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";

function watchRecord(overrides = {}) {
  return {
    eventId,
    spaceId,
    sessionId,
    turnId,
    responseReplacements: [],
    nodeId: "mac-mini",
    startedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
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
  assert.deepEqual(await loadWatchState(path), stored);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), stored);
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
          turn: { id: turnId, status: "completed", assistantText: "restored" },
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
  assert.equal(watcher.pendingEvents().length, 0);
  assert.deepEqual((await loadWatchState(watchStatePath(dataDir))).watches, []);
});

test("emits a truncated timeout event after the watch budget", async (t) => {
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
          turn: { id: turnId, status: "running" },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord({ startedAt: new Date(0).toISOString() }));
  await waitFor(() => events.length === 1 && watcher.watches().length === 0);
  assert.equal(events[0].kind, "turn.completed");
  assert.equal(events[0].turn, null);
  assert.equal(events[0].truncated, true);
  assert.deepEqual(watcher.watches(), []);
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
  await waitFor(() => events.length === 1 && watcher.watches().length === 0);
  const relayPath = `/relay/v1/nodes/mac-mini/attachments/${attachmentId}/content`;
  assert.equal(uploaded.toString("utf8"), "returned artifact bytes");
  assert.equal(events[0].truncated, false);
  assert.equal(events[0].turn.turn.assistantText, `Download [report](${relayPath})`);
  assert.equal(events[0].turn.turn.assistantContent[0].text, `Download [report](${relayPath})`);
  assert.equal(events[0].turn.turn.summary.text, `Download [report](${relayPath})`);
  assert.deepEqual(persistedProjection, {
    sessionId,
    turnId,
    replacements: [{ from: "output/report.txt", to: relayPath }],
  });
  assert.doesNotMatch(JSON.stringify(events[0]), new RegExp(workspaceRoot));
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
  await waitFor(() => events.length === 1 && watcher.watches().length === 0);
  assert.equal(extraCalls, 0);
  assert.match(events[0].turn.turn.assistantText, /\[secret\]\(\/etc\/passwd\)/);
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
  await waitFor(() => events.length === 1 && watcher.watches().length === 0);
  assert.equal(events[0].turn, null);
  assert.equal(events[0].truncated, true);
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
          turn: { id: turnId, status: "completed", assistantText: "recovered" },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => events.length === 1 && watcher.watches().length === 0);
  assert.ok(authCalls >= 2);
  assert.equal(events[0].turn.turn.assistantText, "recovered");
});

test("starts with empty state when the persisted file is corrupt", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-watch-"));
  await mkdir(dataDir, { recursive: true });
  await writeFile(watchStatePath(dataDir), "not json", "utf8");
  const watcher = trackWatcher(
    t,
    dataDir,
    createTurnWatcher({ dataDir, delay: async () => {} }),
  );
  await watcher.start();
  assert.deepEqual(watcher.watches(), []);
  assert.deepEqual(watcher.pendingEvents(), []);
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
            assistantText: "done",
          },
        });
      },
      onEvent: (event) => events.push(event),
    }),
  );
  await watcher.start();
  await watcher.watch(watchRecord());
  await waitFor(() => events.length === 1 && watcher.watches().length === 0);
  assert.ok(polls >= 2);
  assert.equal(events[0].truncated, false);
  assert.equal(events[0].turn.turn.assistantText, "done");
});
