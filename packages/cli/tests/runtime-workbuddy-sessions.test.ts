import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { NativeSessions } from "../src/runtime/native/sessions.js";
import type { NativeIngest, TranscriptState } from "../src/runtime/native/ingest.js";
import type { RuntimeArchiveStore } from "../src/runtime/archive-store.js";
import { runtimeProjectionSource } from "./fixtures/runtime-projection-source.js";
import { workbuddySessionPath } from "../src/runtime/native/workbuddy-transcript.js";
import { assertWorkBuddySessionAvailable, workbuddySidecarPath } from "../src/runtime/native/workbuddy-ownership.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-sessions-"));
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = join(root, "workbuddy");
  const spaceId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), priorTurnId = randomUUID();
  const source = runtimeProjectionSource();
  const adopted: unknown[][] = [];
  let existing: TranscriptState | null = null;
  const archives = { restore: async (_reference: unknown, _path: string) => { throw new Error("unexpected restore"); } };
  const ingest = { transcriptFor: () => existing, adopt: (...args: unknown[]) => adopted.push(args) };
  const sessions = new NativeSessions({ root, spaceId, projectionSource: source, archives: archives as unknown as RuntimeArchiveStore, ingest: ingest as unknown as NativeIngest });
  const input = { sessionId, turnId, harness: "workbuddy" as const, cwd: root, context: { revision: "r", throughTurnId: null as string | null, messages: [] }, resumable: () => true };
  return { root, home: process.env.WORKBUDDY_HOME, spaceId, sessionId, turnId, priorTurnId, source, sessions, archives, adopted, input,
    setExisting(value: TranscriptState | null) { existing = value; },
    async close() { if (previous === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = previous; await rm(root, { recursive: true, force: true }); },
  };
}

async function nativeSource(w: Awaited<ReturnType<typeof fixture>>) {
  const nativeSessionId = randomUUID(), path = workbuddySessionPath(w.home, w.root, nativeSessionId), id = randomUUID();
  const original = `${JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "history" }], id, parentId: null, sessionId: nativeSessionId, cwd: w.root, timestamp: "2026-10-12T00:00:00.000Z", cohub: { schema: "cohub.projection.v2", sessionId: w.sessionId, turnId: w.priorTurnId } })}\n`;
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, original);
  const state = { harness: "workbuddy", nativeSessionId, path, cwd: w.root, sessionId: w.sessionId, headTurnId: w.priorTurnId } as TranscriptState;
  w.setExisting(state); w.input.context.throughTurnId = w.priorTurnId;
  return { nativeSessionId, path, original };
}

test("WorkBuddy new turns reserve independent identities without creating fake history", async () => {
  const w = await fixture();
  try {
    const first = await w.sessions.prepare(w.input), second = await w.sessions.prepare({ ...w.input, turnId: randomUUID() });
    assert.equal(first.resume, "new");
    assert.notEqual(first.session.nativeSessionId, second.session.nativeSessionId);
    assert.equal(first.session.path, workbuddySessionPath(w.home, w.root, first.session.nativeSessionId));
    await assert.rejects(stat(first.session.path), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(`${first.session.path}.cohub.json`, "utf8")), { nativeSessionId: first.session.nativeSessionId, cloudSessionId: w.sessionId, turnId: w.turnId, prefixBytes: 0, prefixSha256: sha256("") });
    assert.deepEqual(w.adopted[0], [first.session, w.sessionId]);
  } finally { await w.close(); }
});

test("WorkBuddy projection binds the actual written history prefix to the new turn", async () => {
  const w = await fixture();
  try {
    w.source.addTurn(w.sessionId, w.priorTurnId, { userContent: [{ type: "text", text: "old user" }], assistantContent: [{ type: "text", text: "old answer" }] });
    w.input.context.throughTurnId = w.priorTurnId;
    const result = await w.sessions.prepare(w.input), bytes = await readFile(result.session.path);
    assert.equal(result.resume, "handoff");
    assert(bytes.toString().includes("old answer"));
    const rows = bytes.toString().trim().split("\n").map((line) => JSON.parse(line));
    assert(rows.every((row) => row.sessionId === result.session.nativeSessionId && row.type === "message"));
    assert.deepEqual(JSON.parse(await readFile(`${result.session.path}.cohub.json`, "utf8")), { nativeSessionId: result.session.nativeSessionId, cloudSessionId: w.sessionId, turnId: w.turnId, prefixBytes: bytes.length, prefixSha256: sha256(bytes) });
    assert.deepEqual(w.adopted[0], [result.session, w.sessionId]);
  } finally { await w.close(); }
});

test("WorkBuddy continuation copies history and never modifies the user's file", async () => {
  const w = await fixture();
  try {
    const original = await nativeSource(w), result = await w.sessions.prepare(w.input);
    assert.equal(result.resume, "native");
    assert.notEqual(result.session.path, original.path);
    assert.notEqual(result.session.nativeSessionId, original.nativeSessionId);
    assert.equal(await readFile(original.path, "utf8"), original.original);
    const bytes = await readFile(result.session.path), row = JSON.parse(bytes.toString());
    assert.equal(row.sessionId, result.session.nativeSessionId);
    assert.deepEqual(row.content, [{ type: "input_text", text: "history" }]);
    const origin = JSON.parse(await readFile(`${result.session.path}.cohub.json`, "utf8"));
    assert.equal(origin.prefixSha256, sha256(bytes)); assert.equal(origin.prefixBytes, bytes.length);
  } finally { await w.close(); }
});

test("WorkBuddy rejects history appended after the cached cloud head even when the source is now idle", async () => {
  const w = await fixture();
  try {
    const original = await nativeSource(w), first = JSON.parse(original.original);
    const unseen = { ...first, id: randomUUID(), parentId: first.id, content: [{ type: "input_text", text: "not yet synchronized" }] };
    delete unseen.cohub;
    await appendFile(original.path, `${JSON.stringify(unseen)}\n`);
    const bytes = await readFile(original.path);
    await assert.rejects(w.sessions.prepare(w.input), /WorkBuddy source history does not match the Session head/);
    assert.deepEqual(await readFile(original.path), bytes, "rejecting stale history never rewrites the user's transcript");
    assert.deepEqual(w.adopted, [], "unseen history must not become a hidden execution prefix");
  } finally { await w.close(); }
});

test("WorkBuddy continues an aligned imported native turn without Cohub metadata", async () => {
  const w = await fixture();
  try {
    const original = await nativeSource(w), row = JSON.parse(original.original);
    delete row.cohub;
    const bytes = `${JSON.stringify(row)}\n`;
    await writeFile(original.path, bytes);
    const headTurnId = nativeTurnId(w.spaceId, "workbuddy", original.nativeSessionId, row.id);
    w.input.context.throughTurnId = headTurnId;
    w.setExisting({ harness: "workbuddy", nativeSessionId: original.nativeSessionId, path: original.path, cwd: w.root, sessionId: w.sessionId, headTurnId } as TranscriptState);
    const result = await w.sessions.prepare(w.input);
    assert.equal(result.resume, "native");
    assert.notEqual(result.session.path, original.path);
    assert.equal(await readFile(original.path, "utf8"), bytes);
    assert.deepEqual(JSON.parse(await readFile(result.session.path, "utf8")).content, row.content);
  } finally { await w.close(); }
});

test("WorkBuddy refuses an occupied native session without touching its file", async () => {
  const w = await fixture();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const original = await nativeSource(w), path = await workbuddySidecarPath(w.home);
    await mkdir(dirname(path), { recursive: true });
    const activeServer = createServer((socket) => socket.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString());
      assert.equal(request.method, "session.list");
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [{ sessionId: original.nativeSessionId }] })}\n`);
    }));
    server = activeServer;
    await new Promise<void>((resolve, reject) => { activeServer.once("error", reject); activeServer.listen(path, resolve); });
    await assert.rejects(w.sessions.prepare(w.input), /Close (?:the )?WorkBuddy session before continuing/i);
    assert.equal(await readFile(original.path, "utf8"), original.original);
    assert.deepEqual(w.adopted, []);
  } finally { const activeServer = server; if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve())); await w.close(); }
});

test("WorkBuddy corrupt archives surface the error and retain evidence without projection fallback", async () => {
  const w = await fixture();
  try {
    let raw = "";
    w.archives.restore = async (_reference: unknown, path: string) => {
      raw = path; await mkdir(dirname(raw), { recursive: true }); await writeFile(raw, "{broken\n");
      return { nativeSessionId: randomUUID() } as never;
    };
    const archive = { harness: "workbuddy" as const, sessionId: w.sessionId, turnId: w.priorTurnId };
    await assert.rejects(w.sessions.prepare({ ...w.input, context: { ...w.input.context, throughTurnId: w.priorTurnId, archive } }), /JSON|Unexpected|property|WorkBuddy/i);
    assert.equal(await readFile(raw, "utf8"), "{broken\n");
    assert.deepEqual(w.adopted, []);
  } finally { await w.close(); }
});

test("WorkBuddy unsupported projected content fails before creating an execution", async () => {
  const w = await fixture();
  try {
    w.source.addTurn(w.sessionId, w.priorTurnId, { userContent: [{ type: "image", source: { type: "url", url: "https://example.invalid/image.png" } }] });
    w.input.context.throughTurnId = w.priorTurnId;
    await assert.rejects(w.sessions.prepare(w.input), /WorkBuddy.*projection.*external image/i);
    assert.deepEqual(w.adopted, []);
  } finally { await w.close(); }
});

test("WorkBuddy valid archive restoration keeps the source identity out of the working copy", async () => {
  const w = await fixture();
  try {
    const original = await nativeSource(w);
    // Offer archive history, not the locally discovered file.
    w.setExisting(null);
    w.archives.restore = async (_reference: unknown, path: string) => {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, original.original);
      return { nativeSessionId: original.nativeSessionId } as never;
    };
    const archive = { harness: "workbuddy" as const, sessionId: w.sessionId, turnId: w.priorTurnId };
    const result = await w.sessions.prepare({ ...w.input, context: { ...w.input.context, archive } });
    assert.equal(result.resume, "restored");
    const row = JSON.parse(await readFile(result.session.path, "utf8"));
    assert.equal(row.sessionId, result.session.nativeSessionId);
    assert.notEqual(row.sessionId, original.nativeSessionId);
    assert.equal(await readFile(original.path, "utf8"), original.original);
    assert.deepEqual(w.adopted, [[result.session, w.sessionId]]);
  } finally { await w.close(); }
});

test("WorkBuddy ownership errors and timeouts never become an available session", async () => {
  const w = await fixture();
  try {
    const path = await workbuddySidecarPath(w.home);
    await mkdir(dirname(path), { recursive: true });
    for (const reply of ["{broken\n", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`, null]) {
      const server = createServer((socket) => socket.once("data", () => { if (reply !== null) socket.end(reply); }));
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
      try {
        await assert.rejects(assertWorkBuddySessionAvailable(randomUUID(), { home: w.home, timeoutMs: 50 }), reply === null ? /timed out/ : /JSON|Unexpected|property|Invalid/i);
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
    await writeFile(path, "broken socket", { flag: "wx" });
    try { await assert.rejects(assertWorkBuddySessionAvailable(randomUUID(), { home: w.home }), (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" || error.code === "ENOTSOCK"); }
    finally { await rm(path); }
  } finally { await w.close(); }
});
