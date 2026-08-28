import assert from "node:assert/strict";
import test from "node:test";
import {
	parseCodexSkills,
	parseGrokCommands,
	parseCursorCommands,
} from "./harness-capabilities.js";

test("Codex discovery keeps only enabled skills and preserves their native invocation", () => {
	assert.deepEqual(
		parseCodexSkills({
			data: [{
				skills: [
					{
						name: "goal-crafter",
						description: "Create a durable goal",
						enabled: true,
						scope: "user",
					},
					{
						name: "disabled",
						description: "Must stay hidden",
						enabled: false,
						scope: "user",
					},
					{
						name: "bad-scope",
						description: "Must stay hidden",
						enabled: true,
						scope: "remote",
					},
				],
			}],
		}),
		[{
			name: "goal-crafter",
			description: "Create a durable goal",
			scope: "user",
			insertionText: "$goal-crafter ",
		}],
	);
});

test("Grok discovery uses only commands advertised by ACP", () => {
	assert.deepEqual(
		parseGrokCommands({
			_meta: {
				availableCommands: [
					{
						name: "context",
						description: "Show context usage",
						input: { hint: "[details]" },
					},
					{
						name: "always-approve",
						description: "Changes a process-level permission mode",
						input: { hint: "on|off" },
					},
					{
						name: "compact",
						description: "Does not complete reliably over ACP",
					},
					{ name: "", description: "invalid" },
				],
			},
		}),
		[{
			name: "context",
			description: "Show context usage",
			argumentHint: "[details]",
			category: "Grok Build",
			insertionText: "/context ",
		}],
	);
	assert.deepEqual(parseGrokCommands({}), []);
});

test("Cursor discovery preserves ACP slash commands", () => {
	assert.deepEqual(parseCursorCommands({
		availableCommands: [
			{ name: "goal", description: "Set a goal", input: { hint: "<objective>" } },
			{ name: "create-plan", description: "Create a plan" },
			{ name: "", description: "invalid" },
		],
	}), [
		{ name: "create-plan", description: "Create a plan", category: "Cursor", insertionText: "/create-plan" },
		{ name: "goal", description: "Set a goal", argumentHint: "<objective>", category: "Cursor", insertionText: "/goal " },
	]);
});
