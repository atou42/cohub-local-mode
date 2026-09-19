import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_HARNESSES, parseAgentHarness } from "./src/model/session.js";

test("agent harness protocol exposes the supported immutable choices", () => {
  assert.deepEqual(AGENT_HARNESSES, ["pi", "codex", "grok_build", "cursor"]);
  assert.equal(parseAgentHarness("pi"), "pi");
  assert.equal(parseAgentHarness("codex"), "codex");
  assert.equal(parseAgentHarness("grok_build"), "grok_build");
});

test("agent harness protocol rejects unknown and malformed choices", () => {
  assert.equal(parseAgentHarness("claude"), null);
  assert.equal(parseAgentHarness(" codex "), null);
  assert.equal(parseAgentHarness(null), null);
  assert.equal(parseAgentHarness({ harness: "pi" }), null);
});
