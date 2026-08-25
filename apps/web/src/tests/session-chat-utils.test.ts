import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mergeComposerTurnSources,
	resolveAgentPromptThinkingLevel,
	resolveComposerSelectionFromTurn,
	resolveLastAgentTurnModel,
	shouldClearComposerDraftAfterSend,
} from "../lib/features/session-chat/session-utils";

const catalog = [
	{
		provider: "cohub",
		id: "agent-model",
		model: { name: "Agent model" },
	},
];

test("create mode retains the composer draft for repeated generations", () => {
	assert.equal(shouldClearComposerDraftAfterSend("create"), false);
	assert.equal(shouldClearComposerDraftAfterSend("agent"), true);
});

test("Grok Build receives its catalog default effort for a selected model", () => {
	assert.equal(
		resolveAgentPromptThinkingLevel({
			agentHarness: "grok_build",
			catalog: [
				{
					provider: "grok_build",
					id: "grok-4.6",
					model: { reasoning: true, defaultThinkingLevel: "high" },
				},
			],
			model: { provider: "grok_build", id: "grok-4.6" },
			requestedThinkingLevel: null,
		}),
		"high",
	);
	assert.equal(
		resolveAgentPromptThinkingLevel({
			agentHarness: "codex",
			catalog: [
				{
					provider: "codex",
					id: "gpt-5.6-sol",
					model: { reasoning: true, defaultThinkingLevel: "high" },
				},
			],
			model: { provider: "codex", id: "gpt-5.6-sol" },
			requestedThinkingLevel: null,
		}),
		"high",
	);
	assert.equal(
		resolveAgentPromptThinkingLevel({
			agentHarness: "pi",
			catalog,
			model: { provider: "cohub", id: "agent-model" },
			requestedThinkingLevel: null,
		}),
		null,
	);
	assert.equal(
		resolveAgentPromptThinkingLevel({
			agentHarness: "pi",
			catalog: [
				{
					provider: "cohub",
					id: "agent-model",
					model: {
						reasoning: true,
						thinkingLevelMap: { low: "low", high: "high" },
					},
				},
			],
			model: { provider: "cohub", id: "agent-model" },
			requestedThinkingLevel: "high",
		}),
		"high",
	);
});

test("mergeComposerTurnSources prefers a full turn over an incomplete index item", () => {
	assert.deepEqual(
		mergeComposerTurnSources(
			[
				{
					id: "turn-1",
					sequence: 1,
					executionKind: "direct_generation",
					provider: "generation",
					model: "image-model",
				},
			],
			[
				{
					id: "turn-1",
					sequence: 1,
					provider: null,
					model: "image-model",
				},
			],
		),
		[
			{
				id: "turn-1",
				sequence: 1,
				executionKind: "direct_generation",
				provider: "generation",
				model: "image-model",
			},
		],
	);
});

test("resolveComposerSelectionFromTurn keeps create mode and model together", () => {
	assert.deepEqual(
		resolveComposerSelectionFromTurn(
			{
				executionKind: "direct_generation",
				provider: "generation",
				model: "image-model",
			},
			catalog,
		),
		{ mode: "create", modelId: "image-model" },
	);
});

test("resolveComposerSelectionFromTurn keeps agent mode and model together", () => {
	assert.deepEqual(
		resolveComposerSelectionFromTurn(
			{
				executionKind: "agent",
				provider: "cohub",
				model: "agent-model",
			},
			catalog,
		),
		{
			mode: "agent",
			model: {
				provider: "cohub",
				id: "agent-model",
				name: "Agent model",
			},
		},
	);
});

test("resolveLastAgentTurnModel ignores a newer direct generation turn", () => {
	const model = resolveLastAgentTurnModel(
		[
			{
				sequence: 1,
				executionKind: "agent",
				provider: "cohub",
				model: "agent-model",
			},
			{
				sequence: 2,
				executionKind: "direct_generation",
				provider: "generation",
				model: "image-model",
			},
		],
		catalog,
	);

	assert.deepEqual(model, {
		provider: "cohub",
		id: "agent-model",
		name: "Agent model",
	});
});

test("resolveLastAgentTurnModel keeps the latest legacy turn without executionKind", () => {
	const model = resolveLastAgentTurnModel(
		[
			{
				sequence: 1,
				executionKind: "agent",
				provider: "cohub",
				model: "older-model",
			},
			{
				sequence: 2,
				provider: "cohub",
				model: "agent-model",
			},
		],
		catalog,
	);

	assert.equal(model?.id, "agent-model");
});
