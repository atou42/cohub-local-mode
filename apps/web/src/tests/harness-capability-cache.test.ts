import assert from "node:assert/strict";
import test from "node:test";
import { isHarnessCapabilityCatalog } from "$lib/harness-capability-validation";

const validCatalog = {
	version: 1,
	harness: "codex",
	fetchedAt: "2026-08-26T00:00:00.000Z",
	commands: [
		{
			name: "goal",
			description: "Manage a goal",
			category: "Codex",
			insertionText: "/goal ",
		},
	],
	skills: [
		{
			name: "goal-crafter",
			description: "Create a goal",
			scope: "user",
			insertionText: "$goal-crafter ",
		},
	],
};

test("accepts a complete harness capability cache entry", () => {
	assert.equal(isHarnessCapabilityCatalog(validCatalog), true);
});

test("rejects stale or malformed capability cache entries", () => {
	assert.equal(
		isHarnessCapabilityCatalog({ ...validCatalog, version: 0 }),
		false,
	);
	assert.equal(
		isHarnessCapabilityCatalog({
			...validCatalog,
			commands: [{ ...validCatalog.commands[0], insertionText: "" }],
		}),
		false,
	);
	assert.equal(
		isHarnessCapabilityCatalog({
			...validCatalog,
			skills: [{ ...validCatalog.skills[0], scope: "cloud" }],
		}),
		false,
	);
});
