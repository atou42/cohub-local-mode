import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { executePi, executeCodex } from "../src/runtime/harness.js";
import { RuntimeSessionStore } from "../src/runtime/session-store.js";

function input(harness: "pi" | "codex"): RuntimeTurnInput {
  const messages = ["Alice", "Bob", "Charlie"].map((userId, index) => ({
    userId, turnId: randomUUID(), userMessageId: randomUUID(), content: [{ type: "text" as const, text: `ordered-input-${index}` }],
  }));
  const owner = messages.at(-1); assert(owner);
  return { spaceId: randomUUID(), sessionId: randomUUID(), turnId: owner.turnId, userMessageId: owner.userMessageId, harness, messages,
    context: { complete: true, revision: "initial", throughTurnId: null, messages: [] }, accessMode: "full_access" };
}

test("batch inputs reach the harness verbatim without markers, identities or extra text", () => {
  const turn = input("pi");
  const image = { type: "image" as const, source: { type: "base64" as const, data: "aW1hZ2U=", media_type: "image/png" } };
  turn.messages[0]?.content.push(image);
  turn.messages[1]?.content.push(image);
  const original = structuredClone(turn);
  const content = turn.messages.flatMap((message) => message.content);
  // The CLI forwards the same blocks; nothing is prefixed, suffixed, numbered or described.
  assert.deepEqual(content.filter((block) => block.type === "text").map((block) => block.text), ["ordered-input-0", "ordered-input-1", "ordered-input-2"]);
  assert.equal(content.filter((block) => block.type === "image").length, 2);
  const text = content.map((block) => block.type === "text" ? block.text : "").join("\n");
  for (const message of turn.messages) {
    assert(!text.includes(message.turnId)); assert(!text.includes(message.userMessageId)); assert(!text.includes(message.userId ?? ""));
  }
  assert.deepEqual(turn, original);
});

for (const harness of ["pi", "codex"] as const) test(`${harness}: multiple authors produce one native execution and archive under the last turn`, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-batch-"));
  try {
    const binary = fileURLToPath(new URL(`./fixtures/runtime-${harness}.mjs`, import.meta.url));
    await chmod(binary, 0o755);
    const turn = input(harness);
    const store = new RuntimeSessionStore(turn.spaceId, join(root, "state"));
    const run = harness === "pi" ? executePi : executeCodex;
    const result = await run(turn, { [harness]: binary }, root, store, () => {}, new AbortController().signal);
    const rows = (await readFile(result.state.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const prompts = rows.filter((row) => harness === "pi" ? row.type === "message" && row.message.role === "user" : row.type === "response_item");
    assert.equal(prompts.length, 1, "one RPC prompt for the entire batch");
    const payload = JSON.stringify(prompts[0]);
    for (const message of turn.messages) {
      assert(!payload.includes(message.turnId)); assert(!payload.includes(message.userMessageId)); assert(!payload.includes(message.userId ?? ""));
    }
    assert(payload.indexOf("ordered-input-0") < payload.indexOf("ordered-input-1"));
    assert(payload.indexOf("ordered-input-1") < payload.indexOf("ordered-input-2"));
    assert.equal(result.state.pendingTurnId, turn.turnId);
    assert.equal(result.event.archive?.turnId, turn.turnId);
    const requestId = randomUUID();
    await store.recordResult(result.state, requestId, [result.event]);
    const replay = await store.recoverResult(turn, requestId);
    assert.deepEqual(replay?.events, JSON.parse(JSON.stringify([result.event])));
    await store.acknowledge(result.state, turn.turnId, "completed");
    const native = await store.prepare({ ...turn, context: { complete: false, revision: "completed", throughTurnId: turn.turnId, messages: [] } }, root);
    assert.equal(native.resume, "native");
  } finally { await rm(root, { recursive: true, force: true }); }
});
