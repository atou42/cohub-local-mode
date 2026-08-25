import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHarnessArgv,
	HarnessEventReducer,
	splitExternalHarnessContent,
} from "../external-harness-protocol.js";
import {
	appendCloudSpaceReadInstructions,
	buildExternalHarnessEnvironment,
} from "../external-harness-context.js";
import { buildCodexAppServerArgv } from "../external-harness-codex-config.js";
import { createExternalProgressPublisher } from "../external-progress-publisher.js";

function semanticContent(
	content: ReturnType<HarnessEventReducer["result"]>["content"],
) {
	return content
		.filter((block) => block.type !== "system_note")
		.map((block) => {
			const { _meta: _runtimeMeta, ...semantic } = block;
			return semantic;
		});
}

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
	assert.deepEqual(semanticContent(result.content), [
		{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "pnpm test" } },
		{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false },
		{ type: "text", text: "Done" },
	]);
	assert.deepEqual(result.usage, { input: 12, output: 3, cacheRead: 4, totalTokens: undefined });
});

test("external progress publishing coalesces a slow live stream without losing the final snapshot", async () => {
	let releaseFirst!: () => void;
	const firstBlocked = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const publications: Array<{
		seq: number;
		baseSeq: number;
		text: string;
		turnEnd: boolean;
	}> = [];
	const publisher = createExternalProgressPublisher({
		publish: async ({ seq, baseSeq, content, turnEnd }) => {
			const block = content[0];
			publications.push({
				seq,
				baseSeq,
				text: block?.type === "text" ? block.text : "",
				turnEnd,
			});
			if (seq === 1) await firstBlocked;
		},
	});

	publisher.enqueue([{ type: "text", text: "first" }]);
	for (let index = 2; index <= 100; index += 1) {
		publisher.enqueue(
			[{ type: "text", text: `snapshot-${index}` }],
			index === 100,
		);
	}
	assert.equal(publications.length, 1);
	releaseFirst();
	await publisher.flush();

	assert.deepEqual(publications, [
		{ seq: 1, baseSeq: 0, text: "first", turnEnd: false },
		{ seq: 2, baseSeq: 1, text: "snapshot-100", turnEnd: true },
	]);
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
	assert.deepEqual(semanticContent(result.content), [
		{ type: "thinking", thinking: "Checking" },
		{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
		{ type: "tool_result", tool_use_id: "call-1", content: "contents", is_error: false },
		{ type: "text", text: "Ready" },
	]);
});

test("Grok terminal byte output is decoded for visible tool results", () => {
	const reducer = new HarnessEventReducer("grok_build", {
		model: "grok-4.6",
		thinkingLevel: "high",
	});
	reducer.push({
		sessionUpdate: "tool_call",
		toolCallId: "call-cloud-read",
		toolName: "run_terminal_command",
		rawInput: { command: '"$COHUB_LOCAL_CLI" spaces files cat README.md' },
	});
	reducer.push({
		sessionUpdate: "tool_call_update",
		toolCallId: "call-cloud-read",
		status: "completed",
		content: [{
			type: "content",
			content: { type: "text", text: "# Workspace layout\n" },
		}],
		rawOutput: {
			type: "Bash",
			output: Array.from(Buffer.from("# Workspace layout\n", "utf8")),
			exit_code: 0,
		},
	});
	reducer.push({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "# Workspace layout" },
	});
	reducer.push({ type: "end", sessionId: "grok-session" });

	const result = semanticContent(reducer.result().content);
	assert.equal(
		result.find((block) => block.type === "tool_result")?.content,
		"# Workspace layout\n",
	);
});

test("Grok malformed terminal byte output fails visibly", () => {
	const reducer = new HarnessEventReducer("grok_build", {
		model: "grok-4.6",
		thinkingLevel: "high",
	});
	assert.throws(
		() =>
			reducer.push({
				sessionUpdate: "tool_call_update",
				toolCallId: "call-invalid-output",
				status: "completed",
				rawOutput: { type: "Bash", output: [35, 999] },
			}),
		/Grok Build tool output contains invalid byte data/,
	);
});

test("Grok pre-tool commentary stays intermediate instead of polluting the final answer", () => {
	const reducer = new HarnessEventReducer("grok_build", {
		model: "grok-4.6",
		thinkingLevel: "high",
	});
	reducer.push({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "I'll read the file." },
	});
	reducer.push({
		sessionUpdate: "tool_call",
		toolCallId: "call-read",
		toolName: "read_file",
		rawInput: { path: "README.md" },
	});
	reducer.push({
		sessionUpdate: "tool_call_update",
		toolCallId: "call-read",
		status: "completed",
		content: [{ type: "content", content: { type: "text", text: "# Title" } }],
	});
	reducer.push({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "# Title" },
	});
	reducer.push({ type: "end", sessionId: "grok-session" });

	const result = reducer.result().content;
	assert.equal(
		result.find((block) => block.type === "text")?.text,
		"# Title",
	);
	assert.equal(
		result.some(
			(block) => block.type === "system_note" && block.text === "I'll read the file.",
		),
		true,
	);
});

test("Grok retry state stays visible and later completion wins", () => {
	const reducer = new HarnessEventReducer("grok_build", {
		model: "grok-4.6",
		thinkingLevel: "high",
	});
	reducer.push({
		method: "_x.ai/session/update",
		params: {
			sessionId: "grok-session",
			update: {
				sessionUpdate: "retry_state",
				type: "retrying",
				attempt: 2,
				max_retries: 15,
				reason: "stream disconnected",
			},
		},
	});
	reducer.push({
		method: "session/update",
		params: {
			sessionId: "grok-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Recovered answer" },
			},
		},
	});
	reducer.push({
		method: "_x.ai/session/update",
		params: {
			sessionId: "grok-session",
			update: {
				sessionUpdate: "turn_completed",
				usage: { input_tokens: 4, output_tokens: 2 },
			},
		},
	});
	// The ACP prompt response may arrive after the vendor completion update.
	reducer.push({ type: "end" });

	const result = reducer.result();
	assert.equal(result.externalSessionId, "grok-session");
	assert.equal(
		result.content.filter((block) => block.type === "system_note").length,
		3,
	);
	assert.match(
		result.content
			.filter((block) => block.type === "system_note")
			.map((block) => block.text)
			.join("\n"),
		/Grok Build is retrying \(2\/15\).*stream disconnected/,
	);
	assert.equal(
		result.content.find((block) => block.type === "text")?.text,
		"Recovered answer",
	);
	assert.equal(result.usage?.input, 4);
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
			serviceTier: harness === "codex" ? "priority" : undefined,
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

test("Codex command shells inherit only the scoped Cohub bridge environment", () => {
	const argv = buildCodexAppServerArgv();
	assert.deepEqual(argv.slice(0, 4), [
		"codex",
		"app-server",
		"--listen",
		"stdio://",
	]);
	assert.equal(argv.includes("shell_environment_policy.inherit=all"), true);
	assert.equal(
		argv.includes("shell_environment_policy.ignore_default_excludes=true"),
		true,
	);
	assert.equal(
		argv.includes("sandbox_workspace_write.network_access=true"),
		true,
	);
	const includeOnly = argv.find((part) =>
		part.startsWith("shell_environment_policy.include_only="),
	);
	assert.ok(includeOnly);
	assert.match(includeOnly, /COHUB_\*/);
	assert.doesNotMatch(includeOnly, /EXECUTION_TOKEN=/);
	assert.doesNotMatch(includeOnly, /AUTH_TOKEN|API_KEY|SECRET/);
});

test("external harness cloud mention instructions expose capability but not credentials", () => {
	const cloudSpaceId = "22222222-2222-4222-8222-222222222222";
	const content = [{
		type: "text" as const,
		text: `@[Cloud context](cohub://spaces/${cloudSpaceId}) inspect it`,
		_meta: {
			mentions: [{ type: "space", spaceId: cloudSpaceId, origin: "cloud" }],
		},
	}];
	const prompt = appendCloudSpaceReadInstructions("inspect it", [content]);
	assert.match(
		prompt,
		new RegExp(`\\$COHUB_LOCAL_CLI.*-s ${cloudSpaceId} spaces files ls`),
	);
	assert.match(prompt, /read-only/);
	assert.doesNotMatch(prompt, /secret-execution-token/);

	const env = buildExternalHarnessEnvironment({
		spaceId: "11111111-1111-4111-8111-111111111111",
		sessionId: "33333333-3333-4333-8333-333333333333",
		actorUserId: "44444444-4444-4444-8444-444444444444",
		executionToken: "secret-execution-token",
		apiBaseUrl: "http://127.0.0.1:8787",
		cliPath: "/opt/cohub-local/bin/cohub",
	});
	assert.equal(env.COHUB_API_URL, "http://127.0.0.1:8787");
	assert.equal(env.COHUB_LOCAL_CLI, "/opt/cohub-local/bin/cohub");
	assert.equal(env.COHUB_EXECUTION_TOKEN, "secret-execution-token");
	assert.equal(env.COHUB_SESSION_ID, "33333333-3333-4333-8333-333333333333");
});

test("external harness prompt is unchanged for local and legacy mentions", () => {
	for (const origin of ["local", undefined] as const) {
		const content = [{
			type: "text" as const,
			text: "local context",
			_meta: {
				mentions: [{
					type: "space",
					spaceId: "22222222-2222-4222-8222-222222222222",
					...(origin ? { origin } : {}),
				}],
			},
		}];
		assert.equal(appendCloudSpaceReadInstructions("inspect it", [content]), "inspect it");
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
		serviceTier: "priority",
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
	assert.equal(codex.includes('service_tier="priority"'), true);

	const grok = buildHarnessArgv({
		harness: "grok_build",
		prompt: "continue",
		externalSessionId: "grok-thread",
		cohubSessionId: "00000000-0000-4000-8000-000000000000",
		accessMode: "full_access",
		model: "grok-4.5",
		thinkingLevel: "medium",
		serviceTier: undefined,
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

test("Codex recoverable stream errors do not override a later successful completion", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	reducer.push({ type: "thread.started", thread_id: "codex-thread" });
	reducer.push({
		type: "error",
		message:
			"Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)",
	});
	reducer.push({
		type: "item.completed",
		item: { id: "message-1", type: "agent_message", text: "Recovered" },
	});
	reducer.push({
		type: "turn.completed",
		usage: { input_tokens: 12, output_tokens: 3 },
	});

	const result = reducer.result();
	assert.equal(result.externalSessionId, "codex-thread");
	assert.deepEqual(semanticContent(result.content), [
		{ type: "text", text: "Recovered" },
	]);
	assert.deepEqual(
		result.content
			.filter((block) => block.type === "system_note")
			.map((block) => (block.type === "system_note" ? block.text : "")),
		[
			"Codex session connected",
			"Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)",
			"Codex recovered from the stream interruption",
			"Codex completed",
		],
	);
});

test("external progress snapshots expose running tools and redact credentials", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	const progress = reducer.push({
		type: "item.started",
		item: {
			id: "tool-1",
			type: "command_execution",
			command: "curl -H 'Authorization: Bearer secret-value-123456789' https://example.com",
		},
	});

	assert.equal(progress?.kind, "tool");
	const tool = progress?.content.find((block) => block.type === "tool_use");
	assert.equal(tool?.type, "tool_use");
	if (tool?.type !== "tool_use") assert.fail("running tool block is missing");
	assert.equal(tool._meta?.toolStatus, "running");
	assert.match(String(tool.input.command), /\[redacted\]/);
	assert.doesNotMatch(JSON.stringify(progress), /secret-value-123456789/);
});

test("external runtime notes strip terminal color sequences", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	const progress = reducer.pushRuntimeEvent({
		kind: "stderr",
		eventType: "runtime.stderr",
		message: "\u001b[2m2026-08-25\u001b[0m \u001b[31mERROR\u001b[0m tls handshake eof",
	});

	assert.equal(progress.message, "2026-08-25 ERROR tls handshake eof");
	assert.equal(JSON.stringify(progress).includes("\u001b"), false);
});

test("oversized external command output is explicitly bounded before live snapshots are cloned", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	const oversized = "x".repeat(3 * 1024 * 1024);
	const progress = reducer.push({
		type: "item.completed",
		item: {
			id: "tool-large",
			type: "command_execution",
			command: "generate-output",
			aggregated_output: oversized,
			exit_code: 0,
		},
	});
	const result = progress?.content.find(
		(block) => block.type === "tool_result",
	);

	assert.equal(result?.type, "tool_result");
	if (result?.type !== "tool_result") assert.fail("tool result is missing");
	if (typeof result.content !== "string") {
		assert.fail("tool result content must be text");
	}
	assert.ok(result.content.length < oversized.length);
	assert.match(result.content, /\[output truncated by Cohub\]$/);
});

test("Codex app-server deltas stay live without duplicating completed items", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	reducer.push({ type: "thread.started", thread_id: "codex-thread" });
	reducer.push({
		type: "item.started",
		item: {
			id: "tool-1",
			type: "command_execution",
			command: "printf hello",
		},
	});
	reducer.push({
		type: "command.output.delta",
		item_id: "tool-1",
		delta: "hel",
	});
	const commandProgress = reducer.push({
		type: "command.output.delta",
		item_id: "tool-1",
		delta: "lo",
	});
	assert.equal(
		commandProgress?.content.find((block) => block.type === "tool_result")
			?.content,
		"hello",
	);
	reducer.push({
		type: "item.completed",
		item: {
			id: "tool-1",
			type: "command_execution",
			command: "printf hello",
			aggregated_output: "hello",
			exit_code: 0,
		},
	});
	reducer.push({ type: "assistant.message.delta", text: "Do" });
	reducer.push({ type: "assistant.message.delta", text: "ne" });
	reducer.push({
		type: "item.completed",
		item: { id: "message-1", type: "agent_message", text: "Done" },
	});
	reducer.push({ type: "turn.completed" });

	const result = reducer.result();
	assert.deepEqual(
		semanticContent(result.content).filter((block) => block.type === "text"),
		[{ type: "text", text: "Done" }],
	);
});

test("Codex app-server camel-case command results expose failures and output", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	reducer.push({
		type: "item.completed",
		item: {
			id: "tool-camel",
			type: "commandExecution",
			command: "cohub spaces files cat README.md",
			aggregatedOutput: "cloud request failed",
			exitCode: 1,
			status: "failed",
		},
	});
	reducer.push({
		type: "item.completed",
		item: { id: "message-1", type: "agentMessage", text: "Stopped" },
	});
	reducer.push({ type: "turn.completed" });

	const result = semanticContent(reducer.result().content);
	assert.deepEqual(result.slice(0, 2), [
		{
			type: "tool_use",
			id: "tool-camel",
			name: "bash",
			input: { command: "cohub spaces files cat README.md" },
		},
		{
			type: "tool_result",
			tool_use_id: "tool-camel",
			content: "cloud request failed",
			is_error: true,
		},
	]);
});

test("Codex uncommon app-server items remain visible instead of disappearing", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	const progress = reducer.push({
		type: "item.started",
		item: {
			type: "webSearch",
			id: "search-1",
			query: "runtime protocol",
		},
	});
	assert.equal(progress?.kind, "tool");
	assert.equal(
		progress?.content.find((block) => block.type === "tool_use")?.name,
		"web_search",
	);

	const unknown = reducer.push({ type: "vendor.notice", detail: "diagnostic" });
	assert.equal(unknown?.kind, "status");
	assert.match(
		unknown?.content
			.filter((block) => block.type === "system_note")
			.map((block) => block.text)
			.join("\n") ?? "",
		/Received vendor\.notice/,
	);
});

test("Codex terminal turn failures still fail even when content was emitted", () => {
	const reducer = new HarnessEventReducer("codex", {
		model: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	reducer.push({
		type: "item.completed",
		item: { id: "message-1", type: "agent_message", text: "Partial" },
	});
	reducer.push({
		type: "turn.failed",
		error: { message: "authentication required" },
	});

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
