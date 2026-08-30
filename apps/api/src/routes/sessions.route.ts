import { createLogger } from "@cohub/infra/logging";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { hasPermission } from "../permissions.js";
import { getOptionalAuth, useAuth, requireValidId, authzDenied } from "../lib/middleware.js";
import {
  getSpaceById,
  getSpaceSessionById,
  getSessionMessageById,
  hydrateSessionParticipantProfiles,
  listSessionMessages,
  enqueueSessionAbort,
  enqueueSessionFork,
  updateSpaceSessionInfo,
} from "../space-sessions.js";
import { markMessageAsFull, summarizeMessageForHistory } from "../session-content.js";
import { createSignedTurnUrls, findLatestVisibleAgentEntryId, findLatestVisibleAgentRuntime, getSessionTurnById, getSessionTurnSequenceById, hydrateTurnAuthorProfiles, listSessionTurnIndex, listSessionTurns, listSessionTurnWindow } from "../session-turns.js";
import { clearSessionStreamSnapshot, getSessionStreamSnapshot, listPersistedTurnIntermediateMessages } from "../session-stream-snapshot.js";
import { createSessionFork, listSessionForksForSessions } from "../session-forks.js";
import { dispatchLabelAssignmentsUpdated } from "../realtime-events.js";
import { buildSessionTurnResponse } from "../session-turn-response.js";
import { parseSessionTitleInput } from "../session-title-input.js";
import { resolveSessionAgentFork } from "../session-agent-fork.js";


const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

router.post("/:id/turns/:turnId/fork", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.edit", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const sourceTurn = await getSessionTurnById(session.id, turnId);
  if (!sourceTurn) return c.json({ message: "turn not found" }, 404);
  if (!["completed", "failed", "interrupted", "cancelled"].includes(sourceTurn.status)) {
    return c.json({ message: "cannot fork a running turn" }, 400);
  }
  const sourceTurnId = sourceTurn.sourceTurnId ?? sourceTurn.id;

  const body = await c.req.json<{ title?: string | null }>().catch((): { title?: string | null } => ({}));
  const childSessionId = randomUUID();
  const anchorEntryId = session.agentHarness === "pi"
    ? await findLatestVisibleAgentEntryId(session.id, sourceTurn.sequence)
    : null;
  if (session.agentHarness === "pi" && !anchorEntryId && sourceTurn.executionKind !== "direct_generation") {
    return c.json({ message: "session checkpoint missing" }, 400);
  }

  const sourceMeta = record(sourceTurn.meta);
  const runtime = sourceTurn.executionKind === "agent"
    ? { model: sourceTurn.model, thinkingLevel: sourceTurn.thinkingLevel, meta: sourceMeta }
    : await findLatestVisibleAgentRuntime(session.id, sourceTurn.sequence);
  const forkPreparation = resolveSessionAgentFork({
    agentHarness: session.agentHarness,
    executionKind: sourceTurn.executionKind,
    parentExternalSessionId: session.externalSessionId,
    turnMeta: sourceMeta,
  });
  const model = nonEmptyText(runtime?.model);
  const thinkingLevel = nonEmptyText(runtime?.thinkingLevel)
    ?? nonEmptyText(runtime?.meta?.effectiveThinkingLevel);
  if (session.agentHarness !== "pi" && (!model || !thinkingLevel)) {
    return c.json({ message: "agent model checkpoint missing" }, 400);
  }

  let prepared: Awaited<ReturnType<typeof enqueueSessionFork>>;
  try {
    prepared = await enqueueSessionFork({
      spaceId: session.spaceId,
      sessionId: childSessionId,
      parentSessionId: session.id,
      anchorTurnId: sourceTurnId,
      anchorSequence: sourceTurn.sequence,
      anchorEntryId,
      agentHarness: session.agentHarness,
      forkStrategy: forkPreparation.strategy,
      parentExternalSessionId: session.externalSessionId,
      anchorExternalTurnId: forkPreparation.anchorExternalTurnId,
      model,
      thinkingLevel,
      serviceTier: nonEmptyText(runtime?.meta?.effectiveServiceTier),
    });
  } catch (error) {
    logger.error("[SessionFork] failed to prepare Agent branch", error);
    return c.json({
      message: error instanceof Error
        ? error.message.toLowerCase().replace(/\.$/, "")
        : "failed to prepare fork session",
    }, 503);
  }

  try {
    const { session: childSession, fork } = await createSessionFork({
      spaceId: session.spaceId,
      childSessionId,
      parentSessionId: session.id,
      turnId: sourceTurnId,
      sequence: sourceTurn.sequence,
      title: body.title,
      createdBy: user.uuid,
      externalSessionId: prepared.externalSessionId,
      agentFork: prepared.strategy === "pi_session"
        ? null
        : {
            strategy: prepared.strategy,
            anchorSequence: sourceTurn.sequence,
            bootstrapPending: prepared.strategy === "context_clone",
            preparedAt: new Date().toISOString(),
          },
    });
    // Notify clients so they proactively cache the inherited labels.
    dispatchLabelAssignmentsUpdated({
      spaceId: session.spaceId,
      resourceType: "session",
      resourceRef: childSession.id,
      sessionId: childSession.id,
    }).catch((error) => {
      logger.warn("[SessionFork] failed to dispatch label assignments updated", error);
    });
    const [hydratedChildSession] = await hydrateSessionParticipantProfiles([childSession]);
    const [enrichedFork] = await listSessionForksForSessions([childSession.id]);
    return c.json({ session: hydratedChildSession ?? childSession, fork: enrichedFork ?? fork });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "failed to fork session" }, 400);
  }
});

router.get("/:id", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const space = await getSpaceById(session.spaceId);
  if (!space) return c.json({ message: "session not found" }, 404);

  const [hydratedSession] = await hydrateSessionParticipantProfiles([session]);
  return c.json({ space, session: hydratedSession ?? session, user });
});

// ── PATCH /api/sessions/:id (rename) ─────────────────────────────────────────

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.edit", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const input = parseSessionTitleInput(await c.req.json<unknown>().catch(() => null));
  if (!input.success) return c.json({ message: "title must be a string or null" }, 400);

  await updateSpaceSessionInfo({ spaceId: session.spaceId, sessionId: session.id, title: input.title });

  const refreshed = await getSpaceSessionById(sessionId);
  const [hydratedSession] = await hydrateSessionParticipantProfiles([refreshed ?? session]);
  return c.json({ session: hydratedSession ?? refreshed ?? session });
});

router.get("/:id/turns", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const cursorParam = c.req.query("cursor");
  let cursor = cursorParam ? Number(cursorParam) : undefined;
  if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 1)) return c.json({ message: "invalid cursor" }, 400);
  cursor = cursor === undefined ? undefined : Math.floor(cursor);
  const rawLimit = Number(c.req.query("limit") ?? 30);
  if (!Number.isFinite(rawLimit)) return c.json({ message: "invalid limit" }, 400);
  const pageLimit = Math.min(Math.max(Math.floor(rawLimit), 1), 100);
  const directionParam = c.req.query("direction") ?? "older";
  if (directionParam !== "older" && directionParam !== "newer") return c.json({ message: "invalid direction" }, 400);
  const direction = directionParam;
  const fetchLimit = Math.min(pageLimit + 1, 101);
  const rows = await listSessionTurns(session.id, { cursor, limit: fetchLimit, direction });
  const hasMore = rows.length > pageLimit;
  const pageTurns = hasMore ? (direction === "newer" ? rows.slice(0, pageLimit) : rows.slice(1)) : rows;
  const turns = await hydrateTurnAuthorProfiles(pageTurns);
  return c.json({
    session,
    turns,
    hasMore,
    nextCursor: turns.length > 0
      ? direction === "older"
        ? turns[0]?.sequence
        : turns[turns.length - 1]?.sequence
      : undefined,
  });
});

router.get("/:id/turns/index", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const cursorParam = c.req.query("cursor");
  let cursor = cursorParam ? Number(cursorParam) : undefined;
  if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 1)) return c.json({ message: "invalid cursor" }, 400);
  cursor = cursor === undefined ? undefined : Math.floor(cursor);
  const rawLimit = Number(c.req.query("limit") ?? 200);
  if (!Number.isFinite(rawLimit)) return c.json({ message: "invalid limit" }, 400);
  const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 500);
  const result = await listSessionTurnIndex(session.id, { cursor, limit });
  return c.json({ session, ...result });
});

router.get("/:id/turns/window", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const turnId = c.req.query("turnId");
  let sequence = c.req.query("sequence") ? Number(c.req.query("sequence")) : undefined;
  if (turnId) {
    if (!requireValidId(turnId)) return c.json({ message: "invalid turn id" }, 400);
    const found = await getSessionTurnSequenceById(session.id, turnId);
    if (found == null) return c.json({ message: "turn not found" }, 404);
    sequence = found;
  }
  if (sequence === undefined || !Number.isFinite(sequence) || sequence < 1) return c.json({ message: "invalid sequence" }, 400);
  const before = Number(c.req.query("before") ?? 10);
  const after = Number(c.req.query("after") ?? 20);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return c.json({ message: "invalid window" }, 400);
  const result = await listSessionTurnWindow(session.id, { sequence: Math.floor(sequence), before, after });
  if (!result) return c.json({ message: "turn not found" }, 404);
  return c.json({ session, ...result, turns: await hydrateTurnAuthorProfiles(result.turns) });
});

router.get("/:id/turns/stream-snapshot", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const snapshot = await getSessionStreamSnapshot({ spaceId: session.spaceId, sessionId: session.id });
  if (snapshot?.turnId) {
    const turn = await getSessionTurnById(session.id, snapshot.turnId);
    if (!turn || (turn.status !== "running" && turn.status !== "abort_requested")) {
      await clearSessionStreamSnapshot({ spaceId: session.spaceId, sessionId: session.id });
      return c.json({ snapshot: null });
    }
  }

  return c.json({ snapshot });
});

router.get("/:id/turns/:turnId", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const response = await buildSessionTurnResponse(session, turnId);
  if (!response) return c.json({ message: "turn not found" }, 404);
  return c.json(response);
});

router.get("/:id/turns/:turnId/intermediate", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }
  const turn = await getSessionTurnById(session.id, turnId);
  if (!turn) return c.json({ message: "turn not found" }, 404);

  const messages = await listPersistedTurnIntermediateMessages({
    sessionId: turn.sourceSessionId ?? turn.sessionId,
    turnId: turn.sourceTurnId ?? turn.id,
  });
  return c.json({ messages });
});

router.post("/:id/turns/:turnId/signed-urls", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const turnId = c.req.param("turnId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!turnId || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }
  const turn = await getSessionTurnById(session.id, turnId);
  if (!turn) return c.json({ message: "turn not found" }, 404);

  const body = await c.req.json<{ objectKeys?: string[] }>().catch(() => null);
  const objectKeys = Array.isArray(body?.objectKeys) ? body.objectKeys.filter((key): key is string => typeof key === "string") : [];
  if (objectKeys.length === 0 || objectKeys.length > 50) return c.json({ message: "objectKeys is required" }, 400);
  let urls: Awaited<ReturnType<typeof createSignedTurnUrls>>;
  try {
    urls = await createSignedTurnUrls({ spaceId: session.spaceId, sessionId: session.id, turnId, objectKeys });
  } catch {
    return c.json({ message: "invalid object key" }, 400);
  }
  return c.json({ urls });
});

router.get("/:id/messages", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const cursorParam = c.req.query("cursor");
  const cursor = cursorParam ? Number(cursorParam) : undefined;
  const pageLimit = Math.min(Number(c.req.query("limit") ?? 30), 100) || 30;
  const direction = (c.req.query("direction") as "older" | "newer" | undefined) ?? "older";
  const detail = c.req.query("detail") === "full" ? "full" : "summary";

  // Always fetch +1 sentinel to correctly detect hasMore.
  // The sentinel position depends on the query direction:
  //   - Initial load (no cursor) or "older": sentinel is the oldest (index 0)
  //   - "newer": sentinel is the newest (last element)
  const fetchLimit = Math.min(pageLimit + 1, 101);

  const rows = await listSessionMessages(session.id, {
    cursor,
    limit: fetchLimit,
    direction,
  });
  const hasMore = rows.length > pageLimit;
  const pageMessages = hasMore
    ? (direction === "newer" ? rows.slice(0, -1) : rows.slice(1))
    : rows;
  const messages = detail === "full"
    ? pageMessages.map(markMessageAsFull)
    : pageMessages.map((message) => summarizeMessageForHistory(message));

  return c.json({
    session,
    messages,
    hasMore,
    nextCursor: pageMessages.length > 0
      ? direction === "older"
        ? (pageMessages[0]?.sequence ?? 0) - 1
        : (pageMessages[pageMessages.length - 1]?.sequence ?? 0)
      : undefined,
  });
});

router.get("/:id/messages/:messageId", async (c) => {
  const user = getOptionalAuth(c);
  const sessionId = c.req.param("id");
  const messageId = c.req.param("messageId");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  if (!messageId || !requireValidId(messageId)) return c.json({ message: "message not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const message = await getSessionMessageById(session.id, messageId);
  if (!message) return c.json({ message: "message not found" }, 404);
  const detail = c.req.query("detail") === "summary" ? "summary" : "full";

  return c.json({
    session,
    message: detail === "summary"
      ? summarizeMessageForHistory(message, { placeholderIntermediate: false })
      : markMessageAsFull(message),
  });
});

router.post("/:id/abort", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const sessionId = c.req.param("id");
  if (!sessionId || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId: session.spaceId, sessionId: session.id }))) {
    return authzDenied(c);
  }

  const body = await c.req.json<{ turnId?: string | null }>().catch(() => null);
  const turnId = body?.turnId?.trim() || null;
  if (turnId && !requireValidId(turnId)) return c.json({ message: "invalid turn id" }, 400);

  await enqueueSessionAbort({
    sessionId: session.id,
    actorUserId: user.uuid,
    turnId,
  });

  return c.json({ ok: true });
});

export default router;
