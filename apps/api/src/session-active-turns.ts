import type { SessionActiveTurn, SessionTurnStatus } from "@cohub/protocol/model";

/**
 * The subset of an active `session_turns` row that shapes a `SessionActiveTurn`.
 * Rows are expected newest-first per session and already filtered to active
 * statuses; the first row for a session wins.
 */
export type ActiveTurnRow = {
  sessionId: string;
  id: string;
  status: SessionTurnStatus;
  provider: string | null;
  model: string | null;
  startedAt: Date | null;
  meta: unknown;
};

const readAnchorUserMessageId = (meta: unknown): string | null => {
  const record = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : null;
  return typeof record?.userMessageId === "string" ? record.userMessageId : null;
};

/**
 * Attach the active turn (if any) to each session, preserving the input order.
 * Pure — the caller owns the query, this owns the shape.
 */
export const pickActiveTurns = <T extends { id: string }>(
  sessions: T[],
  rows: ActiveTurnRow[],
): (T & { activeTurn: SessionActiveTurn | null })[] => {
  const bySessionId = new Map<string, SessionActiveTurn>();
  for (const row of rows) {
    if (bySessionId.has(row.sessionId)) continue;
    bySessionId.set(row.sessionId, {
      id: row.id,
      status: row.status as SessionActiveTurn["status"],
      provider: row.provider ?? null,
      model: row.model ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      anchorUserMessageId: readAnchorUserMessageId(row.meta),
    });
  }
  return sessions.map((session) => ({ ...session, activeTurn: bySessionId.get(session.id) ?? null }));
};
