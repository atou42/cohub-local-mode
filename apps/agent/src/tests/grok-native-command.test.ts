import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGrokAcpPrompt } from "../grok-native-command.js";

test("Grok context command uses the ACP command that returns a visible report", () => {
	assert.equal(normalizeGrokAcpPrompt("/context"), "/session-info");
	assert.equal(normalizeGrokAcpPrompt("  /context  "), "/session-info");
});

test("Grok prompts and other native commands remain unchanged", () => {
	assert.equal(normalizeGrokAcpPrompt("/goal status"), "/goal status");
	assert.equal(normalizeGrokAcpPrompt("explain /context"), "explain /context");
});
