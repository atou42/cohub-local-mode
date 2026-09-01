import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWebDeploymentMatches,
  buildWebDeploymentMessage,
} from "./web-deployment.mjs";

test("accepts the newest deployment only when it names the current web build", () => {
  const deployment = assertWebDeploymentMatches({
    localVersion: "222",
    deployments: [
      {
        created_on: "2026-09-01T00:00:00Z",
        annotations: { "workers/message": buildWebDeploymentMessage("111") },
        versions: [{ version_id: "old", percentage: 100 }],
      },
      {
        created_on: "2026-09-01T01:00:00Z",
        annotations: { "workers/message": buildWebDeploymentMessage("222") },
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
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: {
              "workers/message": buildWebDeploymentMessage("111"),
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
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: { "workers/message": "manual deployment" },
            versions: [{ version_id: "unknown", percentage: 100 }],
          },
        ],
      }),
    /does not identify its web build/,
  );
});
