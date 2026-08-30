import type { SandboxConnection } from "@cohub/sandbox-client";
import { tracedRpc } from "./sandbox/tools.js";
import type {
	HarnessEventReducer,
	AccessMode,
	ExternalHarnessProgress,
	ExternalHarnessResult,
} from "./external-harness-protocol.js";
import { buildCodexAppServerArgv } from "./external-harness-codex-config.js";
import { parseCodexGoalCommand } from "./codex-goal-command.js";
import { localSpaceAccessKey } from "./local-space-access.js";

const SANDBOX_WORKSPACE = "/workspace";
const PROCESS_TIMEOUT_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_RUNTIMES = 8;
const MAX_JSON_LINE_CHARS = 16 * 1024 * 1024;

type PendingRequest = {
	method: string;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type ActiveTurn = {
	turnId: string | null;
	threadId: string;
	reducer: HarnessEventReducer;
	onProgress?: (progress: ExternalHarnessProgress) => void;
	resolve: (result: ExternalHarnessResult) => void;
	reject: (error: Error) => void;
	abortRequested: boolean;
	usage: Record<string, unknown> | null;
};

type RuntimeEntry = {
	key: string;
	spaceId: string;
	sessionId: string;
	connection: SandboxConnection;
	workspaceCwd: string;
	accessMode: AccessMode;
	requestedThreadId: string | null;
	threadId: string | null;
	processId: string | null;
	processIdPromise: Promise<string>;
	processPromise: Promise<unknown>;
	readyPromise: Promise<void>;
	stdoutBuffer: string;
	nextRequestId: number;
	pending: Map<number, PendingRequest>;
	writeChain: Promise<void>;
	activeTurn: ActiveTurn | null;
	pendingRuntimeEvents: Array<{
		kind: ExternalHarnessProgress["kind"];
		eventType: string;
		message: string;
		raw?: unknown;
	}>;
	lastUsedAt: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
};

const runtimes = new Map<string, RuntimeEntry>();

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function formatGoalStatus(value: unknown) {
	const goal = record(value);
	if (!goal) return "No active Codex goal.";
	const objective = text(goal.objective);
	const status = text(goal.status) || "unknown";
	const tokensUsed = integer(goal.tokensUsed);
	const tokenBudget = integer(goal.tokenBudget);
	const usage = tokensUsed === null
		? ""
		: `\nTokens: ${tokensUsed}${tokenBudget === null ? "" : ` / ${tokenBudget}`}`;
	return `Codex goal · ${status}\n\n${objective}${usage}`;
}

function completeLocalGoalCommand(input: {
	entry: RuntimeEntry;
	threadId: string;
	message: string;
	reducer: HarnessEventReducer;
	onProgress?: (progress: ExternalHarnessProgress) => void;
}) {
	const events = [
		{ type: "thread.started", thread_id: input.threadId },
		{ type: "turn.started", turn_id: `goal-command-${Date.now()}` },
		{ type: "assistant.message.delta", text: input.message },
		{ type: "turn.completed", usage: null },
	];
	for (const event of events) {
		const progress = input.reducer.push(event);
		if (progress) input.onProgress?.(progress);
	}
	input.entry.lastUsedAt = Date.now();
	scheduleIdleClose(input.entry);
	return input.reducer.result();
}

function normalizedItemType(value: unknown) {
	return text(value)
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[./-]/g, "_")
		.toLowerCase();
}

function normalizedItem(value: unknown): Record<string, unknown> | null {
	const item = record(value);
	if (!item) return null;
	return {
		...item,
		type: normalizedItemType(item.type),
		...(item.exit_code === undefined && item.exitCode !== undefined
			? { exit_code: item.exitCode }
			: {}),
		...(item.aggregated_output === undefined &&
		item.aggregatedOutput !== undefined
			? { aggregated_output: item.aggregatedOutput }
			: {}),
	};
}

function flattenUsage(value: unknown): Record<string, unknown> | null {
	const usage = record(value);
	if (!usage) return null;
	const total = record(usage.total) ?? record(usage.totalUsage) ?? usage;
	const number = (...keys: string[]) => {
		for (const key of keys) {
			const candidate = total[key] ?? usage[key];
			if (typeof candidate === "number" && Number.isFinite(candidate)) {
				return candidate;
			}
		}
		return undefined;
	};
	return {
		input_tokens: number("input_tokens", "inputTokens"),
		cached_input_tokens: number(
			"cached_input_tokens",
			"cachedInputTokens",
			"cacheReadInputTokens",
		),
		output_tokens: number("output_tokens", "outputTokens"),
		total_tokens: number("total_tokens", "totalTokens"),
	};
}

function context(entry: RuntimeEntry, turnId?: string | null) {
	return {
		spaceId: entry.spaceId,
		sessionId: entry.sessionId,
		turnId: turnId ?? entry.activeTurn?.turnId ?? undefined,
	};
}

function emit(entry: RuntimeEntry, value: unknown) {
	const turn = entry.activeTurn;
	if (!turn) return;
	const progress = turn.reducer.push(value);
	if (progress) turn.onProgress?.(progress);
}

function emitRuntime(
	entry: RuntimeEntry,
	input: {
		kind: ExternalHarnessProgress["kind"];
		eventType: string;
		message: string;
		raw?: unknown;
	},
) {
	const turn = entry.activeTurn;
	if (!turn) {
		entry.pendingRuntimeEvents.push(input);
		if (entry.pendingRuntimeEvents.length > 100) entry.pendingRuntimeEvents.shift();
		return;
	}
	turn.onProgress?.(turn.reducer.pushRuntimeEvent(input));
}

function flushPendingRuntimeEvents(entry: RuntimeEntry) {
	const turn = entry.activeTurn;
	if (!turn || entry.pendingRuntimeEvents.length === 0) return;
	for (const event of entry.pendingRuntimeEvents.splice(0)) {
		turn.onProgress?.(turn.reducer.pushRuntimeEvent(event));
	}
}

function clearIdleTimer(entry: RuntimeEntry) {
	if (!entry.idleTimer) return;
	clearTimeout(entry.idleTimer);
	entry.idleTimer = null;
}

function rejectPending(entry: RuntimeEntry, error: Error) {
	for (const pending of entry.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	entry.pending.clear();
}

function closeEntry(entry: RuntimeEntry, reason: string) {
	if (entry.closed) return;
	entry.closed = true;
	clearIdleTimer(entry);
	runtimes.delete(entry.key);
	const error = new Error(reason);
	rejectPending(entry, error);
	entry.activeTurn?.reject(error);
	entry.activeTurn = null;
	if (entry.processId) {
		void tracedRpc(
			entry.connection,
			"process.abort",
			{ processId: entry.processId },
			{ context: context(entry) },
			false,
		).catch(() => undefined);
	}
}

function scheduleIdleClose(entry: RuntimeEntry) {
	clearIdleTimer(entry);
	if (entry.closed || entry.activeTurn) return;
	entry.idleTimer = setTimeout(() => closeEntry(entry, "Codex runtime idle timeout"), IDLE_TIMEOUT_MS);
	entry.idleTimer.unref?.();
}

function evictRuntimeIfNeeded() {
	if (runtimes.size < MAX_RUNTIMES) return;
	const idle = [...runtimes.values()]
		.filter((entry) => !entry.activeTurn)
		.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
	if (!idle) throw new Error("all Codex runtimes are busy");
	closeEntry(idle, "Codex runtime evicted");
}

async function writePayload(entry: RuntimeEntry, payload: Record<string, unknown>) {
	const encoded = `${JSON.stringify(payload)}\n`;
	const operation = entry.writeChain.then(async () => {
		const processId = await entry.processIdPromise;
		await tracedRpc(
			entry.connection,
			"process.write",
			{ processId, chunk: encoded },
			{ context: context(entry) },
			false,
		);
	});
	entry.writeChain = operation.catch(() => undefined);
	return operation;
}

function request(
	entry: RuntimeEntry,
	method: string,
	params: Record<string, unknown> = {},
) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const id = entry.nextRequestId;
		entry.nextRequestId += 1;
		const timer = setTimeout(() => {
			entry.pending.delete(id);
			reject(new Error(`Codex app-server ${method} timed out`));
		}, REQUEST_TIMEOUT_MS);
		timer.unref?.();
		entry.pending.set(id, { method, resolve, reject, timer });
		void writePayload(entry, { id, method, params }).catch((error) => {
			const pending = entry.pending.get(id);
			if (!pending) return;
			entry.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function notify(
	entry: RuntimeEntry,
	method: string,
	params: Record<string, unknown> = {},
) {
	return writePayload(entry, { method, params });
}

function respondToServerRequest(
	entry: RuntimeEntry,
	payload: Record<string, unknown>,
) {
	const id = payload.id;
	const method = text(payload.method);
	if (typeof id !== "number" && typeof id !== "string") return;
	if (method.endsWith("/requestApproval")) {
		void writePayload(entry, { id, result: { decision: "accept" } });
		return;
	}
	emit(entry, {
		type: "turn.attention.required",
		kind: method.includes("requestUserInput") ? "input" : "unsupported_request",
		method,
	});
	void writePayload(entry, {
		id,
		error: { code: -32000, message: `unsupported Codex request: ${method}` },
	});
}

function finishTurn(entry: RuntimeEntry, payload: Record<string, unknown>) {
	const active = entry.activeTurn;
	if (!active) return;
	const params = record(payload.params) ?? {};
	const turn = record(params.turn) ?? {};
	const status = text(turn.status) || text(params.status);
	if (status === "completed") {
		emit(entry, {
			type: "turn.completed",
			usage: flattenUsage(active.usage),
		});
		try {
			active.resolve(active.reducer.result());
		} catch (error) {
			active.reject(error instanceof Error ? error : new Error(String(error)));
		}
	} else {
		const turnError = record(turn.error);
		const message = text(turnError?.message) || status || "Codex app-server turn failed";
		emit(entry, { type: "turn.failed", error: { message } });
		active.reject(new Error(message));
	}
	entry.activeTurn = null;
	entry.lastUsedAt = Date.now();
	scheduleIdleClose(entry);
}

function handleNotification(entry: RuntimeEntry, payload: Record<string, unknown>) {
	const method = text(payload.method);
	const params = record(payload.params) ?? {};
	if (method === "thread/tokenUsage/updated") {
		if (entry.activeTurn) {
			entry.activeTurn.usage =
				record(params.tokenUsage) ?? record(params.usage) ?? entry.activeTurn.usage;
		}
		return;
	}
	if (method === "turn/started") {
		const active = entry.activeTurn;
		if (!active) return;
		const turn = record(params.turn);
		active.turnId = text(turn?.id) || text(params.turnId) || active.turnId;
		emit(entry, { type: "thread.started", thread_id: active.threadId });
		emit(entry, { type: "turn.started", turn_id: active.turnId });
		if (active.abortRequested && active.turnId) {
			void request(entry, "turn/interrupt", {
				threadId: active.threadId,
				turnId: active.turnId,
			});
		}
		return;
	}
	if (method === "item/agentMessage/delta") {
		emit(entry, {
			type: "assistant.message.delta",
			item_id: params.itemId,
			text: text(params.delta),
		});
		return;
	}
	if (
		method === "item/reasoning/textDelta" ||
		method === "item/reasoning/summaryTextDelta"
	) {
		emit(entry, {
			type: "reasoning.delta",
			item_id: params.itemId,
			text: text(params.delta) || text(params.text),
		});
		return;
	}
	if (method === "item/commandExecution/outputDelta") {
		emit(entry, {
			type: "command.output.delta",
			item_id: params.itemId,
			delta: text(params.delta),
		});
		return;
	}
	if (method === "item/started" || method === "item/completed") {
		const item = normalizedItem(params.item);
		if (item) {
			emit(entry, {
				type: method === "item/started" ? "item.started" : "item.completed",
				item,
			});
		}
		return;
	}
	if (method === "turn/plan/updated") {
		emit(entry, {
			type: "turn.plan.updated",
			explanation: params.explanation,
			plan: params.plan,
		});
		return;
	}
	if (method === "turn/completed") {
		finishTurn(entry, payload);
		return;
	}
	if (method.toLowerCase().includes("error")) {
		emit(entry, {
			type: "error",
			message: text(params.message) || method,
			raw: params,
		});
	}
}

function handleLine(entry: RuntimeEntry, line: string) {
	const raw = line.trim();
	if (!raw) return;
	let payload: Record<string, unknown>;
	try {
		const parsed = record(JSON.parse(raw));
		if (!parsed) return;
		payload = parsed;
	} catch {
		emitRuntime(entry, {
			kind: "stderr",
			eventType: "runtime.stdout",
			message: raw,
			raw,
		});
		return;
	}

	if (Object.hasOwn(payload, "id") && payload.method) {
		respondToServerRequest(entry, payload);
		return;
	}
	if (Object.hasOwn(payload, "id")) {
		const id = Number(payload.id);
		const pending = entry.pending.get(id);
		if (!pending) return;
		entry.pending.delete(id);
		clearTimeout(pending.timer);
		const error = record(payload.error);
		if (error) {
			pending.reject(
				new Error(
					`Codex app-server ${pending.method} failed: ${text(error.message) || JSON.stringify(error)}`,
				),
			);
			return;
		}
		pending.resolve(record(payload.result) ?? {});
		return;
	}
	if (payload.method) handleNotification(entry, payload);
}

function consumeStdout(entry: RuntimeEntry, chunk: string) {
	entry.stdoutBuffer += chunk;
	if (entry.stdoutBuffer.length > MAX_JSON_LINE_CHARS) {
		entry.stdoutBuffer = "";
		closeEntry(
			entry,
			`Codex app-server emitted a JSON line larger than ${MAX_JSON_LINE_CHARS} characters`,
		);
		return;
	}
	for (;;) {
		const newline = entry.stdoutBuffer.indexOf("\n");
		if (newline < 0) break;
		const line = entry.stdoutBuffer.slice(0, newline);
		entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
		handleLine(entry, line);
	}
}

function createRuntime(input: {
	key: string;
	spaceId: string;
	sessionId: string;
	connection: SandboxConnection;
	accessMode: AccessMode;
	externalSessionId: string | null;
	environment: Record<string, string>;
	writableRoots: readonly string[];
}) {
	evictRuntimeIfNeeded();
	let resolveProcessId: (processId: string) => void = () => undefined;
	let rejectProcessId: (error: Error) => void = () => undefined;
	const processIdPromise = new Promise<string>((resolve, reject) => {
		resolveProcessId = resolve;
		rejectProcessId = reject;
	});
	processIdPromise.catch(() => undefined);

	const entry: RuntimeEntry = {
		key: input.key,
		spaceId: input.spaceId,
		sessionId: input.sessionId,
		connection: input.connection,
		workspaceCwd:
			input.connection.filesystem?.defaultCwd?.trim() || SANDBOX_WORKSPACE,
		accessMode: input.accessMode,
		requestedThreadId: input.externalSessionId,
		threadId: null,
		processId: null,
		processIdPromise,
		processPromise: Promise.resolve(),
		readyPromise: Promise.resolve(),
		stdoutBuffer: "",
		nextRequestId: 1,
		pending: new Map<number, PendingRequest>(),
		writeChain: Promise.resolve(),
		activeTurn: null,
		pendingRuntimeEvents: [],
		lastUsedAt: Date.now(),
		idleTimer: null,
		closed: false,
	};

	entry.processPromise = tracedRpc(
		input.connection,
		"process.start",
		{
			argv: buildCodexAppServerArgv(input.writableRoots),
			cwd: entry.workspaceCwd,
			env: input.environment,
			timeoutSecs: PROCESS_TIMEOUT_SECONDS,
		},
		{
			context: context(entry),
			onEvent(event) {
				if (event.type === "started") {
					entry.processId = event.processId;
					resolveProcessId(event.processId);
					return;
				}
				if (event.type === "stdout") {
					consumeStdout(entry, event.chunk);
					return;
				}
				if (event.type === "stderr") {
					const message = event.chunk.trim();
					if (message) {
						emitRuntime(entry, {
							kind: "stderr",
							eventType: "runtime.stderr",
							message,
							raw: event.chunk,
						});
					}
				}
			},
		},
		false,
	).then(
		() => closeEntry(entry, "Codex app-server exited"),
		(error) => {
			const runtimeError = error instanceof Error ? error : new Error(String(error));
			rejectProcessId(runtimeError);
			closeEntry(entry, runtimeError.message);
		},
	);

	entry.readyPromise = (async () => {
		await entry.processIdPromise;
		await request(entry, "initialize", {
			clientInfo: { name: "cohub-local", version: "1" },
			capabilities: { experimentalApi: true },
		});
		await notify(entry, "initialized", {});
	})();
	entry.readyPromise.catch((error) => {
		const runtimeError = error instanceof Error ? error : new Error(String(error));
		closeEntry(entry, runtimeError.message);
	});
	runtimes.set(entry.key, entry);
	return entry;
}

function getOrCreateRuntime(input: {
	spaceId: string;
	sessionId: string;
	connection: SandboxConnection;
	accessMode: AccessMode;
	externalSessionId: string | null;
	environment: Record<string, string>;
	executionContextKey: string;
	writableRoots: readonly string[];
}) {
	const key = `${input.spaceId}:${input.sessionId}:${input.executionContextKey}:${localSpaceAccessKey(input.writableRoots)}`;
	const existing = runtimes.get(key);
	if (
		existing &&
		!existing.closed &&
		existing.connection.sandboxId === input.connection.sandboxId &&
		existing.accessMode === input.accessMode &&
		(!input.externalSessionId ||
			!existing.threadId ||
			existing.threadId === input.externalSessionId)
	) {
		clearIdleTimer(existing);
		existing.lastUsedAt = Date.now();
		return { entry: existing, reused: true };
	}
	if (existing) closeEntry(existing, "Codex runtime configuration changed");
	return {
		entry: createRuntime({ ...input, key }),
		reused: false,
	};
}

async function ensureThread(
	entry: RuntimeEntry,
	input: {
		model: string;
		accessMode: AccessMode;
		serviceTier?: string | null;
	},
) {
	await entry.readyPromise;
	if (entry.threadId) return entry.threadId;
	const params = {
		cwd: entry.workspaceCwd,
		model: input.model,
		approvalPolicy: "never",
		approvalsReviewer: "user",
		sandbox: input.accessMode === "read_only" ? "read-only" : "workspace-write",
		persistExtendedHistory: true,
		...(input.serviceTier !== undefined
			? { serviceTier: input.serviceTier }
			: {}),
	};
	const result = entry.requestedThreadId
		? await request(entry, "thread/resume", {
				threadId: entry.requestedThreadId,
				...params,
				excludeTurns: true,
			})
		: await request(entry, "thread/start", {
				...params,
				experimentalRawEvents: false,
			});
	const thread = record(result.thread);
	const threadId = text(thread?.id) || text(result.threadId) || entry.requestedThreadId;
	if (!threadId) throw new Error("Codex app-server did not return a thread id");
	entry.threadId = threadId;
	return threadId;
}

export async function runCodexAppServerHarness(input: {
	spaceId: string;
	sessionId: string;
	turnId: string;
	prompt: string;
	environment: Record<string, string>;
	executionContextKey: string;
	writableRoots: readonly string[];
	externalSessionId: string | null;
	accessMode: AccessMode;
	model: string;
	thinkingLevel: string;
	serviceTier?: string | null;
	abortSignal: AbortSignal;
	connection: SandboxConnection;
	onExternalSessionId?: (sessionId: string) => void;
	onProgress?: (progress: ExternalHarnessProgress) => void;
	reducer: HarnessEventReducer;
}): Promise<ExternalHarnessResult> {
	const startedAt = performance.now();
	const { entry, reused } = getOrCreateRuntime(input);
	if (entry.activeTurn) throw new Error("Codex runtime already has an active turn");
	const reducer = input.reducer;
	const threadId = await ensureThread(entry, input);
	input.onExternalSessionId?.(threadId);
	const goalCommand = parseCodexGoalCommand(input.prompt);
	let effectivePrompt = input.prompt;
	if (goalCommand) {
		if (goalCommand.action === "get") {
			const result = await request(entry, "thread/goal/get", { threadId });
			return completeLocalGoalCommand({
				entry,
				threadId,
				message: formatGoalStatus(result.goal),
				reducer,
				onProgress: input.onProgress,
			});
		}
		if (goalCommand.action === "clear") {
			await request(entry, "thread/goal/clear", { threadId });
			return completeLocalGoalCommand({
				entry,
				threadId,
				message: "Codex goal cleared.",
				reducer,
				onProgress: input.onProgress,
			});
		}
		if (goalCommand.action === "pause" || goalCommand.action === "resume") {
			const result = await request(entry, "thread/goal/set", {
				threadId,
				status: goalCommand.action === "pause" ? "paused" : "active",
			});
			return completeLocalGoalCommand({
				entry,
				threadId,
				message: formatGoalStatus(result.goal),
				reducer,
				onProgress: input.onProgress,
			});
		}
		if (goalCommand.action !== "set") {
			throw new Error(`Unsupported Codex goal action: ${goalCommand.action}`);
		}
		await request(entry, "thread/goal/set", {
			threadId,
			objective: goalCommand.objective,
			status: "active",
		});
		input.onProgress?.(
			reducer.pushRuntimeEvent({
				kind: "status",
				eventType: "thread.goal.set",
				message: "Codex goal saved; starting work",
			}),
		);
		effectivePrompt =
			"Continue working toward the active Codex goal for this thread. Use the persisted goal state as the source of truth. Begin executing it now.";
	}
	input.onProgress?.(
		reducer.pushRuntimeEvent({
			kind: "status",
			eventType: reused ? "runtime.reused" : "runtime.ready",
			message: reused ? "Reused warm Codex runtime" : "Codex runtime ready",
			raw: {
				reused,
				startupOverheadMs: Math.round(performance.now() - startedAt),
			},
		}),
	);

	return new Promise<ExternalHarnessResult>((resolve, reject) => {
		const active: ActiveTurn = {
			turnId: null,
			threadId,
			reducer,
			onProgress: input.onProgress,
			resolve,
			reject,
			abortRequested: input.abortSignal.aborted,
			usage: null,
		};
		entry.activeTurn = active;
		entry.lastUsedAt = Date.now();
		flushPendingRuntimeEvents(entry);

		const abort = () => {
			active.abortRequested = true;
			if (!active.turnId) return;
			void request(entry, "turn/interrupt", {
				threadId,
				turnId: active.turnId,
			});
		};
		input.abortSignal.addEventListener("abort", abort, { once: true });

		const settle = (callback: () => void) => {
			input.abortSignal.removeEventListener("abort", abort);
			callback();
		};
		active.resolve = (result) => settle(() => resolve(result));
		active.reject = (error) => settle(() => reject(error));

		void request(entry, "turn/start", {
			threadId,
			input: [{ type: "text", text: effectivePrompt, text_elements: [] }],
			model: input.model,
			effort: input.thinkingLevel,
			...(input.serviceTier !== undefined
				? { serviceTier: input.serviceTier }
				: {}),
		}).then(
			(result) => {
				const turn = record(result.turn);
				active.turnId = text(turn?.id) || text(result.turnId) || active.turnId;
				if (active.abortRequested) abort();
			},
			(error) => {
				if (entry.activeTurn === active) entry.activeTurn = null;
				active.reject(error instanceof Error ? error : new Error(String(error)));
				scheduleIdleClose(entry);
			},
		);
	});
}

export function closeCodexAppServerRuntimesForTests() {
	for (const entry of [...runtimes.values()]) closeEntry(entry, "test cleanup");
}
