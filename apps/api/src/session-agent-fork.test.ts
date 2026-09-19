import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSessionAgentFork } from "./session-agent-fork.js";

test("Codex uses its exact native checkpoint when it matches the parent", () => {
  assert.deepEqual(resolveSessionAgentFork({
    agentHarness: "codex",
    executionKind: "agent",
    parentExternalSessionId: "thread-parent",
    turnMeta: {
      forkCheckpoint: {
        harness: "codex",
        externalSessionId: "thread-parent",
        externalTurnId: "turn-2",
      },
    },
  }), { strategy: "codex_native", anchorExternalTurnId: "turn-2" });
});

test("legacy or mismatched Codex turns fail over to an isolated context clone", () => {
  assert.deepEqual(resolveSessionAgentFork({
    agentHarness: "codex",
    executionKind: "agent",
    parentExternalSessionId: "thread-current",
    turnMeta: {
      forkCheckpoint: {
        harness: "codex",
        externalSessionId: "thread-old",
        externalTurnId: "turn-2",
      },
    },
  }), { strategy: "context_clone", anchorExternalTurnId: null });
});

test("Cursor and Grok use independent context-clone sessions", () => {
  for (const agentHarness of ["cursor", "grok_build"] as const) {
    assert.deepEqual(resolveSessionAgentFork({ agentHarness }), {
      strategy: "context_clone",
      anchorExternalTurnId: null,
    });
  }
});
