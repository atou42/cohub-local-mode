import { test } from "node:test";
import assert from "node:assert";
import {
  buildAgentSandboxFsMutationJobId,
  enqueueRuntimeRecovery,
  sandboxFsMutationJobRetention,
  type AgentSandboxFsMutationOperation,
} from "./index.js";

test("Runtime recovery jobs are scoped to one Session execution", async () => {
  const calls: unknown[][] = [];
  const queue = { add: async (...args: unknown[]) => { calls.push(args); } };
  const data = {
    spaceId: "space",
    sessionId: "session",
    expectedTurnId: "turn",
    expectedHarness: "pi" as const,
    expectedOwnerUserId: "owner",
  };
  await enqueueRuntimeRecovery(queue as unknown as Parameters<typeof enqueueRuntimeRecovery>[0], data);
  const call = calls[0];
  assert(call);
  assert.equal(call[0], "runtime_recovery");
  assert.equal((call[2] as { jobId?: string }).jobId, "runtime-session-recover-turn");
});

const writeA: AgentSandboxFsMutationOperation = { operation: "write", path: "a.txt", content: "hello" };
const writeB: AgentSandboxFsMutationOperation = { operation: "write", path: "a.txt", content: "world" };

test("sandbox fs mutation job id is scoped by spaceId and mutationId", () => {
  const id = buildAgentSandboxFsMutationJobId("space-1", "mutation-abc", writeA);
  // Stable for the same space + mutation + payload (idempotent retry).
  assert.equal(buildAgentSandboxFsMutationJobId("space-1", "mutation-abc", writeA), id);
  // Different space must not collide even with the same mutationId.
  assert.notEqual(buildAgentSandboxFsMutationJobId("space-2", "mutation-abc", writeA), id);
  // Different mutation must not collide.
  assert.notEqual(buildAgentSandboxFsMutationJobId("space-1", "mutation-def", writeA), id);
});

test("sandbox fs mutation job id is bound to the payload", () => {
  // The same mutationId reused with different content must not observe the
  // stale first result.
  const first = buildAgentSandboxFsMutationJobId("space-1", "mutation-abc", writeA);
  const second = buildAgentSandboxFsMutationJobId("space-1", "mutation-abc", writeB);
  assert.notEqual(first, second);
});

test("sandbox fs mutation retention preserves a bounded retry window", () => {
  assert.deepEqual(sandboxFsMutationJobRetention, {
    removeOnComplete: { age: 300, count: 200 },
    removeOnFail: { age: 300, count: 200 },
  });
});
