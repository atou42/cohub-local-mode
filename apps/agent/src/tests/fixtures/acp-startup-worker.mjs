import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock } from "node:test";

const sourceRoot = new URL("../../", import.meta.url).href;
const toolsUrl = new URL("../../sandbox/tools.js", import.meta.url).href;

// Exercise the real runtime and reducer without importing tools or live services.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".")) {
			const url = new URL(specifier, context.parentURL).href;
			if (url === toolsUrl) return { url: "cohub-test:rpc", shortCircuit: true };
			if (url.endsWith(".js")) {
				return { url: `${url.slice(0, -3)}.ts`, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "cohub-test:rpc") {
			return {
				format: "module",
				source: "export const tracedRpc = (connection, ...args) => connection.rpc(...args);",
				shortCircuit: true,
			};
		}
		return nextLoad(url, context);
	},
});

const scenario = process.argv[2];
const [provider, failedMethod, failure] = scenario.split("-");
const { runCursorAcpHarness, closeCursorAcpRuntimesForTests } =
	await import("../../external-harness-cursor-runtime.ts");
const { runGrokAcpHarness, closeGrokAcpRuntimesForTests } =
	await import("../../external-harness-grok-runtime.ts");
const { HarnessEventReducer } = await import("../../external-harness-protocol.ts");
const run = provider === "cursor" ? runCursorAcpHarness : runGrokAcpHarness;
const startupTimeout = provider === "cursor" ? 90_000 : 30_000;
const providerLabel = provider === "cursor" ? "Cursor" : "Grok Build";

class FakeSandbox {
	sandboxId = "isolated-sandbox";
	filesystem = { defaultCwd: "/test-workspace" };
	processes = [];
	aborted = [];

	async rpc(method, params, options) {
		if (method === "process.start") {
			const process = {
				id: `process-${this.processes.length + 1}`,
				onEvent: options.onEvent,
				pending: Promise.withResolvers(),
				requests: [],
				failStartup: this.processes.length === 1,
			};
			this.processes.push(process);
			queueMicrotask(() => process.onEvent({ type: "started", processId: process.id }));
			return process.pending.promise;
		}
		const process = this.processes.find((entry) => entry.id === params.processId);
		assert.ok(process, `unknown process ${params.processId}`);
		if (method === "process.abort") {
			this.aborted.push(process.id);
			// Keep process completion pending to test an old exit after replacement.
			return {};
		}
		assert.equal(method, "process.write");
		assert.ok(!this.aborted.includes(process.id), "write to aborted process");
		const request = JSON.parse(params.chunk);
		process.requests.push(request);
		if (process.failStartup && request.method === failedMethod) {
			if (failure === "error") {
				this.reply(process, request, { error: { message: "startup deliberately refused" } });
			}
			return {};
		}
		if (request.method === "initialized") return {};
		if (request.method === "session/prompt") {
			process.prompt = request;
			return {};
		}
		assert.ok([
			"initialize", "authenticate", "session/new", "session/set_config_option",
			"session/set_model", "session/set_mode",
		].includes(request.method), `unexpected request ${request.method}`);
		this.reply(process, request, {
			result: request.method === "session/new" ? { sessionId: `session-${process.id}` } : {},
		});
		return {};
	}

	send(process, payload) {
		queueMicrotask(() => process.onEvent({ type: "stdout", chunk: `${JSON.stringify(payload)}\n` }));
	}
	reply(process, request, body) {
		this.send(process, { id: request.id, ...body });
	}
	complete(process, message) {
		assert.ok(process.prompt, "expected an actual prompt request");
		this.send(process, {
			method: "session/update",
			params: {
				sessionId: `session-${process.id}`,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message } },
			},
		});
		this.reply(process, process.prompt, { result: { stopReason: "end_turn" } });
		process.prompt = null;
	}
}

const sandbox = new FakeSandbox();
const tick = () => new Promise((resolve) => setImmediate(resolve));

function start(sessionId) {
	const state = { status: "pending", result: null, error: null, progress: [] };
	state.done = run({
		spaceId: "test-space",
		sessionId,
		turnId: `cohub-${sessionId}`,
		prompt: "test prompt",
		environment: {},
		executionContextKey: "test-context",
		writableRoots: [],
		externalSessionId: null,
		accessMode: "read_only",
		model: "test-model",
		thinkingLevel: "medium",
		abortSignal: new AbortController().signal,
		connection: sandbox,
		onProgress: (event) => state.progress.push(event),
		reducer: new HarnessEventReducer(provider === "cursor" ? "cursor" : "grok_build", {
			model: "test-model", thinkingLevel: "medium",
		}),
	}).then((result) => {
		Object.assign(state, { status: "completed", result });
	}, (error) => {
		Object.assign(state, { status: "failed", error });
	});
	return state;
}

function assertCompleted(turn, message) {
	assert.equal(turn.status, "completed", turn.error?.stack);
	assert.ok(turn.result.content.some((block) => block.type === "text" && block.text === message));
}

mock.timers.enable({ apis: ["setTimeout"] });
try {
	const unrelated = start("unrelated");
	await tick();
	const unrelatedProcess = sandbox.processes[0];
	assert.ok(unrelatedProcess.prompt);

	const failed = start("target");
	await tick();
	const failedProcess = sandbox.processes[1];
	assert.equal(failedProcess.requests.filter((request) => request.method === failedMethod).length, 1);
	if (failure === "timeout") {
		assert.equal(failed.status, "pending");
		mock.timers.tick(startupTimeout);
		await tick();
	}
	assert.equal(failed.status, "failed");
	assert.equal(failed.error.message, failure === "timeout"
		? `${providerLabel} ACP ${failedMethod} timed out`
		: `${providerLabel} ACP ${failedMethod} failed: startup deliberately refused`);
	assert.equal(failedProcess.requests.some((request) => request.method === "session/new"), false);

	const retry = start("target");
	await tick();
	assert.equal(sandbox.processes.length, 3, "retry must start a new process instead of reusing failed startup");
	assert.deepEqual(sandbox.aborted, [failedProcess.id]);
	const replacement = sandbox.processes[2];
	assert.ok(replacement.prompt);
	failedProcess.pending.resolve({ exitCode: 1 });
	await tick();
	assert.equal(retry.status, "pending", "old process exit must not reject replacement turn");
	sandbox.complete(replacement, "retry result");
	await tick();
	assertCompleted(retry, "retry result");
	assert.ok(retry.progress.some((event) => event.eventType === "runtime.ready"));

	const warm = start("target");
	await tick();
	assert.equal(sandbox.processes.length, 3, "old process exit must not remove replacement from cache");
	assert.equal(replacement.requests.filter((request) => request.method === "initialize").length, 1);
	assert.equal(replacement.requests.filter((request) => request.method === "session/new").length, 1);
	assert.equal(replacement.requests.filter((request) => request.method === "session/prompt").length, 2);
	sandbox.complete(replacement, "warm result");
	sandbox.complete(unrelatedProcess, "unrelated result");
	await tick();
	assertCompleted(warm, "warm result");
	assertCompleted(unrelated, "unrelated result");
	assert.ok(warm.progress.some((event) => event.eventType === "runtime.reused"));
	assert.deepEqual(sandbox.aborted, [failedProcess.id]);
	console.log(JSON.stringify({
		scenario, failedTurn: failed.status, retryTurn: retry.status,
		warmTurn: warm.status, unrelatedTurn: unrelated.status,
	}));
} finally {
	closeCursorAcpRuntimesForTests();
	closeGrokAcpRuntimesForTests();
	for (const process of sandbox.processes) process.pending.resolve({ exitCode: 0 });
	await tick();
	mock.timers.reset();
	hooks.deregister();
}
