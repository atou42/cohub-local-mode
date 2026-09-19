import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock } from "node:test";

const sourceRoot = new URL("../../", import.meta.url).href;
const toolsUrl = new URL("../../sandbox/tools.js", import.meta.url).href;

// Replace only the RPC transport, before it can load database or live services.
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

const { runCodexAppServerHarness, closeCodexAppServerRuntimesForTests } =
	await import("../../external-harness-codex-runtime.ts");
const { HarnessEventReducer } = await import("../../external-harness-protocol.ts");

class FakeSandbox {
	sandboxId = "isolated-sandbox";
	filesystem = { defaultCwd: "/test-workspace" };
	processes = [];
	aborted = [];
	interruptMode = "hold";
	holdStart = false;

	async rpc(method, params, options) {
		if (method === "process.start") {
			const pending = Promise.withResolvers();
			const process = {
				id: `process-${this.processes.length + 1}`,
				onEvent: options.onEvent,
				pending,
				requests: [],
				turns: 0,
			};
			this.processes.push(process);
			queueMicrotask(() => process.onEvent({ type: "started", processId: process.id }));
			return pending.promise;
		}
		const process = this.processes.find((entry) => entry.id === params.processId);
		assert.ok(process, `unknown process ${params.processId}`);
		if (method === "process.abort") {
			this.aborted.push(process.id);
			process.pending.resolve({ exitCode: 0 });
			return {};
		}
		assert.equal(method, "process.write");
		const request = JSON.parse(params.chunk);
		process.requests.push(request);
		if (request.method === "initialized") return {};
		if (request.method === "turn/interrupt") {
			if (this.interruptMode === "write-error") throw new Error("interrupt transport unavailable");
			if (this.interruptMode === "error") {
				this.reply(process, request, { error: { message: "interrupt refused" } });
			} else if (this.interruptMode === "success") {
				this.reply(process, request, { result: {} });
				this.notify(process, "turn/completed", { turn: { status: "interrupted" } });
			}
			return {};
		}
		if (request.method === "turn/start") {
			process.turns += 1;
			process.turnId = `${process.id}-turn-${process.turns}`;
			process.start = request;
			if (!this.holdStart) this.ackStart(process);
			return {};
		}
		assert.ok(["initialize", "thread/start", "thread/resume"].includes(request.method));
		this.reply(process, request, {
			result: request.method === "initialize" ? {} : {
				thread: { id: request.params.threadId ?? `thread-${process.id}` },
			},
		});
		return {};
	}

	send(process, payload) {
		queueMicrotask(() => process.onEvent({ type: "stdout", chunk: `${JSON.stringify(payload)}\n` }));
	}
	reply(process, request, body) {
		this.send(process, { id: request.id, ...body });
	}
	notify(process, method, params) {
		this.send(process, { method, params });
	}
	ackStart(process) {
		this.reply(process, process.start, { result: { turn: { id: process.turnId } } });
	}
	complete(process, message) {
		this.notify(process, "item/agentMessage/delta", { itemId: process.turnId, delta: message });
		this.notify(process, "turn/completed", { turn: { status: "completed" } });
	}
}

const sandbox = new FakeSandbox();
const tick = () => new Promise((resolve) => setImmediate(resolve));

function start(sessionId, controller = new AbortController(), externalSessionId = null) {
	const state = { status: "pending", result: null, error: null };
	state.done = runCodexAppServerHarness({
		spaceId: "test-space",
		sessionId,
		turnId: `cohub-${sessionId}`,
		prompt: "test prompt",
		environment: {},
		executionContextKey: "test-context",
		writableRoots: [],
		externalSessionId,
		accessMode: "read_only",
		model: "test-model",
		thinkingLevel: "medium",
		abortSignal: controller.signal,
		connection: sandbox,
		reducer: new HarnessEventReducer("codex", { model: "test-model", thinkingLevel: "medium" }),
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

const scenario = process.argv[2];
mock.timers.enable({ apis: ["setTimeout"] });
try {
	const unrelated = start("unrelated");
	await tick();
	const unrelatedProcess = sandbox.processes[0];
	assert.equal(unrelated.status, "pending");

	const controller = new AbortController();
	sandbox.holdStart = scenario.startsWith("abort-before-start-");
	sandbox.interruptMode = scenario === "interrupt-write-error" ? "write-error"
		: scenario === "interrupt-success" ? "success"
		: scenario === "interrupt-error" || sandbox.holdStart ? "error" : "hold";
	const target = start("target", controller);
	await tick();
	const targetProcess = sandbox.processes[1];
	assert.ok(targetProcess.start);
	controller.abort();
	if (sandbox.holdStart) {
		await tick();
		assert.equal(targetProcess.requests.filter((entry) => entry.method === "turn/interrupt").length, 0);
		if (scenario.endsWith("notification")) {
			sandbox.notify(targetProcess, "turn/started", { turn: { id: targetProcess.turnId } });
		}
		sandbox.ackStart(targetProcess);
	}
	await tick();
	const interrupts = targetProcess.requests.filter((entry) => entry.method === "turn/interrupt");
	assert.equal(interrupts.length, 1);
	assert.deepEqual(interrupts[0].params, {
		threadId: "thread-process-2",
		turnId: targetProcess.turnId,
	});

	let followup;
	if (scenario.startsWith("late-")) {
		sandbox.complete(targetProcess, "finished before interrupt reply");
		await tick();
		assertCompleted(target, "finished before interrupt reply");
		followup = start("target", new AbortController(), "thread-process-2");
		await tick();
		assert.equal(sandbox.processes.length, 2);
		if (scenario.endsWith("timeout")) mock.timers.tick(30_000);
		else sandbox.reply(targetProcess, interrupts[0], { error: { message: "turn already ended" } });
		await tick();
		assert.equal(followup.status, "pending");
		assert.deepEqual(sandbox.aborted, []);
		sandbox.complete(targetProcess, "followup result");
	} else {
		if (scenario === "interrupt-timeout") {
			mock.timers.tick(30_000);
			await tick();
		}
		assert.equal(target.status, "failed");
		assert.match(target.error.message, scenario === "interrupt-success" ? /interrupted/
			: scenario === "interrupt-timeout" ? /turn\/interrupt timed out/
			: scenario === "interrupt-write-error" ? /interrupt transport unavailable/ : /interrupt refused/);
		assert.deepEqual(sandbox.aborted, scenario === "interrupt-success" ? [] : [targetProcess.id]);
		sandbox.holdStart = false;
		followup = start("target", new AbortController(), "thread-process-2");
		await tick();
		const resumed = sandbox.processes.at(-1);
		assert.equal(sandbox.processes.length, scenario === "interrupt-success" ? 2 : 3);
		if (scenario !== "interrupt-success") {
			assert.equal(resumed.requests.find((entry) => entry.method === "thread/resume")?.params.threadId, "thread-process-2");
		}
		sandbox.complete(resumed, "followup result");
	}
	assert.equal(unrelated.status, "pending");
	sandbox.complete(unrelatedProcess, "unrelated result");
	await tick();
	assertCompleted(followup, "followup result");
	assertCompleted(unrelated, "unrelated result");
	assert.ok(!sandbox.aborted.includes(unrelatedProcess.id));
	console.log(JSON.stringify({ scenario, unrelatedTurn: unrelated.status, followupTurn: followup.status }));
} finally {
	closeCodexAppServerRuntimesForTests();
	await tick();
	mock.timers.reset();
	hooks.deregister();
}
