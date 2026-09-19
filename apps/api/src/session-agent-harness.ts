import { parseAgentHarness, type AgentHarness } from "@cohub/protocol";

export class InvalidAgentHarnessError extends Error {
  constructor() {
    super("agentHarness must be one of: pi, codex, grok_build, cursor");
    this.name = "InvalidAgentHarnessError";
  }
}

export class AgentHarnessLockedError extends Error {
  constructor() {
    super("agent harness is locked after the first turn");
    this.name = "AgentHarnessLockedError";
  }
}

export function resolveAgentHarness(value: unknown, fallback: AgentHarness | null): AgentHarness | null {
  if (value === undefined || value === null) return fallback;
  const harness = parseAgentHarness(value);
  if (!harness) throw new InvalidAgentHarnessError();
  return harness;
}

export function assertAgentHarnessLocked(current: AgentHarness, requested: AgentHarness | null): void {
  if (requested && requested !== current) throw new AgentHarnessLockedError();
}
