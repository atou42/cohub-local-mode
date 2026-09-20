import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appScopesBodyField,
  serializeAppRecord,
  serializeAppVersionRecord,
  serializePromotionRecord,
  wrapAppRecord,
  wrapAppRecords,
} from "./apps-wire.js";

/**
 * The works REST surface serves two wire dialects from the same handlers:
 * canonical `/api/apps` (app vocabulary) and legacy `/api/works` (work-era
 * field names for older SDK versions and direct REST consumers). These tests
 * pin both vocabularies so neither mount can drift.
 */

const appRow = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  spaceId: "660e8400-e29b-41d4-a716-446655440001",
  userUuid: "user-1",
  slug: "launch",
  status: "published",
  visibility: "public",
  targetType: "directory",
  targetRef: "dist",
  assetKey: "w/space-1/launch/abc/index.html",
  currentVersionId: "770e8400-e29b-41d4-a716-446655440002",
  latestVersion: 3,
  publishedAt: new Date("2026-08-01T00:00:00.000Z"),
  appScopes: ["space.view"],
  allowedViewerScopes: ["session.prompt.readonly"],
  meta: { title: "Launch" },
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
} as Parameters<typeof serializeAppRecord>[0];

const versionRow = {
  id: "770e8400-e29b-41d4-a716-446655440002",
  appId: "550e8400-e29b-41d4-a716-446655440000",
  version: 3,
  targetType: "directory",
  targetRef: "dist",
  assetKey: null,
  contentKind: "web",
  artifact: null,
  meta: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
} as Parameters<typeof serializeAppVersionRecord>[0];

const promotionRow = {
  id: "880e8400-e29b-41d4-a716-446655440003",
  appId: "550e8400-e29b-41d4-a716-446655440000",
  name: "Launch campaign",
  provider: "generic",
  parameters: { utm_source: "x" },
  createdBy: "user-1",
  createdAt: new Date("2026-08-02T00:00:00.000Z"),
} as Parameters<typeof serializePromotionRecord>[0];

test("canonical /api/apps wire speaks the app vocabulary", () => {
  const record = serializeAppRecord(appRow, "canonical");
  assert.ok("appScopes" in record, "record uses appScopes");
  assert.ok(!("workScopes" in record));
  assert.deepEqual(wrapAppRecord("canonical", record), { app: record });
  assert.deepEqual(Object.keys(wrapAppRecords("canonical", [record])), ["apps"]);

  const version = serializeAppVersionRecord(versionRow, "canonical");
  assert.ok("appId" in version, "version uses appId");
  assert.ok(!("workId" in version));
  assert.equal(version.source, null, "version defaults to no provenance");

  assert.ok("appId" in serializePromotionRecord(promotionRow, "canonical"));
  assert.equal(appScopesBodyField("canonical"), "appScopes");
});

test("version meta never re-emits the raw publish source", () => {
  const withSource = {
    ...versionRow,
    meta: { title: "Launch", source: { sessionId: "770e8400-e29b-41d4-a716-446655440010" } },
  } as Parameters<typeof serializeAppVersionRecord>[0];
  assert.deepEqual(serializeAppVersionRecord(withSource, "canonical").meta, { title: "Launch" });

  const sourceOnly = {
    ...versionRow,
    meta: { source: { sessionId: "770e8400-e29b-41d4-a716-446655440010" } },
  } as Parameters<typeof serializeAppVersionRecord>[0];
  assert.equal(serializeAppVersionRecord(sourceOnly, "canonical").meta, null);
});

test("version provenance survives both wire dialects", () => {
  const source = {
    sessionId: "770e8400-e29b-41d4-a716-446655440010",
    turnId: "770e8400-e29b-41d4-a716-446655440011",
    turnSequence: 4,
    session: { id: "770e8400-e29b-41d4-a716-446655440010", title: "Build the launch page" },
  } as const;
  const canonical = serializeAppVersionRecord(versionRow, "canonical", source);
  const legacy = serializeAppVersionRecord(versionRow, "legacy", source);
  assert.deepEqual(canonical.source, source);
  assert.deepEqual(legacy.source, source);
});

test("legacy /api/works wire keeps the work vocabulary", () => {
  const record = serializeAppRecord(appRow, "legacy");
  assert.ok("workScopes" in record, "record keeps workScopes");
  assert.ok(!("appScopes" in record));
  assert.deepEqual(wrapAppRecord("legacy", record), { work: record });
  assert.deepEqual(Object.keys(wrapAppRecords("legacy", [record])), ["works"]);

  const version = serializeAppVersionRecord(versionRow, "legacy");
  assert.ok("workId" in version, "version keeps workId");
  assert.ok(!("appId" in version));

  assert.ok("workId" in serializePromotionRecord(promotionRow, "legacy"));
  assert.equal(appScopesBodyField("legacy"), "workScopes");
});

test("both dialects carry identical values", () => {
  const canonical = serializeAppRecord(appRow, "canonical") as Record<string, unknown>;
  const legacy = serializeAppRecord(appRow, "legacy") as Record<string, unknown>;
  assert.equal(canonical.appScopes, legacy.workScopes);
  const { appScopes: _c, ...canonicalRest } = canonical;
  const { workScopes: _l, ...legacyRest } = legacy;
  assert.deepEqual(canonicalRest, legacyRest);
});
