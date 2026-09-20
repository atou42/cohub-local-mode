import { createLogger } from "@cohub/infra/logging";
import { and, desc, eq, inArray } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import { runtimeRegistrationKey, parseRuntimeRegistration, isLocalHarness, type RuntimeRegistration, type RuntimeStopConfirmation } from "@cohub/protocol";
import { readRuntimeRecovery, runtimeRecoverySnapshot } from "@cohub/core/sessions";
import { enqueueRuntimeRecovery } from "@cohub/infra/agent-queue";
import { redisCommandClient } from "./redis.js";
import { db } from "./db/index.js";
import { agentTurnQueue } from "./agent-turn-queue.js";

const logger = createLogger({ serviceName: "cohub-api" });

export async function getRuntimeRegistration(spaceId: string): Promise<RuntimeRegistration | null> {
  const raw = await redisCommandClient.get(runtimeRegistrationKey(spaceId));
  if (!raw) return null;
  const record = parseRuntimeRegistration(raw);
  if (!record) logger.warn("[Runtime] ignoring invalid registration", { spaceId });
  return record;
}

async function getSessionRuntimeTurn(spaceId: string, sessionId: string) {
  const rows = await db.select({ turn: sessionTurns }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(
      eq(spaceSessions.id, sessionId),
      eq(spaceSessions.spaceId, spaceId),
      eq(sessionTurns.executionKind, "agent"),
      inArray(sessionTurns.status, ["running", "abort_requested"]),
    ))
    .orderBy(desc(sessionTurns.sequence)).limit(2);
  if (rows.length > 1) throw new Error("Session has multiple active Agent turns");
  const turn = rows[0]?.turn ?? null;
  const harness = turn ? (turn.meta as { harness?: unknown } | null)?.harness : null;
  return turn && isLocalHarness(harness) ? { ...turn, harness } : null;
}

export async function getSessionRuntimeRecovery(spaceId: string, sessionId: string) {
  const turn = await getSessionRuntimeTurn(spaceId, sessionId);
  const pending = turn ? readRuntimeRecovery(turn.meta)?.state === "attention" : false;
  const snapshot = runtimeRecoverySnapshot(pending && turn ? [turn] : []);
  return { pending, revision: snapshot.revision, turnId: pending && turn ? turn.id : null, harness: pending && turn ? turn.harness : null };
}

export async function confirmRuntimeStopped(spaceId: string, sessionId: string, actorUserId: string, request: RuntimeStopConfirmation) {
  const turn = await getSessionRuntimeTurn(spaceId, sessionId);
  if (!turn || turn.id !== request.expectedTurnId || readRuntimeRecovery(turn.meta)?.state !== "attention") return false;
  const snapshot = runtimeRecoverySnapshot([turn]);
  if (request.revision !== snapshot.revision) return false;
  const ownerUserId = readRuntimeRecovery(turn.meta)?.ownerUserId;
  if (!ownerUserId) return false;
  await enqueueRuntimeRecovery(agentTurnQueue, {
    spaceId,
    sessionId,
    expectedTurnId: turn.id,
    expectedHarness: turn.harness,
    expectedOwnerUserId: ownerUserId,
    confirmation: { actorUserId, revision: snapshot.revision },
  });
  return true;
}
