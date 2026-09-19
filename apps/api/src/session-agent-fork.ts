import type { AgentHarness } from "@cohub/protocol";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveSessionAgentFork(input: {
  agentHarness: AgentHarness;
  executionKind?: string | null;
  parentExternalSessionId?: string | null;
  turnMeta?: Record<string, unknown> | null;
}) {
  if (input.agentHarness === "pi") {
    return { strategy: "pi_session" as const, anchorExternalTurnId: null };
  }
  const checkpoint = record(input.turnMeta?.forkCheckpoint);
  const externalTurnId = text(checkpoint?.externalTurnId);
  const nativeCodex = input.agentHarness === "codex"
    && input.executionKind === "agent"
    && checkpoint?.harness === "codex"
    && text(checkpoint.externalSessionId) === text(input.parentExternalSessionId)
    && externalTurnId;
  return nativeCodex
    ? { strategy: "codex_native" as const, anchorExternalTurnId: externalTurnId }
    : { strategy: "context_clone" as const, anchorExternalTurnId: null };
}
