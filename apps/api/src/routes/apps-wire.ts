import type { apps, appVersions, appPromotions } from "@cohub/db";
import type { AppVersionSource } from "@cohub/protocol";
import type {
  RealtimeAppRecord,
  RealtimeAppVersionRecord,
} from "@cohub/protocol/realtime";

/**
 * Wire dialects for the dual-mounted works REST surface. The canonical
 * `/api/apps` mount speaks the app vocabulary (`app`, `apps`, `appScopes`,
 * `appId`); the legacy `/api/works` mount keeps the work-era field names so
 * older SDK versions and direct REST consumers keep working until the next
 * breaking protocol version.
 */
export type AppWire = "canonical" | "legacy";

/** Legacy `/api/works` record shape: `workScopes` where canonical says `appScopes`. */
export type LegacyWorkRecord = Omit<RealtimeAppRecord, "appScopes"> & {
  workScopes: string[];
};

/** Legacy `/api/works` version shape: `workId` where canonical says `appId`. */
export type LegacyWorkVersionRecord = Omit<RealtimeAppVersionRecord, "appId"> & {
  workId: string;
};

export type AppWireRecord = RealtimeAppRecord | LegacyWorkRecord;
export type AppWireVersionRecord = RealtimeAppVersionRecord | LegacyWorkVersionRecord;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Version provenance is served through the permission-gated `source` field, so
 * the raw `meta.source` stamped at publish time must never be re-emitted — it
 * would hand out a private session id to anyone who can read the version.
 */
function versionMetaForWire(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record || !("source" in record)) return record;
  const { source: _source, ...rest } = record;
  return Object.keys(rest).length > 0 ? rest : null;
}

export function serializeAppRecord(app: typeof apps.$inferSelect, wire: "canonical"): RealtimeAppRecord;
export function serializeAppRecord(app: typeof apps.$inferSelect, wire: "legacy"): LegacyWorkRecord;
export function serializeAppRecord(app: typeof apps.$inferSelect, wire: AppWire): AppWireRecord;
export function serializeAppRecord(
  app: typeof apps.$inferSelect,
  wire: AppWire,
): AppWireRecord {
  const record = {
    id: app.id,
    spaceId: app.spaceId,
    userUuid: app.userUuid,
    slug: app.slug,
    status: app.status as RealtimeAppRecord["status"],
    visibility: (app.visibility ?? "public") as RealtimeAppRecord["visibility"],
    targetType: app.targetType as RealtimeAppRecord["targetType"],
    targetRef: app.targetRef,
    assetKey: app.assetKey,
    currentVersionId: app.currentVersionId,
    latestVersion: app.latestVersion ?? 0,
    publishedAt: app.publishedAt?.toISOString() ?? null,
    allowedViewerScopes: app.allowedViewerScopes ?? [],
    meta: asRecord(app.meta),
    createdAt: app.createdAt?.toISOString() ?? null,
    updatedAt: app.updatedAt?.toISOString() ?? null,
  };
  const scopes = app.appScopes ?? [];
  return wire === "legacy"
    ? { ...record, workScopes: scopes }
    : { ...record, appScopes: scopes };
}

export function serializeAppVersionRecord(
  version: typeof appVersions.$inferSelect,
  wire: "canonical",
  source?: AppVersionSource | null,
): RealtimeAppVersionRecord;
export function serializeAppVersionRecord(
  version: typeof appVersions.$inferSelect,
  wire: "legacy",
  source?: AppVersionSource | null,
): LegacyWorkVersionRecord;
export function serializeAppVersionRecord(
  version: typeof appVersions.$inferSelect,
  wire: AppWire,
  source?: AppVersionSource | null,
): AppWireVersionRecord;
export function serializeAppVersionRecord(
  version: typeof appVersions.$inferSelect,
  wire: AppWire,
  source: AppVersionSource | null = null,
): AppWireVersionRecord {
  const record = {
    id: version.id,
    version: version.version,
    targetType: version.targetType as RealtimeAppVersionRecord["targetType"],
    targetRef: version.targetRef,
    assetKey: version.assetKey,
    contentKind: version.contentKind as RealtimeAppVersionRecord["contentKind"],
    artifact: asRecord(version.artifact) as RealtimeAppVersionRecord["artifact"],
    meta: versionMetaForWire(version.meta) as RealtimeAppVersionRecord["meta"],
    source,
    createdAt: version.createdAt?.toISOString() ?? null,
  };
  return wire === "legacy"
    ? { ...record, workId: version.appId }
    : { ...record, appId: version.appId };
}

/** `{ app }` on the canonical mount, `{ work }` on the legacy mount. */
export function wrapAppRecord(wire: AppWire, record: AppWireRecord) {
  return wire === "legacy" ? { work: record } : { app: record };
}

/** `{ apps }` on the canonical mount, `{ works }` on the legacy mount. */
export function wrapAppRecords(wire: AppWire, records: AppWireRecord[]) {
  return wire === "legacy" ? { works: records } : { apps: records };
}

/** Request-body scope field: `workScopes` on the legacy mount, `appScopes` canonical. */
export function appScopesBodyField(wire: AppWire): "workScopes" | "appScopes" {
  return wire === "legacy" ? "workScopes" : "appScopes";
}

/** Promotion record: `workId` on the legacy mount, `appId` canonical. */
export function serializePromotionRecord(
  row: typeof appPromotions.$inferSelect,
  wire: AppWire,
) {
  return {
    id: row.id,
    ...(wire === "legacy" ? { workId: row.appId } : { appId: row.appId }),
    name: row.name,
    provider: row.provider,
    parameters: row.parameters,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
