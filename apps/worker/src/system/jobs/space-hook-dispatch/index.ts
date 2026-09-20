import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import {
  buildSpaceHookDefinitionFingerprint,
  invalidateSpaceHooksCache,
  loadSpaceHookDefinitions,
  partitionSpaceHooksForEvent,
  type SpaceHookDispatchResult,
} from "@cohub/core/hooks";
import {
  buildSpaceHookExecutePayload,
  buildSpaceHookTaskId,
} from "@cohub/infra/space-hooks";
import {
  SPACE_HOOK_DISPATCH_JOB,
  shouldRefreshSpaceHooksCache,
  type SpaceHookEventEnvelope,
} from "@cohub/protocol";
import { spaces } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../../../db.js";
import { getSpaceWorkspaceDir } from "../../../git.js";
import { redisCommandClient } from "../../../redis.js";
import { enqueueTask } from "../../../tasks/enqueue.js";
import { registerSystemJob } from "../../registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectChangedPaths(payload: Record<string, unknown>) {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const paths: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    if (typeof change.path === "string" && change.path.trim()) paths.push(change.path);
    if (typeof change.oldPath === "string" && change.oldPath.trim()) paths.push(change.oldPath);
  }
  return paths;
}

function parseDispatchEvent(data: unknown): {
  event: SpaceHookEventEnvelope;
  eventActorUserId: string | null;
} {
  if (!isRecord(data)) throw new Error("space_hook.dispatch requires job data");
  const eventRaw = isRecord(data.event) ? data.event : null;
  if (!eventRaw) throw new Error("space_hook.dispatch requires data.event");
  const id = asString(eventRaw.id);
  const type = asString(eventRaw.type);
  const spaceId = asString(eventRaw.spaceId);
  if (!id || !type || !spaceId) {
    throw new Error("space_hook.dispatch event is missing id/type/spaceId");
  }
  return {
    event: {
      id,
      type,
      timestamp: typeof eventRaw.timestamp === "number" ? eventRaw.timestamp : Date.now(),
      spaceId,
      sessionId: asString(eventRaw.sessionId),
      payload: isRecord(eventRaw.payload) ? eventRaw.payload : {},
    },
    eventActorUserId: asString(data.eventActorUserId),
  };
}

async function resolveSpaceOwnerUserId(spaceId: string) {
  const [space] = await db
    .select({ userUuid: spaces.userUuid })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return space?.userUuid?.trim() || null;
}

registerSystemJob(SPACE_HOOK_DISPATCH_JOB, async (job: Job): Promise<SpaceHookDispatchResult> => {
  const { event, eventActorUserId } = parseDispatchEvent(job.data);
  const spaceId = event.spaceId;

  const refreshCache = shouldRefreshSpaceHooksCache({
    type: event.type,
    paths: collectChangedPaths(event.payload),
  });
  if (refreshCache) {
    const invalidated = await invalidateSpaceHooksCache({ spaceId, redis: redisCommandClient });
    if (!invalidated) {
      logger.warn("[SpaceHooks] failed to invalidate definitions cache; forcing disk load", {
        spaceId,
        eventId: event.id,
      });
    }
  }

  const ownerUserId = await resolveSpaceOwnerUserId(spaceId);
  if (!ownerUserId) {
    return {
      eventId: event.id,
      eventType: event.type,
      spaceId,
      definitionsCount: 0,
      matchedCount: 0,
      cache: "miss",
      skipped: "missing_space_owner",
    };
  }

  const loaded = await loadSpaceHookDefinitions({
    spaceId,
    workspaceDir: getSpaceWorkspaceDir(spaceId),
    redis: redisCommandClient,
    allowCache: !refreshCache,
  });

  if (loaded.definitions.length === 0) {
    return {
      eventId: event.id,
      eventType: event.type,
      spaceId,
      definitionsCount: 0,
      matchedCount: 0,
      cache: loaded.cache,
      skipped: "empty_definitions",
    };
  }

  const { matched } = partitionSpaceHooksForEvent(loaded.definitions, event);
  if (matched.length === 0) {
    return {
      eventId: event.id,
      eventType: event.type,
      spaceId,
      definitionsCount: loaded.definitions.length,
      matchedCount: 0,
      cache: loaded.cache,
      skipped: "no_match",
    };
  }

  const matchedHooks = matched.map((definition) => ({
    path: definition.path,
    fingerprint: buildSpaceHookDefinitionFingerprint(definition),
  }));
  const taskPayload = buildSpaceHookExecutePayload({
    event,
    eventActorUserId,
    ownerUserId,
    matchedHooks,
  });
  const taskRunId = buildSpaceHookTaskId({
    spaceId,
    eventId: event.id,
    eventType: event.type,
  });

  try {
    const enqueued = await enqueueTask(taskPayload, { jobId: taskRunId });
    return {
      eventId: event.id,
      eventType: event.type,
      spaceId,
      definitionsCount: loaded.definitions.length,
      matchedCount: matched.length,
      cache: loaded.cache,
      taskRunId: enqueued.taskRunId,
    };
  } catch (error) {
    logger.warn("[SpaceHooks] failed to enqueue execute task", {
      spaceId,
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Rethrow so BullMQ can retry dispatch; matched work must not be dropped.
    throw error;
  }
});
