import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildExternalForkBootstrapPrompt,
	parsePendingExternalForkBootstrap,
} from "../external-fork-context.js";

test("fork bootstrap carries only the supplied visible transcript", () => {
	const prompt = buildExternalForkBootstrapPrompt({
		harness: "cursor",
		turns: [
			{ sequence: 1, userText: "remember alpha", assistantText: "alpha saved" },
			{ sequence: 2, userText: "remember beta", assistantText: "beta saved" },
		],
		prompt: "what do you remember?",
	});

	assert.match(prompt, /remember alpha/);
	assert.match(prompt, /beta saved/);
	assert.match(prompt, /what do you remember\?/);
	assert.doesNotMatch(prompt, /future secret/);
});

test("fork bootstrap metadata fails closed when structurally corrupt", () => {
	assert.throws(
		() => parsePendingExternalForkBootstrap({
			agentFork: { strategy: "context_clone", bootstrapPending: true },
		}),
		/anchor sequence/i,
	);
});

test("completed native forks do not request transcript bootstrap", () => {
	assert.equal(
		parsePendingExternalForkBootstrap({
			agentFork: {
				strategy: "codex_native",
				anchorSequence: 2,
				bootstrapPending: false,
			},
		}),
		null,
	);
});

test("malformed persisted fork state is not treated as a completed bootstrap", () => {
	assert.throws(
		() => parsePendingExternalForkBootstrap({
			agentFork: {
				strategy: "context_clone",
				anchorSequence: 2,
				bootstrapPending: "false",
			},
		}),
		/pending state/i,
	);
});
