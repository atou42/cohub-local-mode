import type { AgentHarness } from "@cohub/protocol";

export type ExternalForkStrategy = "codex_native" | "context_clone";

export type PendingExternalForkBootstrap = {
	strategy: "context_clone";
	anchorSequence: number;
};

type ForkTranscriptTurn = {
	sequence: number;
	userText: string | null;
	assistantText: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parsePendingExternalForkBootstrap(
	meta: unknown,
): PendingExternalForkBootstrap | null {
	const agentFork = record(record(meta)?.agentFork);
	if (!agentFork) return null;
	if (agentFork.strategy !== "context_clone" && agentFork.strategy !== "codex_native") {
		throw new Error("External fork bootstrap strategy is invalid");
	}
	if (typeof agentFork.bootstrapPending !== "boolean") {
		throw new Error("External fork bootstrap pending state is invalid");
	}
	if (agentFork.bootstrapPending === false) return null;
	if (agentFork.strategy !== "context_clone") {
		throw new Error("Native Codex Fork cannot request transcript bootstrap");
	}
	const anchorSequence = agentFork.anchorSequence;
	if (!Number.isInteger(anchorSequence) || Number(anchorSequence) < 1) {
		throw new Error("External fork bootstrap anchor sequence is invalid");
	}
	return { strategy: "context_clone", anchorSequence: Number(anchorSequence) };
}

export function buildExternalForkBootstrapPrompt(input: {
	harness: Exclude<AgentHarness, "pi">;
	turns: ForkTranscriptTurn[];
	prompt: string;
}) {
	const transcript = input.turns.flatMap((turn) => {
		const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
		if (turn.userText?.trim()) {
			messages.push({ role: "user", content: turn.userText.trim() });
		}
		if (turn.assistantText?.trim()) {
			messages.push({ role: "assistant", content: turn.assistantText.trim() });
		}
		return messages;
	});
	if (transcript.length === 0) {
		throw new Error("External fork transcript is empty");
	}
	return [
		"[Cohub fork context]",
		"Continue the forked conversation from the complete visible transcript below. Events after this transcript do not exist in this branch.",
		JSON.stringify(transcript),
		"[Current user request]",
		input.prompt,
	].join("\n\n");
}
