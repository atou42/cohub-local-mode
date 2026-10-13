import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { sessionTurns } from "@cohub/db";
import { type Actor, type ActorModel, actorKindOf } from "@cohub/protocol/provenance";
import { db } from "../db/index.js";
import { getRequestSource } from "./request-source.js";
import { getExecutionPrincipal, getOptionalAuth } from "./middleware.js";

const modelCache = new Map<string, ActorModel | null>();
const MODEL_CACHE_SIZE = 512;

async function turnModel(turnId: string, userUuid: string): Promise<ActorModel | null> {
  const key = `${turnId}:${userUuid}`;
  const cached = modelCache.get(key);
  if (cached !== undefined) return cached;
  const [turn] = await db
    .select({ provider: sessionTurns.provider, model: sessionTurns.model })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.userUuid, userUuid)))
    .limit(1);
  const model = turn?.model ? { provider: turn.provider ?? null, id: turn.model } : null;
  if (modelCache.size >= MODEL_CACHE_SIZE) modelCache.delete(modelCache.keys().next().value as string);
  modelCache.set(key, model);
  return model;
}

export async function resolveRequestActor(c: Context): Promise<Actor> {
  const source = getRequestSource(c);
  const execution = getExecutionPrincipal(c);
  const kind = execution?.turnId ? "agent" : actorKindOf(source);
  if (kind !== "agent") return { kind };
  const userUuid = getOptionalAuth(c)?.uuid;
  const turnId = execution?.turnId ?? source?.turnId;
  const model = turnId && userUuid ? await turnModel(turnId, userUuid).catch(() => null) : null;
  return model ? { kind, model } : { kind };
}
