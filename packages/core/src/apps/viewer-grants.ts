import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { apps, appViewerGrants } from "@cohub/db";
import {
  createDrizzlePermissionStore,
  intersectPermissionScopes,
  normalizeAppPublisherScopes,
  normalizePermissionScopes,
  resolvePermissionAccess,
  type Permission,
} from "../permissions/index.js";

type DrizzlePermissionDb = PostgresJsDatabase<Record<string, unknown>>;

/** The app-side half of a delegated authorization decision. */
export type DelegatedAppAuthorization =
  | { active: false }
  | { active: true; appScopes: Permission[] };

/**
 * Decides the app-side half of a delegated authorization, purely:
 *
 * - A published app is the master switch — once it is missing or disabled the
 *   whole delegation is off, so queued tasks cannot keep running on a
 *   lingering viewer grant.
 * - Publisher scopes bind to the app's home space only. A cross-space target
 *   keeps the delegation active with no app-side scopes; the viewer's own
 *   grant on that space still applies.
 */
export function delegatedAppAuthorization(
  app: { status: string; spaceId: string; appScopes: unknown } | null | undefined,
  targetSpaceId: string,
): DelegatedAppAuthorization {
  if (!app) return { active: false };
  if (app.status !== "published") return { active: false };
  const appScopes = app.spaceId === targetSpaceId
    ? normalizeAppPublisherScopes(app.appScopes as string[])
    : [];
  return { active: true, appScopes };
}

/**
 * Resolves everything a delegated app authorization may do on a space, from
 * server state only: the app's live publisher scopes (home space only) plus
 * the viewer's live grant scopes on the target space. Payload snapshots are
 * references, never authorization.
 */
export async function resolveDelegatedAppScopesAtUseTime(input: {
  db: DrizzlePermissionDb;
  appId: string;
  grantId?: string;
  viewerUserUuid: string;
  spaceId: string;
}): Promise<{ appScopes: Permission[]; viewerScopes: Permission[] }> {
  const [app] = await input.db
    .select({ status: apps.status, spaceId: apps.spaceId, appScopes: apps.appScopes })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  const decision = delegatedAppAuthorization(app, input.spaceId);
  if (!decision.active) return { appScopes: [], viewerScopes: [] };
  const viewerScopes = input.grantId
    ? await resolveViewerGrantScopesAtUseTime({
        db: input.db,
        grantId: input.grantId,
        appId: input.appId,
        viewerUserUuid: input.viewerUserUuid,
        spaceId: input.spaceId,
      })
    : [];
  return { appScopes: decision.appScopes, viewerScopes };
}

/**
 * Re-validates a viewer grant at use time. The row must match its full
 * identity (id + natural key: app, viewer, space) and still be alive, and only
 * scopes the viewer can still exercise on the space survive. Prompt submission
 * and delayed executions (scheduled tasks) both call this, so a revoked grant
 * or a role downgrade never outlives its consent snapshot.
 */
export async function resolveViewerGrantScopesAtUseTime(input: {
  db: DrizzlePermissionDb;
  grantId: string;
  appId: string;
  viewerUserUuid: string;
  spaceId: string;
}): Promise<Permission[]> {
  const [grant] = await input.db
    .select({ scopes: appViewerGrants.scopes, expiresAt: appViewerGrants.expiresAt, revokedAt: appViewerGrants.revokedAt })
    .from(appViewerGrants)
    .where(and(
      eq(appViewerGrants.id, input.grantId),
      eq(appViewerGrants.appId, input.appId),
      eq(appViewerGrants.viewerUserUuid, input.viewerUserUuid),
      eq(appViewerGrants.spaceId, input.spaceId),
    ))
    .limit(1);
  if (!grant || grant.revokedAt) return [];
  if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) return [];
  const held = normalizePermissionScopes(grant.scopes as string[]);
  if (held.length === 0) return [];
  const access = await resolvePermissionAccess({
    store: createDrizzlePermissionStore(input.db),
    user: { uuid: input.viewerUserUuid },
    context: { spaceId: input.spaceId },
  });
  return intersectPermissionScopes(held, access.permissions);
}
