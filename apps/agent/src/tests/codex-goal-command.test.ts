import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexGoalCommand } from "../codex-goal-command.js";

test("parses the supported Codex goal command forms", () => {
	assert.deepEqual(parseCodexGoalCommand("/goal"), { action: "get" });
	assert.deepEqual(parseCodexGoalCommand(" /goal status "), { action: "get" });
	assert.deepEqual(parseCodexGoalCommand("/goal clear"), { action: "clear" });
	assert.deepEqual(parseCodexGoalCommand("/goal pause"), { action: "pause" });
	assert.deepEqual(parseCodexGoalCommand("/goal resume"), { action: "resume" });
	assert.deepEqual(parseCodexGoalCommand("/goal ship the local client"), {
		action: "set",
		objective: "ship the local client",
	});
	assert.deepEqual(parseCodexGoalCommand("/goal set ship the local client"), {
		action: "set",
		objective: "ship the local client",
	});
});

test("does not reinterpret unrelated slash commands as goals", () => {
	assert.equal(parseCodexGoalCommand("/goals nope"), null);
	assert.equal(parseCodexGoalCommand("hello /goal later"), null);
	assert.throws(
		() => parseCodexGoalCommand("/goal set"),
		/\/goal set requires an objective/,
	);
});
