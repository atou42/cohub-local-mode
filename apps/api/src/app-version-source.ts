import { and, eq, inArray } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import type { AppVersionSource } from "@cohub/protocol";
import type { AuthUserProfile } from "./auth.js";
import { db } from "./db/index.js";
import { filterSessionsByPermission, getSpaceMemberRole } from "./permissions.js";

type AppVersionRow = typeof import("@cohub/db").appVersions.$inferSelect;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Raw provenance recorded on a version at publish time (`meta.source`). */
const readVersionSource = (
  meta: unknown,
): { sessionId?: string; turnId?: string; via?: string } | null => {
  const source = isRecord(meta) && isRecord(meta.source) ? meta.source : null;
  if (!source) return null;
  const sessionId = readString(source.sessionId);
  const turnId = readString(source.turnId);
  const via = readString(source.via);
  if (!sessionId && !turnId && !via) return null;
  return { ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}), ...(via ? { via } : {}) };
};

const withoutSession = (
  raw: { via?: string },
): AppVersionSource | null => (raw.via ? { via: raw.via } : null);

/**
 * Resolves the provenance summary for each version. Session identity — and the
 * session title — is attached only when the caller holds `session.view` for the
 * source session, so a private session never leaks through a published app.
 * Membership is checked once; non-members reuse the batched policy filter.
 */
export async function resolveAppVersionSources(input: {
  /** Any projection that carries the version id and stored meta. */
  versions: Pick<AppVersionRow, "id" | "meta">[];
  spaceId: string;
  user: AuthUserProfile | null;
}): Promise<Map<string, AppVersionSource | null>> {
  const resolved = new Map<string, AppVersionSource | null>();
  if (input.versions.length === 0) return resolved;

  const entries = input.versions.map((version) => ({
    id: version.id,
    raw: readVersionSource(version.meta),
  }));

  const sessionIds = [
    ...new Set(
      entries
        .map((entry) => entry.raw?.sessionId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (sessionIds.length === 0) {
    for (const entry of entries) {
      resolved.set(entry.id, entry.raw ? withoutSession(entry.raw) : null);
    }
    return resolved;
  }

  const turnIds = [
    ...new Set(
      entries.map((entry) => entry.raw?.turnId).filter((id): id is string => Boolean(id)),
    ),
  ];
  // Provenance arrives from caller-supplied headers, so ownership is proven
  // against the app's own space: a version can never point at another space's
  // session, nor pair a turn with a session it does not belong to.
  const [sessions, turns] = await Promise.all([
    db
      .select()
      .from(spaceSessions)
      .where(and(inArray(spaceSessions.id, sessionIds), eq(spaceSessions.spaceId, input.spaceId))),
    turnIds.length > 0
      ? db
          .select({ id: sessionTurns.id, sessionId: sessionTurns.sessionId, sequence: sessionTurns.sequence })
          .from(sessionTurns)
          .where(inArray(sessionTurns.id, turnIds))
      : Promise.resolve([] as { id: string; sessionId: string; sequence: number }[]),
  ]);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));

  const userId = input.user?.uuid ?? null;
  const isMember =
    userId !== null && (await getSpaceMemberRole(input.spaceId, userId)) !== null;
  // Only sessions that actually live in this space count as visible.
  const visibleSessionIds = new Set(
    isMember
      ? sessionById.keys()
      : (
          await filterSessionsByPermission(
            input.user,
            "session.view",
            input.spaceId,
            sessions,
          )
        ).map((session) => session.id),
  );

  for (const entry of entries) {
    const raw = entry.raw;
    if (!raw) {
      resolved.set(entry.id, null);
      continue;
    }
    const { sessionId, turnId } = raw;
    if (!sessionId || !visibleSessionIds.has(sessionId)) {
      resolved.set(entry.id, withoutSession(raw));
      continue;
    }
    const session = sessionById.get(sessionId);
    const turn = turnId ? turnById.get(turnId) : undefined;
    // A turn only deep-links when it truly belongs to this session.
    const turnSequence = turn?.sessionId === sessionId ? turn.sequence : undefined;
    resolved.set(entry.id, {
      ...(raw.via ? { via: raw.via } : {}),
      sessionId,
      ...(turnId && turn?.sessionId === sessionId ? { turnId } : {}),
      ...(turnSequence !== undefined ? { turnSequence } : {}),
      session: { id: sessionId, title: session?.title ?? null },
    });
  }
  return resolved;
}
