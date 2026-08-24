import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHarnessArgv,
	HarnessEventReducer,
	splitExternalHarnessContent,
} from "../external-harness-protocol.js";

test("Codex JSONL becomes Cohub text and tool blocks", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "ultra",
	});
	reducer.push({ type: "thread.started", thread_id: "codex-thread" });
	reducer.push({
		type: "item.completed",
		item: {
			id: "tool-1",
			type: "command_execution",
			command: "pnpm test",
			aggregated_output: "ok",
			exit_code: 0,
		},
	});
	reducer.push({
		type: "item.completed",
		item: { id: "message-1", type: "agent_message", text: "Done" },
	});
	reducer.push({
		type: "turn.completed",
		usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 },
	});

	const result = reducer.result();
	assert.equal(result.externalSessionId, "codex-thread");
	assert.equal(result.model, "gpt-5.6-sol");
	assert.equal(result.provider, "codex");
	assert.equal(result.thinkingLevel, "ultra");
	assert.deepEqual(result.content, [
		{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "pnpm test" } },
		{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false },
		{ type: "text", text: "Done" },
	]);
	assert.deepEqual(result.usage, { input: 12, output: 3, cacheRead: 4, totalTokens: undefined });
});

test("Grok ACP updates preserve thinking, tools, and final text", () => {
	const reducer = new HarnessEventReducer("grok_build", {
		model: "grok-4.6",
		thinkingLevel: "xhigh",
	});
	reducer.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } });
	reducer.push({
		sessionUpdate: "tool_call",
		toolCallId: "call-1",
		title: "read_file",
		rawInput: { path: "README.md" },
	});
	reducer.push({
		sessionUpdate: "tool_call_update",
		toolCallId: "call-1",
		status: "completed",
		rawOutput: "contents",
	});
	reducer.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ready" } });
	reducer.push({ type: "end", sessionId: "grok-session", usage: { input_tokens: 8, output_tokens: 2 } });

	const result = reducer.result();
	assert.equal(result.externalSessionId, "grok-session");
	assert.equal(result.model, "grok-4.6");
	assert.equal(result.thinkingLevel, "xhigh");
	assert.deepEqual(result.content, [
		{ type: "thinking", thinking: "Checking" },
		{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
		{ type: "tool_result", tool_use_id: "call-1", content: "contents", is_error: false },
		{ type: "text", text: "Ready" },
	]);
});

test("harness argv keeps an adversarial prompt in one argument", () => {
	const prompt = 'fix it; rm -rf "$HOME"';
	for (const harness of ["codex", "grok_build"] as const) {
		const argv = buildHarnessArgv({
			harness,
			prompt,
			externalSessionId: null,
			cohubSessionId: "00000000-0000-4000-8000-000000000000",
			accessMode: "full_access",
			model: harness === "codex" ? "gpt-5.6-terra" : "grok-4.6",
			thinkingLevel: "high",
		});
		assert.equal(argv.filter((part) => part === prompt).length, 1);
		assert.equal(argv.includes("/workspace"), false);
		assert.equal(
			argv.includes(harness === "codex" ? "gpt-5.6-terra" : "grok-4.6"),
			true,
		);
		assert.equal(argv.includes("high") || argv.includes('model_reasoning_effort="high"'), true);
	}
});

test("resumed harness turns keep the selected model and effort", () => {
	const codex = buildHarnessArgv({
		harness: "codex",
		prompt: "continue",
		externalSessionId: "codex-thread",
		cohubSessionId: "00000000-0000-4000-8000-000000000000",
		accessMode: "read_only",
		model: "gpt-5.6-luna",
		thinkingLevel: "max",
	});
	assert.deepEqual(codex.slice(0, 6), [
		"codex",
		"exec",
		"resume",
		"-m",
		"gpt-5.6-luna",
		"-c",
	]);
	assert.equal(codex.includes('model_reasoning_effort="max"'), true);

	const grok = buildHarnessArgv({
		harness: "grok_build",
		prompt: "continue",
		externalSessionId: "grok-thread",
		cohubSessionId: "00000000-0000-4000-8000-000000000000",
		accessMode: "full_access",
		model: "grok-4.5",
		thinkingLevel: "medium",
	});
	assert.equal(grok.includes("--resume"), true);
	assert.equal(grok.includes("grok-4.5"), true);
	assert.equal(grok.includes("medium"), true);
});

test("fatal harness events cannot become successful empty turns", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	reducer.push({ type: "error", message: "authentication required" });
	assert.throws(() => reducer.result(), /authentication required/);
});

test("external tool activity is separated from the final message", () => {
	const content = [
		{ type: "thinking", thinking: "Checking" },
		{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "pwd" } },
		{ type: "tool_result", tool_use_id: "tool-1", content: "workspace" },
		{ type: "text", text: "Done" },
	] satisfies Parameters<typeof splitExternalHarnessContent>[0];
	const result = splitExternalHarnessContent(content);
	assert.deepEqual(result.intermediate, content.slice(0, 3));
	assert.deepEqual(result.final, [content[3]]);
});

test("external completion without final text fails explicitly", () => {
	assert.throws(
		() =>
			splitExternalHarnessContent([
				{ type: "tool_use", id: "tool-1", name: "bash", input: {} },
			]),
		/without a final assistant message/,
	);
});
