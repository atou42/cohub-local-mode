import type { RelayCommand, RelayCommandStatus, RelayHttpResult } from "./protocol.ts";

export const MAX_COMMAND_ATTEMPTS = 5;
export const RESULT_MAX_JSON_BYTES = 786_432;
export const TURN_EVENT_MAX_STORED = 200;
export const TERMINAL_COMMAND_MAX_STORED = 200;
export const TERMINAL_COMMAND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_TERMINAL_COMMANDS = 20;
export const SNAPSHOT_EVENTS = 50;
export const GC_ALARM_MS = 6 * 60 * 60 * 1000;

export function isTerminalCommandStatus(status: RelayCommandStatus) {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

export type RequeueDecision =
	| { action: "keep" }
	| { action: "requeue" }
	| {
			action: "fail";
			errorCode: "max_attempts_exceeded";
			errorMessage: string;
	  };

export function decideExpiredCommand(
	command: Pick<RelayCommand, "status" | "attempt" | "leaseExpiresAt">,
	nowMs: number,
	maxAttempts = MAX_COMMAND_ATTEMPTS,
): RequeueDecision {
	if (
		(command.status !== "claimed" && command.status !== "running") ||
		!command.leaseExpiresAt ||
		new Date(command.leaseExpiresAt).getTime() > nowMs
	) {
		return { action: "keep" };
	}
	if (command.attempt >= maxAttempts) {
		return {
			action: "fail",
			errorCode: "max_attempts_exceeded",
			errorMessage: `Command exceeded ${maxAttempts} attempts; last lease expired at ${command.leaseExpiresAt}`,
		};
	}
	return { action: "requeue" };
}

export function guardResultSize(
	result: RelayHttpResult,
	maxBytes = RESULT_MAX_JSON_BYTES,
): RelayHttpResult {
	// Measure UTF-8 bytes, not UTF-16 code units: CJK-heavy bodies serialize to
	// up to 3x their string length and must not exceed storage value limits.
	const encodedBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
	if (encodedBytes <= maxBytes) return result;
	return {
		status: result.status,
		headers: result.headers,
		body: JSON.stringify({
			relayTruncated: true,
			originalBytes: encodedBytes,
		}),
	};
}

export type CancelDecision =
	| { action: "cancel" }
	| { action: "conflict"; code: "command_active" }
	| { action: "noop" };

export function decideCancel(command: Pick<RelayCommand, "status">): CancelDecision {
	if (command.status === "queued") return { action: "cancel" };
	if (command.status === "claimed" || command.status === "running") {
		return { action: "conflict", code: "command_active" };
	}
	return { action: "noop" };
}

export function selectTerminalCommandsForGc(
	commands: RelayCommand[],
	nowMs: number,
	options: { maxKeep?: number; maxAgeMs?: number } = {},
) {
	const maxKeep = options.maxKeep ?? TERMINAL_COMMAND_MAX_STORED;
	const maxAgeMs = options.maxAgeMs ?? TERMINAL_COMMAND_MAX_AGE_MS;
	const terminal = commands
		.filter((command) => isTerminalCommandStatus(command.status))
		.sort((left, right) => right.sequence - left.sequence);
	return terminal.filter((command, index) => {
		const completedAtMs = command.completedAt
			? Date.parse(command.completedAt)
			: Number.NaN;
		const tooOld =
			Number.isFinite(completedAtMs) && nowMs - completedAtMs > maxAgeMs;
		return tooOld || index >= maxKeep;
	});
}

export function selectOldestKeysForGc(keys: string[], maxKeep: number) {
	if (keys.length <= maxKeep) return [];
	return keys.slice(0, keys.length - maxKeep);
}

export function selectSnapshotCommands(
	commands: RelayCommand[],
	maxTerminal = SNAPSHOT_TERMINAL_COMMANDS,
) {
	const active = commands.filter(
		(command) => !isTerminalCommandStatus(command.status),
	);
	const terminal = commands
		.filter((command) => isTerminalCommandStatus(command.status))
		.sort((left, right) => right.sequence - left.sequence)
		.slice(0, maxTerminal);
	return [...active, ...terminal].sort((left, right) => left.sequence - right.sequence);
}

export function selectSnapshotEvents<T>(events: T[], maxEvents = SNAPSHOT_EVENTS) {
	return events.length <= maxEvents ? events : events.slice(maxEvents * -1);
}
