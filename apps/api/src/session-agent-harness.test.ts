import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentHarnessLockedError,
  assertAgentHarnessLocked,
  InvalidAgentHarnessError,
  resolveAgentHarness,
} from "./session-agent-harness.js";

test("new sessions default to Pi and accept every supported harness", () => {
  assert.equal(resolveAgentHarness(undefined, "pi"), "pi");
  assert.equal(resolveAgentHarness("codex", "pi"), "codex");
  assert.equal(resolveAgentHarness("grok_build", "pi"), "grok_build");
});

test("unknown harnesses fail instead of falling back", () => {
  assert.throws(() => resolveAgentHarness("unknown", "pi"), InvalidAgentHarnessError);
});

test("a started session accepts its current harness and rejects switching", () => {
  assert.doesNotThrow(() => assertAgentHarnessLocked("codex", null));
  assert.doesNotThrow(() => assertAgentHarnessLocked("codex", "codex"));
  assert.throws(() => assertAgentHarnessLocked("codex", "pi"), AgentHarnessLockedError);
});
