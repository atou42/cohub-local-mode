import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getFastServiceTier,
	getModelServiceTiers,
	getRequestedServiceTier,
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

test("getRequestedServiceTier preserves Fast, Standard, and absent requests", () => {
	assert.equal(
		getRequestedServiceTier({ requestedServiceTier: "priority" }),
		"priority",
	);
	assert.equal(getRequestedServiceTier({ requestedServiceTier: null }), null);
	assert.equal(
		getRequestedServiceTier({ effectiveServiceTier: "priority" }),
		undefined,
	);
	assert.equal(getRequestedServiceTier(null), undefined);
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

test("Codex speed controls come from the model catalog", () => {
	const fastModel = {
		provider: "codex",
		id: "gpt-5.6-sol",
		model: {
			serviceTiers: [
				{ id: "priority", name: "Fast", description: "1.5x speed" },
			],
		},
	};
	assert.deepEqual(getModelServiceTiers(fastModel), [
		{ id: "priority", name: "Fast", description: "1.5x speed" },
	]);
	assert.equal(getFastServiceTier(fastModel)?.id, "priority");
	assert.equal(
		getFastServiceTier({
			provider: "codex",
			id: "gpt-5.4-mini",
			model: { serviceTiers: [] },
		}),
		null,
	);
});
