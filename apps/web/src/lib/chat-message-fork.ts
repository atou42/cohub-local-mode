import type { AgentHarness } from "@cohub/protocol";
import type { ChatMessage } from "$lib/session-tree";

const TERMINAL_ASSISTANT_KINDS = new Set([
	"assistant_final",
	"assistant_error",
	"assistant_interrupted",
]);

const TERMINAL_TURN_STATUSES = new Set([
	"completed",
	"failed",
	"interrupted",
	"cancelled",
]);

function hasForkCheckpoint(message: ChatMessage): boolean {
	const turn = message.meta?.turn;
	if (!turn) return false;
	if (
		typeof turn.meta?.agentSessionEntryId === "string" &&
		turn.meta.agentSessionEntryId.trim()
	)
		return true;
	const agent = turn.meta?.agent;
	return Boolean(
		agent &&
			typeof agent === "object" &&
			!Array.isArray(agent) &&
			typeof (agent as Record<string, unknown>).leafEntryId === "string" &&
			((agent as Record<string, unknown>).leafEntryId as string).trim(),
	);
}

function isTerminalDirectGeneration(message: ChatMessage): boolean {
	const turn = message.meta?.turn;
	return Boolean(
		turn?.executionKind === "direct_generation" &&
			TERMINAL_TURN_STATUSES.has(turn.status),
	);
}

export function getChatMessageForkState(
	message: ChatMessage,
	hasForkHandler: boolean,
	agentHarness?: AgentHarness | null,
): { visible: boolean; available: boolean } {
	const visible = Boolean(
		message.role === "assistant" &&
			message.meta?.messageKind &&
			TERMINAL_ASSISTANT_KINDS.has(message.meta.messageKind) &&
			message.meta.streaming !== true,
	);
	return {
		visible,
		available:
			visible &&
			hasForkHandler &&
			(hasForkCheckpoint(message) ||
				isTerminalDirectGeneration(message) ||
				agentHarness === "codex" ||
				agentHarness === "cursor" ||
				agentHarness === "grok_build"),
	};
}
