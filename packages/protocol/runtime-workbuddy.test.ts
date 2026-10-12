import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessArchiveIndexSchema, harnessSchema, isLocalHarness, nativeRuntimeEventSchema, resolveHarness, runtimeCapabilitiesSchema, runtimeClientFrameSchema, runtimeCommandSchema } from "./src/runtime/index.js";

test("WorkBuddy retains its identity through runtime registration and execution", () => {
  assert.equal(harnessSchema.parse("workbuddy"), "workbuddy");
  assert.equal(isLocalHarness("workbuddy"), true);
  assert.equal(resolveHarness({ harness: "workbuddy" }), "workbuddy");
  const capabilities = { harnesses: ["pi", "codex", "workbuddy"], models: [{ harness: "workbuddy", provider: "workbuddy", id: "auto", name: "Auto" }] };
  assert.deepEqual(runtimeCapabilitiesSchema.parse(capabilities), capabilities);
  assert.equal(harnessSchema.safeParse("unknown").success, false);
  assert.equal(runtimeCapabilitiesSchema.safeParse({ ...capabilities, harnesses: ["unknown"] }).success, false);
  const execution = { spaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), harness: "workbuddy" };
  const recover = { type: "turn.recover", requestId: crypto.randomUUID(), execution };
  assert.deepEqual(runtimeCommandSchema.parse(recover), recover);
  const { spaceId, ...pending } = execution;
  assert.deepEqual(runtimeClientFrameSchema.parse({ type: "runtime.recovery", executions: [pending] }), { type: "runtime.recovery", executions: [pending] });
  const userMessageId = crypto.randomUUID();
  const start = { type: "turn.start", requestId: crypto.randomUUID(), input: { ...execution, userMessageId, messages: [{ turnId: execution.turnId, userMessageId, userId: null, content: [{ type: "text", text: "Continue" }] }], context: { revision: "r", throughTurnId: null, messages: [] }, accessMode: "full_access" } };
  assert.deepEqual(runtimeCommandSchema.parse(start), start);
});

test("WorkBuddy native ingestion and archives cannot use another harness format", () => {
  const ingest = { type: "ingest", input: { harness: "workbuddy", nativeSessionId: "workbuddy-session", turns: [{ turnId: crypto.randomUUID(), parentTurnId: null, userContent: [{ type: "text", text: "Hello" }], startedAt: "2026-10-12T00:00:00.000Z", result: null }] } };
  assert.deepEqual(nativeRuntimeEventSchema.parse(ingest), ingest);
  const archive = { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), harness: "workbuddy", version: 1, nativeFormat: "workbuddy.jsonl", nativeSessionId: "workbuddy-session", parentTurnId: null, sizeBytes: 1, sha256: "a".repeat(64), segments: [] };
  assert.deepEqual(harnessArchiveIndexSchema.parse(archive), archive);
  for (const nativeFormat of ["pi.jsonl", "codex.rollout", "unknown"]) assert.equal(harnessArchiveIndexSchema.safeParse({ ...archive, nativeFormat }).success, false);
  for (const harness of ["pi", "codex", "unknown"]) assert.equal(harnessArchiveIndexSchema.safeParse({ ...archive, harness }).success, false);
});
