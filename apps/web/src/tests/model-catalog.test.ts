import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getRequestedThinkingLevel,
	getSupportedThinkingLevels,
} from "../lib/model-catalog";

test("getRequestedThinkingLevel only reads explicit requests", () => {
	assert.equal(
		getRequestedThinkingLevel({
			requestedThinkingLevel: "high",
			effectiveThinkingLevel: "medium",
		}),
		"high",
	);
	assert.equal(
		getRequestedThinkingLevel({ effectiveThinkingLevel: "high" }),
		null,
	);
	assert.equal(getRequestedThinkingLevel(null), null);
});

test("explicit Ultra support is visible without leaking to other models", () => {
	assert.deepEqual(
		getSupportedThinkingLevels({
			provider: "codex",
			id: "gpt-5.6-sol",
			model: {
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					ultra: "ultra",
				},
			},
		}),
		["low", "medium", "high", "xhigh", "max", "ultra"],
	);
	assert.equal(
		getSupportedThinkingLevels({
			provider: "grok_build",
			id: "grok-4.5",
			model: { reasoning: true },
		}).includes("ultra"),
		false,
	);
});
