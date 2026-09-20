import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeRecoveryLifecycle } from "./relay/runtime-relay.js";

test("Runtime relay shutdown stops new wakeups, drains existing writes and closes once", async () => {
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const events: string[] = [];
  const execution = { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), harness: "pi" as const };
  const lifecycle = createRuntimeRecoveryLifecycle({
    enqueue: async (spaceId, ownerUserId, pendingExecution) => { events.push(`enqueue:${spaceId}:${ownerUserId}:${pendingExecution.sessionId}`); await pending; },
    close: async () => { events.push("close"); },
  });
  const wakeup = lifecycle.recover("space", "owner", execution);
  const firstClose = lifecycle.close();
  const secondClose = lifecycle.close();
  await lifecycle.recover("ignored", "owner", execution);
  assert.deepEqual(events, [`enqueue:space:owner:${execution.sessionId}`]);
  finish();
  await Promise.all([wakeup, firstClose, secondClose]);
  assert.deepEqual(events, [`enqueue:space:owner:${execution.sessionId}`, "close"]);
});
