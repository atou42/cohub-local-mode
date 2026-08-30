import type { AgentHarness } from "@cohub/protocol";
import { ensureSandboxConnection } from "./sandbox-pool.js";
import { tracedRpc } from "./sandbox/tools.js";
import {
	buildHarnessArgv,
	HarnessEventReducer,
	type AccessMode,
	type ExternalHarnessProgress,
	type ExternalHarnessResult,
} from "./external-harness-protocol.js";
import { runCodexAppServerHarness } from "./external-harness-codex-runtime.js";
import { runGrokAcpHarness } from "./external-harness-grok-runtime.js";
import { runCursorAcpHarness } from "./external-harness-cursor-runtime.js";
import {
	getLocalSpaceWritableRoots,
	resolveGrokSandboxProfile,
} from "./local-space-access.js";

export {
	buildHarnessArgv,
	HarnessEventReducer,
	splitExternalHarnessContent,
	type ExternalHarnessResult,
} from "./external-harness-protocol.js";

const SANDBOX_WORKSPACE = "/workspace";
const MAX_STREAM_BYTES = 20 * 1024 * 1024;
const PROCESS_TIMEOUT_SECONDS = 60 * 60;

export async function runExternalHarness(input: {
	harness: Exclude<AgentHarness, "pi">;
	spaceId: string;
	sessionId: string;
	turnId: string;
	prompt: string;
	environment: Record<string, string>;
	executionContextKey: string;
	externalSessionId: string | null;
	accessMode: AccessMode;
	model: string;
	thinkingLevel: string;
	serviceTier?: string | null;
	abortSignal: AbortSignal;
	onExternalSessionId?: (sessionId: string) => void;
	onProgress?: (progress: ExternalHarnessProgress) => void;
}): Promise<ExternalHarnessResult> {
	const reducer = new HarnessEventReducer(input.harness, {
		model: input.model,
		thinkingLevel: input.thinkingLevel,
	});
	const writableRoots = getLocalSpaceWritableRoots(input.spaceId);
	const harnessLabel = input.harness === "codex" ? "Codex" : input.harness === "grok_build" ? "Grok Build" : "Cursor";
	const emitProgress = (progress: ExternalHarnessProgress) => {
		input.onProgress?.(progress);
	};
	emitProgress(
		reducer.pushRuntimeEvent({
			kind: "starting",
			eventType: "runtime.preparing",
			message: `Preparing ${harnessLabel}`,
		}),
	);

	const connection = await ensureSandboxConnection(input.spaceId);
	if (connection.capabilities?.processStartArgv !== true) {
		throw new Error("Local sandbox must support argv process execution for external harnesses");
	}
	emitProgress(
		reducer.pushRuntimeEvent({
			kind: "status",
			eventType: "runtime.sandbox_connected",
			message: "Local sandbox connected",
		}),
	);
	if (input.harness === "codex" && connection.capabilities?.processWrite === true) {
		return runCodexAppServerHarness({
			...input,
			writableRoots,
			connection,
			reducer,
		});
	}
	if (input.harness === "grok_build" && connection.capabilities?.processWrite === true) {
		return runGrokAcpHarness({
			...input,
			writableRoots,
			connection,
			reducer,
		});
	}
	if (input.harness === "cursor" && connection.capabilities?.processWrite === true) {
		return runCursorAcpHarness({
			...input,
			writableRoots,
			connection,
			reducer,
		});
	}
	if (input.harness === "cursor") {
		throw new Error("Local sandbox must support process write for Cursor ACP");
	}
	const argv = buildHarnessArgv({
		harness: input.harness,
		prompt: input.prompt,
		externalSessionId: input.externalSessionId,
		cohubSessionId: input.sessionId,
		accessMode: input.accessMode,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		serviceTier: input.serviceTier,
		writableRoots,
		grokSandboxProfile: resolveGrokSandboxProfile(
			input.spaceId,
			writableRoots,
		),
	});
	let buffered = "";
	let stderr = "";
	let streamBytes = 0;
	let processId: string | null = null;
	let reportedSessionId = input.externalSessionId;
	let streamError: Error | null = null;
	let sawStructuredOutput = false;

	const reportSessionId = (sessionId: string | null) => {
		if (!sessionId || sessionId === reportedSessionId) return;
		reportedSessionId = sessionId;
		input.onExternalSessionId?.(sessionId);
	};

	const pushStdout = (chunk: string) => {
		if (streamError) return;
		streamBytes += Buffer.byteLength(chunk);
		if (streamBytes > MAX_STREAM_BYTES) {
			throw new Error(`${input.harness} output exceeded ${MAX_STREAM_BYTES} bytes`);
		}
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			try {
					const progress = reducer.push(JSON.parse(line));
					if (progress) emitProgress(progress);
					sawStructuredOutput = true;
			} catch (error) {
				if (error instanceof SyntaxError) {
					throw new Error(`${input.harness} emitted invalid JSONL: ${line.slice(0, 200)}`);
				}
				throw error;
			}
			reportSessionId(reducer.externalSessionId);
			if (input.harness === "grok_build" && !reportedSessionId) {
				reportSessionId(input.sessionId);
			}
		}
	};

	const abortProcess = () => {
		if (!processId) return;
		void tracedRpc(
			connection,
			"process.abort",
			{ processId },
			{ context: { spaceId: input.spaceId, sessionId: input.sessionId, turnId: input.turnId } },
			false,
		).catch(() => undefined);
	};
	if (input.abortSignal.aborted) throw new Error("aborted");
	input.abortSignal.addEventListener("abort", abortProcess, { once: true });

	try {
		const result = await tracedRpc(
			connection,
			"process.start",
			{ argv, cwd: SANDBOX_WORKSPACE, env: input.environment, timeoutSecs: PROCESS_TIMEOUT_SECONDS },
			{
				context: { spaceId: input.spaceId, sessionId: input.sessionId, turnId: input.turnId },
				onEvent(event) {
					if (event.type === "started") {
						processId = event.processId;
						emitProgress(
							reducer.pushRuntimeEvent({
								kind: "status",
								eventType: "runtime.process_started",
								message: `${harnessLabel} process started`,
								raw: { processId: event.processId },
							}),
						);
						if (input.abortSignal.aborted) abortProcess();
						return;
					}
					if (event.type === "stdout") {
						try {
							pushStdout(event.chunk);
						} catch (error) {
							streamError = error instanceof Error ? error : new Error(String(error));
							abortProcess();
						}
						return;
					}
					if (event.type === "stderr") {
						stderr = `${stderr}${event.chunk}`.slice(-4000);
						const message = event.chunk.trim();
						if (message) {
							emitProgress(
								reducer.pushRuntimeEvent({
									kind: "stderr",
									eventType: "runtime.stderr",
									message,
									raw: event.chunk,
								}),
							);
						}
					}
				},
			},
		);
		if (streamError) throw streamError;
		if (buffered.trim()) {
			try {
				const progress = reducer.push(JSON.parse(buffered.trim()));
				if (progress) emitProgress(progress);
				sawStructuredOutput = true;
			} catch (error) {
				throw new Error(
					error instanceof SyntaxError
						? `${input.harness} emitted invalid trailing JSONL`
						: String(error),
				);
			}
		}
		if (input.harness === "grok_build" && sawStructuredOutput && !reportedSessionId) {
			reportSessionId(input.sessionId);
		}
		if (input.abortSignal.aborted || result.termination?.reason === "aborted") {
			throw new Error("aborted");
		}
		if (result.exitCode !== 0) {
			throw new Error(
				`${input.harness} exited with code ${result.exitCode ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
			);
		}
		const parsed = reducer.result();
		reportSessionId(parsed.externalSessionId);
		return {
			...parsed,
			externalSessionId: parsed.externalSessionId ?? reportedSessionId,
		};
	} finally {
		input.abortSignal.removeEventListener("abort", abortProcess);
	}
}
