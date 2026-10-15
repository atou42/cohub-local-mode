import { syncTaskBoards, boardChangedEvent } from "@cohub/core/board";
import { createLogger } from "@cohub/infra/logging";
import { REALTIME_OUTBOUND_CHANNEL } from "@cohub/protocol/realtime";
import { db } from "./db.js";
import { redisCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const TASK_SOURCE = { via: "task" } as const;
const RETRY_DELAYS_MS = [2_000, 10_000];

export async function syncFinishedTaskBoards(run: {
  id: string;
  spaceId: string | null;
  userUuid: string | null;
  status: string;
  updatedAt: Date | string | null;
}) {
  if (!run.spaceId || (run.status !== "completed" && run.status !== "failed")) return;
  const spaceId = run.spaceId;
  const actorId = run.userUuid ?? "system";
  const revision = `${run.status}:${run.updatedAt instanceof Date ? run.updatedAt.toISOString() : (run.updatedAt ?? "")}`;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let failed = 0;
    const fail = (error: unknown, boardId?: string) => {
      failed += 1;
      logger.warn("[BoardTasks] failed to update Boards", { taskRunId: run.id, spaceId, boardId, attempt, error });
    };
    const writes = await syncTaskBoards(db, {
      spaceId,
      taskRunId: run.id,
      revision,
      actorId,
      source: TASK_SOURCE,
      onError: (boardId, error) => fail(error, boardId),
    }).catch((error) => {
      fail(error);
      return [];
    });
    await Promise.all(writes.map(async ({ boardId, outcome }) => {
      const event = boardChangedEvent({ spaceId, boardId, actorId, actor: { kind: "user" }, outcome, source: TASK_SOURCE });
      if (event) await redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(event));
    }));
    const delay = RETRY_DELAYS_MS[attempt];
    if (!failed || delay === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
