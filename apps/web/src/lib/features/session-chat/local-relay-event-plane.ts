import type { AgentHarness } from "@neta-art/cohub";
import type {
	LocalRelayEventCommand,
	LocalRelayTurnEvent,
} from "$lib/local-relay-events";

export const RELAY_TURN_EVENT_DEDUP_CAP = 200;

export const TERMINAL_RELAY_TURN_STATUSES = new Set([
	"completed",
	"failed",
	"interrupted",
	"merged",
	"cancelled",
]);

const NONTERMINAL_COMMAND_STATUSES = new Set([
	"accepted",
	"queued",
	"claimed",
	"running",
]);

export type RelayCommandReconcileAction =
	| { action: "ignore-nonterminal"; status: string }
	| { action: "failed" }
	| { action: "cancelled" }
	| { action: "succeeded-truncated" }
	| {
			action: "succeeded";
			session: Record<string, unknown>;
			turn: Record<string, unknown> & { id: string; sessionId: string };
			completeGeneration: boolean;
	  }
	| { action: "invalid-payload"; error: string };

export type RelayTurnEventAction =
	| { action: "ignore"; reason: "kind" | "space" | "duplicate" }
	| {
			action: "apply-turn";
			sessionId: string;
			turnId: string;
			session: Record<string, unknown> | null;
			turn: Record<string, unknown> & { id: string };
	  }
	| { action: "hydrate-truncated"; sessionId: string; turnId: string };

export function isTerminalRelayTurnStatus(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_RELAY_TURN_STATUSES.has(status);
}

export function shouldCreateRelaySession(
	session: { meta?: Record<string, unknown> | null } | null | undefined,
): boolean {
	return !session || session.meta?.relayPending === true;
}

export function buildRelaySessionCreation(
	session:
		| { agentHarness: AgentHarness; meta?: Record<string, unknown> | null }
		| null
		| undefined,
	selectedHarness: AgentHarness,
): { createSession: boolean; agentHarness?: AgentHarness } {
	const createSession = shouldCreateRelaySession(session);
	return {
		createSession,
		...(createSession
			? { agentHarness: session ? session.agentHarness : selectedHarness }
			: {}),
	};
}

export function rememberRelayEventId(
	seen: Set<string>,
	eventId: string,
	cap = RELAY_TURN_EVENT_DEDUP_CAP,
): boolean {
	if (seen.has(eventId)) return false;
	seen.add(eventId);
	if (seen.size > cap) {
		const overflow = seen.size - cap;
		let removed = 0;
		for (const id of seen) {
			if (removed >= overflow) break;
			seen.delete(id);
			removed += 1;
		}
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseResultBody(body: string): unknown {
	return JSON.parse(body);
}

export function decideRelayCommandReconcile(
	pending: { sessionId: string },
	command: LocalRelayEventCommand,
): RelayCommandReconcileAction {
	if (NONTERMINAL_COMMAND_STATUSES.has(command.status)) {
		return { action: "ignore-nonterminal", status: command.status };
	}
	if (command.status === "cancelled") return { action: "cancelled" };
	if (command.status !== "succeeded" || !command.result) {
		return { action: "failed" };
	}
	let payload: unknown;
	try {
		payload = parseResultBody(command.result.body);
	} catch {
		return {
			action: "invalid-payload",
			error: "Local node returned an invalid relay result",
		};
	}
	if (isRecord(payload) && payload.relayTruncated === true) {
		return { action: "succeeded-truncated" };
	}
	if (!isRecord(payload) || !isRecord(payload.session) || !isRecord(payload.turn)) {
		return {
			action: "invalid-payload",
			error: "Local node returned a mismatched Session result",
		};
	}
	const sessionId =
		typeof payload.session.id === "string" ? payload.session.id : null;
	const turnId = typeof payload.turn.id === "string" ? payload.turn.id : null;
	const turnSessionId =
		typeof payload.turn.sessionId === "string" ? payload.turn.sessionId : null;
	if (
		sessionId !== pending.sessionId ||
		turnSessionId !== pending.sessionId ||
		!turnId
	) {
		return {
			action: "invalid-payload",
			error: "Local node returned a mismatched Session result",
		};
	}
	return {
		action: "succeeded",
		session: payload.session,
		turn: payload.turn as Record<string, unknown> & {
			id: string;
			sessionId: string;
		},
		completeGeneration: isTerminalRelayTurnStatus(payload.turn.status),
	};
}

export function decideRelayTurnEvent(
	event: LocalRelayTurnEvent,
	input: { spaceId: string; seenEventIds: Set<string> },
): RelayTurnEventAction {
	if (event.kind !== "turn.completed") {
		return { action: "ignore", reason: "kind" };
	}
	if (event.spaceId !== input.spaceId) {
		return { action: "ignore", reason: "space" };
	}
	if (!rememberRelayEventId(input.seenEventIds, event.id)) {
		return { action: "ignore", reason: "duplicate" };
	}
	if (event.truncated || event.turn == null) {
		return {
			action: "hydrate-truncated",
			sessionId: event.sessionId,
			turnId: event.turnId,
		};
	}
	const session = isRecord(event.turn.session) ? event.turn.session : null;
	const turn = isRecord(event.turn.turn) ? event.turn.turn : event.turn;
	const turnId = typeof turn.id === "string" ? turn.id : event.turnId;
	return {
		action: "apply-turn",
		sessionId: event.sessionId,
		turnId,
		session,
		turn: { ...turn, id: turnId },
	};
}

export function mergeRelayCommandStatuses(
	current: Record<string, LocalRelayEventCommand["status"]>,
	commands: Array<Pick<LocalRelayEventCommand, "id" | "status">>,
): Record<string, LocalRelayEventCommand["status"]> {
	if (commands.length === 0) return current;
	const next = { ...current };
	for (const command of commands) next[command.id] = command.status;
	return next;
}

export function queuedRelayCancelTargets<
	T extends { commandId: string },
>(
	pending: T[],
	statusById: Record<string, string | undefined>,
): T[] {
	return pending.filter((item) => statusById[item.commandId] === "queued");
}

export function findOptimisticTurnForRelayCommand<
	T extends { id: string; meta?: Record<string, unknown> | null },
>(
	turns: T[],
	input: { commandId: string; optimisticTurnId: string },
): T | null {
	return (
		turns.find((turn) => {
			const relayCommandId = turn.meta?.relayCommandId;
			return (
				turn.id === input.optimisticTurnId ||
				(typeof relayCommandId === "string" &&
					relayCommandId === input.commandId)
			);
		}) ?? null
	);
}
