import type { AgentHarness } from "@cohub/protocol";
import { ensureSandboxConnection } from "./sandbox-pool.js";
import { tracedRpc } from "./sandbox/tools.js";
import {
	buildHarnessArgv,
	HarnessEventReducer,
	type AccessMode,
	type ExternalHarnessResult,
} from "./external-harness-protocol.js";

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
	externalSessionId: string | null;
	accessMode: AccessMode;
	abortSignal: AbortSignal;
	onExternalSessionId?: (sessionId: string) => void;
}): Promise<ExternalHarnessResult> {
	const connection = await ensureSandboxConnection(input.spaceId);
	if (connection.capabilities?.processStartArgv !== true) {
		throw new Error("Local sandbox must support argv process execution for external harnesses");
	}

	const reducer = new HarnessEventReducer(input.harness);
	const argv = buildHarnessArgv({
		harness: input.harness,
		prompt: input.prompt,
		externalSessionId: input.externalSessionId,
		cohubSessionId: input.sessionId,
		accessMode: input.accessMode,
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
				reducer.push(JSON.parse(line));
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
			{ argv, cwd: SANDBOX_WORKSPACE, timeoutSecs: PROCESS_TIMEOUT_SECONDS },
			{
				context: { spaceId: input.spaceId, sessionId: input.sessionId, turnId: input.turnId },
				onEvent(event) {
					if (event.type === "started") {
						processId = event.processId;
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
					}
				},
			},
		);
		if (streamError) throw streamError;
		if (buffered.trim()) {
			try {
				reducer.push(JSON.parse(buffered.trim()));
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
