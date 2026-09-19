import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWebDeploymentMatches,
  assertWebRetentionBaseline,
  buildWebDeploymentMessage,
} from "./web-deployment.mjs";

const compatibility = {
  nodeProtocolVersion: 3,
  browserProtocolVersion: 2,
  eventSchemaVersion: 1,
};

test("accepts the newest deployment only when it names the current web build", () => {
  const deployment = assertWebDeploymentMatches({
    localVersion: "222",
    compatibility,
    deployments: [
      {
        created_on: "2026-09-01T00:00:00Z",
        annotations: {
          "workers/message": buildWebDeploymentMessage("111", compatibility),
        },
        versions: [{ version_id: "old", percentage: 100 }],
      },
      {
        created_on: "2026-09-01T01:00:00Z",
        annotations: {
          "workers/message": buildWebDeploymentMessage("222", compatibility),
        },
        versions: [{ version_id: "current", percentage: 100 }],
      },
    ],
  });

  assert.equal(deployment.versions[0].version_id, "current");
});

test("rejects a service restart when the public Worker has an older web build", () => {
  assert.throws(
    () =>
      assertWebDeploymentMatches({
        localVersion: "222",
        compatibility,
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: {
              "workers/message": buildWebDeploymentMessage("111", compatibility),
            },
            versions: [{ version_id: "old", percentage: 100 }],
          },
        ],
      }),
    /Refusing to restart Local Mode.*local web build 222.*public Worker build 111/s,
  );
});

test("rejects deployments that do not carry an auditable web build marker", () => {
  assert.throws(
    () =>
      assertWebDeploymentMatches({
        localVersion: "222",
        compatibility,
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: { "workers/message": "manual deployment" },
            versions: [{ version_id: "unknown", percentage: 100 }],
          },
        ],
      }),
    /does not identify its Web build and Relay compatibility/,
  );
});

test("rejects a partial Web deployment", () => {
  assert.throws(
    () =>
      assertWebDeploymentMatches({
        localVersion: "222",
        compatibility,
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: {
              "workers/message": buildWebDeploymentMessage("222", compatibility),
            },
            versions: [
              { version_id: "old", percentage: 50 },
              { version_id: "new", percentage: 50 },
            ],
          },
        ],
      }),
    /not deployed at 100%/,
  );
});

test("rejects a Web deployment with a different browser protocol", () => {
  assert.throws(
    () =>
      assertWebDeploymentMatches({
        localVersion: "222",
        compatibility,
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: {
              "workers/message": buildWebDeploymentMessage("222", {
                ...compatibility,
                browserProtocolVersion: 3,
              }),
            },
            versions: [{ version_id: "new", percentage: 100 }],
          },
        ],
      }),
    /browserProtocolVersion 3 does not match local 2/,
  );
});

test("accepts a complete local retention baseline matching the public build", () => {
  const deployment = assertWebRetentionBaseline({
    localVersion: "222",
    deployments: [
      {
        created_on: "2026-09-01T00:00:00Z",
        annotations: { "workers/message": "cohub-local-web build 222" },
        versions: [{ version_id: "legacy", percentage: 100 }],
      },
    ],
  });

  assert.equal(deployment.versions[0].version_id, "legacy");
});

test("rejects a local retention baseline that differs from the public build", () => {
  assert.throws(
    () =>
      assertWebRetentionBaseline({
        localVersion: "111",
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: { "workers/message": "cohub-local-web build 222" },
            versions: [{ version_id: "public", percentage: 100 }],
          },
        ],
      }),
    /local build 111 does not retain public Web build 222/,
  );
});

test("accepts a candidate build that records the public build in its retention history", () => {
  assert.doesNotThrow(() =>
    assertWebRetentionBaseline({
      localVersion: "333",
      retainedVersions: [
        {
          version: "222",
          retainedAt: "2026-09-01T00:00:00Z",
          assets: [
            { path: "_app/immutable/entry/app.public.js", sha256: "0".repeat(64) },
          ],
        },
      ],
      now: Date.parse("2026-09-03T00:00:00Z"),
      deployments: [
        {
          created_on: "2026-09-01T00:00:00Z",
          annotations: { "workers/message": "cohub-local-web build 222" },
          versions: [{ version_id: "public", percentage: 100 }],
        },
      ],
    }),
  );
});

test("rejects an expired public build retention record", () => {
  assert.throws(
    () =>
      assertWebRetentionBaseline({
        localVersion: "333",
        retainedVersions: [
          {
            version: "222",
            retainedAt: "2026-07-01T00:00:00Z",
            assets: [
              { path: "_app/immutable/entry/app.public.js", sha256: "0".repeat(64) },
            ],
          },
        ],
        now: Date.parse("2026-09-03T00:00:00Z"),
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: { "workers/message": "cohub-local-web build 222" },
            versions: [{ version_id: "public", percentage: 100 }],
          },
        ],
      }),
    /does not retain public Web build 222/,
  );
});
