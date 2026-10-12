import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readNativeTranscript, readNativeTranscriptHeader } from "../src/runtime/native/transcript.js";
import { importNativeArchive } from "../src/runtime/native/archive.js";
import { nativeTurnId } from "../src/runtime/native/identity.js";
import { acceptsTranscript, readSessionHeader, transcriptRoots, readTranscript } from "../src/runtime/native/adapters.js";
import { projectNativeSession, serializeProjection, type CanonicalProjectionMessage } from "../../protocol/src/runtime/projection.js";
import { workbuddySessionPath } from "../src/runtime/native/workbuddy-transcript.js";

const at = "2026-10-12T00:00:00.000Z";
const jsonl = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-transcript-"));
  const sessionId = randomUUID();
  const path = join(root, `${sessionId}.jsonl`);
  const row = (id: string, parentId: string | null, type: string, rest: Record<string, unknown> = {}) => ({ id, parentId, type, sessionId, cwd: root, timestamp: at, ...rest });
  return { root, sessionId, path, row, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("WorkBuddy reads top-level messages, tools, reasoning, usage and exact byte receipts", async () => {
  const f = await fixture();
  try {
    const raw = jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "你好" }] }),
      f.row("r1", "u1", "reasoning", { content: [], rawContent: [{ type: "reasoning_text", text: "think" }] }),
      f.row("c1", "r1", "function_call", { name: "bash", arguments: '{"command":"pwd"}', callId: "call" }),
      f.row("t1", "c1", "function_call_result", { name: "bash", output: { type: "input_text", text: "ok" }, callId: "call", status: "completed" }),
      f.row("a1", "t1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }], message: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cache_read_input_tokens: 2 } } }),
    ]);
    await writeFile(f.path, `${raw}{"partial":`);
    assert.equal((await readNativeTranscript(f.path, "workbuddy")).turns[0]?.result, null);
    const transcript = await readNativeTranscript(f.path, "workbuddy", { settled: true });
    assert.equal(transcript.nativeSessionId, f.sessionId);
    assert.equal(transcript.cwd, f.root);
    const turn = transcript.turns[0];
    assert(turn);
    assert.deepEqual(turn.userContent, [{ type: "text", text: "你好" }]);
    assert.deepEqual(turn.messages.flatMap((message) => message.content.map((block) => block.type)), ["thinking", "tool_use", "tool_result", "text"]);
    assert.equal(turn.result?.status, "completed");
    assert.equal(turn.messages.at(-1)?.usage?.cacheRead, 2);
    assert.equal(turn.endBytes, Buffer.byteLength(raw));
    assert.equal(turn.sha256, createHash("sha256").update(raw).digest("hex"));
    assert.equal(transcript.prefixes.get(turn.endBytes), turn.sha256);
    assert.deepEqual(await readNativeTranscriptHeader(f.path, "workbuddy"), { nativeSessionId: f.sessionId, cwd: f.root });
    assert.equal((await readSessionHeader(f.path, "workbuddy"))?.harness, "workbuddy");
    assert.equal(acceptsTranscript(f.path, "workbuddy", f.root), true);
    const root = transcriptRoots("workbuddy")[0];
    assert(root);
    assert.match(root, /workbuddy\/projects$/);
  } finally { await f.cleanup(); }
});

test("WorkBuddy applies persisted message updates exactly once and retains the latest status", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "q" }] }),
      f.row("a1", "u1", "message", { role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "par" }] }),
      f.row("a1", "u1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "complete" }] }),
      { type: "ai-title", aiTitle: "Title" },
    ]));
    const turn = (await readNativeTranscript(f.path, "workbuddy", { settled: true })).turns[0];
    assert(turn);
    assert.deepEqual(turn.messages.map((message) => message.content), [[{ type: "text", text: "complete" }]]);
    assert.equal(turn.result?.status, "completed");
    assert.equal(turn.endBytes, (await readFile(f.path)).length, "metadata must remain in the archived byte range");
    assert.ok(turn.contentEndBytes < turn.endBytes, "title metadata must not move the content boundary");
  } finally { await f.cleanup(); }
});

test("WorkBuddy resolves images only inside its blob root and rejects missing or escaping attachments", async () => {
  const f = await fixture();
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = f.root;
  try {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const id = createHash("sha256").update(bytes).digest("hex");
    const blob = join(f.root, "blobs", id.slice(0, 2), `${id}.png`);
    await mkdir(join(f.root, "blobs", id.slice(0, 2)), { recursive: true });
    await writeFile(blob, bytes);
    const block = { type: "image_blob_ref", blob_id: id, blob_path: blob, mime: "image/png", size: bytes.length, original_filename: "image.png" };
    const write = async (image: unknown) => writeFile(f.path, jsonl([f.row("u1", null, "message", { role: "user", content: [image] })]));
    await write(block);
    assert.deepEqual((await readNativeTranscript(f.path, "workbuddy")).turns[0]?.userContent, [{ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }]);
    const target = join(f.root, "restored-image.jsonl");
    await importNativeArchive({ source: f.path, target, harness: "workbuddy", nativeSessionId: f.sessionId, id: randomUUID(), cwd: f.root });
    assert.equal((await readNativeTranscript(target, "workbuddy")).turns[0]?.userContent[0]?.type, "image");
    await write({ ...block, size: bytes.length + 1 });
    await assert.rejects(readNativeTranscript(f.path, "workbuddy"), /size/i);
    const outside = join(f.root, "outside.png");
    await writeFile(outside, bytes);
    await rm(blob);
    await symlink(outside, blob);
    await write(block);
    await assert.rejects(readNativeTranscript(f.path, "workbuddy"), /blob root/i);
    await rm(blob);
    await assert.rejects(importNativeArchive({ source: f.path, target: join(f.root, "missing.jsonl"), harness: "workbuddy", nativeSessionId: f.sessionId, id: randomUUID(), cwd: f.root }), /ENOENT|attachment/i);
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = previous;
    await f.cleanup();
  }
});

test("WorkBuddy preserves branches and never declares an unresolved tool successful", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "one" }] }),
      f.row("a1", "u1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer" }] }),
      f.row("u2", "a1", "message", { role: "user", content: [{ type: "input_text", text: "old branch" }] }),
      f.row("u3", "a1", "message", { role: "user", content: [{ type: "input_text", text: "new branch" }] }),
      f.row("c1", "u3", "function_call", { name: "bash", arguments: "{}", callId: "call" }),
    ]));
    const parsed = await readNativeTranscript(f.path, "workbuddy", { settled: true });
    assert.deepEqual(parsed.turns.map((turn) => [turn.key, turn.parentKey]), [["u1", null], ["u2", "u1"], ["u3", "u1"]]);
    assert.equal(parsed.turns.at(-1)?.result?.status, "interrupted");
    assert.notEqual(nativeTurnId("space", "workbuddy", "session-1", "turn"), nativeTurnId("space", "workbuddy", "session-2", "turn"));
    assert.notEqual(nativeTurnId("space", "workbuddy", "session-1", "turn"), nativeTurnId("space", "pi", "session-1", "turn"));
  } finally { await f.cleanup(); }
});

test("WorkBuddy rejects assistant records without an explicit status", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "q" }] }),
      f.row("a1", "u1", "message", { role: "assistant", content: [{ type: "output_text", text: "not declared complete" }] }),
    ]));
    await assert.rejects(readNativeTranscript(f.path, "workbuddy", { settled: true }), /assistant status/i);
  } finally { await f.cleanup(); }
});

test("WorkBuddy rejects corrupt content and missing history instead of importing empty messages", async () => {
  const f = await fixture();
  try {
    for (const row of [
      f.row("u1", null, "message", { role: "user", content: [{ type: "unknown", text: "not disposable" }] }),
      f.row("u1", "missing", "message", { role: "user", content: [{ type: "input_text", text: "q" }] }),
      f.row("u1", null, "message", { role: "user", content: "bad" }),
    ]) {
      await writeFile(f.path, jsonl([row]));
      await assert.rejects(readNativeTranscript(f.path, "workbuddy"), /WorkBuddy/);
    }
  } finally { await f.cleanup(); }
});

test("WorkBuddy native incomplete tool output is an error result, not an unresolved call", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, jsonl([
      f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "q" }] }),
      f.row("c1", "u1", "function_call", { name: "bash", arguments: "{}", callId: "call" }),
      f.row("t1", "c1", "function_call_result", { name: "bash", output: { type: "input_text", text: "denied" }, callId: "call", status: "incomplete" }),
      f.row("a1", "t1", "message", { role: "assistant", content: [{ type: "output_text", text: "Could not run" }], status: "completed" }),
    ]));
    const turn = (await readNativeTranscript(f.path, "workbuddy", { settled: true })).turns[0];
    assert(turn);
    const output = turn.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result");
    assert.equal(output?.type === "tool_result" && output.is_error, true);
    assert.equal(turn.result?.status, "completed");
    assert.throws(() => workbuddySessionPath(f.root, f.root, "-".repeat(36)), /location/);
    assert.throws(() => workbuddySessionPath("relative", f.root, f.sessionId), /location/);
  } finally { await f.cleanup(); }
});

test("WorkBuddy archive rebinds every record without changing the source or overwriting existing history", async () => {
  const f = await fixture();
  try {
    const raw = jsonl([f.row("u1", null, "message", { role: "user", content: [{ type: "input_text", text: "q" }] }), f.row("a1", "u1", "message", { role: "assistant", status: "completed", content: [{ type: "output_text", text: "a" }] })]);
    await writeFile(f.path, raw);
    const target = join(f.root, "restored.jsonl"), id = randomUUID();
    const imported = await importNativeArchive({ source: f.path, target, harness: "workbuddy", nativeSessionId: f.sessionId, id, cwd: "/new" });
    const restored = (await readFile(target, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
    assert.deepEqual(restored.map((row) => [row.sessionId, row.cwd]), [[id, "/new"], [id, "/new"]]);
    assert.equal(imported.nativeSessionId, id);
    assert.equal(await readFile(f.path, "utf8"), raw);
    await assert.rejects(importNativeArchive({ source: f.path, target, harness: "workbuddy", nativeSessionId: f.sessionId, id, cwd: "/new" }), /EEXIST/);
  } finally { await f.cleanup(); }
});

test("WorkBuddy origin verifies the restored prefix and identifies only the new Cohub Turn", async () => {
  const f = await fixture();
  try {
    const prefix = jsonl([f.row("old", null, "message", { role: "user", content: [{ type: "input_text", text: "history" }] })]);
    const suffix = jsonl([f.row("new", "old", "message", { role: "user", content: [{ type: "input_text", text: "new" }] })]);
    const origin = { nativeSessionId: f.sessionId, cloudSessionId: randomUUID(), turnId: randomUUID(), prefixBytes: Buffer.byteLength(prefix), prefixSha256: createHash("sha256").update(prefix).digest("hex") };
    await writeFile(f.path, prefix + suffix);
    await writeFile(`${f.path}.cohub.json`, JSON.stringify(origin));
    const transcript = await readTranscript(f.path, "workbuddy");
    assert.equal(transcript.cloudSessionId, origin.cloudSessionId);
    assert.deepEqual(transcript.turns.map((turn) => [turn.key, turn.parentKey, turn.cloudTurnId]), [["new", null, origin.turnId]]);
    await writeFile(f.path, prefix.replace("history", "changed") + suffix);
    await assert.rejects(readTranscript(f.path, "workbuddy"), /prefix/i);
    await writeFile(`${f.path}.cohub.json`, "{bad");
    await assert.rejects(readTranscript(f.path, "workbuddy"));
  } finally { await f.cleanup(); }
});

test("WorkBuddy roundtrips projected compaction, images, tools and cloud identities", async () => {
  const f = await fixture();
  try {
    const turnId = randomUUID(), sessionId = randomUUID();
    const message = (role: CanonicalProjectionMessage["role"], content: CanonicalProjectionMessage["content"]): CanonicalProjectionMessage => ({ id: randomUUID(), turnId, role, content, sourceSessionId: sessionId, sequence: 1, createdAt: at });
    const projected = projectNativeSession({ spaceId: randomUUID(), sessionId, nativeSessionId: f.sessionId, cwd: f.root, turns: [{
      id: turnId, sourceSessionId: sessionId, sourceTurnId: turnId, sequence: 1, status: "completed", intent: "prompt", provider: null, model: null, userContent: [], assistantContent: null, meta: null, createdAt: at, startedAt: at, completedAt: at, durationMs: 0,
      messages: [message("system", [{ type: "system_note", note_type: "compacted", text: "summary" }]), message("user", [{ type: "text", text: "q" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]), message("assistant", [{ type: "tool_use", id: "call", name: "bash", input: {} }, { type: "tool_result", tool_use_id: "call", content: "failed", is_error: true }, { type: "text", text: "a" }])],
    }] }, "workbuddy");
    assert.deepEqual(projected.warnings, []);
    await writeFile(f.path, serializeProjection(projected));
    const parsed = await readNativeTranscript(f.path, "workbuddy", { settled: true });
    assert.equal(parsed.cloudSessionId, sessionId);
    assert.equal(parsed.turns[0]?.cloudTurnId, turnId);
    assert.deepEqual(parsed.turns[0]?.userContent.map((block) => block.type), ["system_note", "text", "image"]);
    assert.deepEqual(parsed.turns[0]?.messages.flatMap((message) => message.content.map((block) => block.type)), ["tool_use", "tool_result", "text"]);
  } finally { await f.cleanup(); }
});
