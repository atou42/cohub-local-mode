import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import type { AgentHarness } from "@cohub/protocol";
import { QueueEvents, type JobsOptions } from "bullmq";
import { config } from "./config.js";

export const AGENT_TURN_QUEUE_NAME = COHUB_AGENT_TURNS_QUEUE;
export const AGENT_TURN_JOB_NAME = "agent_turns";
export const AGENT_SESSION_FORK_JOB_NAME = "agent_session_fork";

export type AgentTurnJobData = {
  spaceId: string;
  sessionId: string;
  reason?: "prompt" | "steer" | "drain" | "retry" | "recovery";
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentSessionForkJobData = {
  spaceId: string;
  sessionId: string;
  parentSessionId: string;
  anchorTurnId: string;
  anchorSequence: number;
  anchorEntryId?: string | null;
  agentHarness: AgentHarness;
  forkStrategy: "pi_session" | "codex_native" | "context_clone";
  parentExternalSessionId?: string | null;
  anchorExternalTurnId?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  serviceTier?: string | null;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentSessionForkJobResult = {
  sessionId: string;
  externalSessionId: string | null;
  strategy: "pi_session" | "codex_native" | "context_clone";
};

export type AgentJobData = AgentTurnJobData | AgentSessionForkJobData;

export const agentTurnQueue = createBullmqQueue<AgentJobData>(AGENT_TURN_QUEUE_NAME, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-agent-turns",
});

let sessionForkQueueEvents: QueueEvents | null = null;
let sessionForkQueueEventsReady: Promise<void> | null = null;

async function getSessionForkQueueEvents() {
  if (!sessionForkQueueEvents) {
    sessionForkQueueEvents = new QueueEvents(AGENT_TURN_QUEUE_NAME, {
      connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
    });
    sessionForkQueueEventsReady = sessionForkQueueEvents.waitUntilReady().then(() => undefined);
  }
  await sessionForkQueueEventsReady;
  return sessionForkQueueEvents;
}

export async function enqueueAgentTurnJob(
  data: AgentTurnJobData,
  options: JobsOptions = {},
) {
  return agentTurnQueue.add(AGENT_TURN_JOB_NAME, data, {
    jobId: `agent-session-wakeup-${data.sessionId}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
    removeOnComplete: true,
    removeOnFail: defaultJobRetention.removeOnFail,
    ...options,
  });
}

export async function enqueueAgentSessionForkJob(
  data: AgentSessionForkJobData,
  options: JobsOptions = {},
) {
  return agentTurnQueue.add(AGENT_SESSION_FORK_JOB_NAME, data, {
    jobId: `agent-session-fork-${data.sessionId}-${data.anchorEntryId ?? data.anchorTurnId}`,
    attempts: 1,
    ...defaultJobRetention,
    ...options,
  });
}

export async function prepareAgentSessionFork(
  data: AgentSessionForkJobData,
): Promise<AgentSessionForkJobResult> {
  const events = await getSessionForkQueueEvents();
  const job = await enqueueAgentSessionForkJob(data);
  return await job.waitUntilFinished(events, 60_000) as AgentSessionForkJobResult;
}
