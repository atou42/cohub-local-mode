import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRelayDeploymentMatches,
  assertRelayHealth,
  assertRelaySecrets,
  buildRelayDeploymentMessage,
} from "./relay-deployment.mjs";

test("accepts only a fully deployed Relay matching the local source", () => {
  const deployment = assertRelayDeploymentMatches({
    localVersion: "abc123",
    deployments: [
      {
        created_on: "2026-09-01T00:00:00Z",
        annotations: { "workers/message": buildRelayDeploymentMessage("old") },
        versions: [{ version_id: "old", percentage: 100 }],
      },
      {
        created_on: "2026-09-01T01:00:00Z",
        annotations: {
          "workers/message": buildRelayDeploymentMessage("abc123"),
        },
        versions: [{ version_id: "current", percentage: 100 }],
      },
    ],
  });

  assert.equal(deployment.versions[0].version_id, "current");
});

test("rejects restarting the node against an older Relay deployment", () => {
  assert.throws(
    () =>
      assertRelayDeploymentMatches({
        localVersion: "abc123",
        deployments: [
          {
            created_on: "2026-09-01T00:00:00Z",
            annotations: {
              "workers/message": buildRelayDeploymentMessage("old"),
            },
            versions: [{ version_id: "old", percentage: 100 }],
          },
        ],
      }),
    /Refusing to restart Local Mode.*local Relay abc123.*public Relay old/s,
  );
});

test("rejects partial or unaudited Relay deployments", () => {
  assert.throws(
    () =>
      assertRelayDeploymentMatches({
        localVersion: "abc123",
        deployments: [
          {
            created_on: "2026-09-01T01:00:00Z",
            annotations: {
              "workers/message": buildRelayDeploymentMessage("abc123"),
            },
            versions: [{ version_id: "current", percentage: 50 }],
          },
        ],
      }),
    /not deployed at 100%/,
  );
  assert.throws(
    () =>
      assertRelayDeploymentMatches({
        localVersion: "abc123",
        deployments: [
          {
            created_on: "2026-09-01T01:00:00Z",
            annotations: { "workers/message": "manual deployment" },
            versions: [{ version_id: "unknown", percentage: 100 }],
          },
        ],
      }),
    /does not identify its Relay source/,
  );
});

test("requires every secret needed by the deployed Relay", () => {
  assert.doesNotThrow(() =>
    assertRelaySecrets([
      { name: "NODE_TOKEN" },
      { name: "OWNER_EMAIL" },
      { name: "OWNER_USER_ID" },
      { name: "POLICY_AUD" },
      { name: "TEAM_DOMAIN" },
    ]),
  );
  assert.throws(
    () =>
      assertRelaySecrets([
        { name: "NODE_TOKEN" },
        { name: "OWNER_EMAIL" },
        { name: "POLICY_AUD" },
        { name: "TEAM_DOMAIN" },
      ]),
    /missing required secrets: OWNER_USER_ID/,
  );
});

test("requires a healthy Relay with the node's exact wire schema", () => {
  assert.doesNotThrow(() =>
    assertRelayHealth(
      {
        status: "ready",
        protocolVersion: 2,
        eventSchemaVersion: 1,
        browserProtocolVersion: 2,
        activityPush: { status: "error", code: "apns_configuration_error" },
      },
      { protocolVersion: 2, eventSchemaVersion: 1, browserProtocolVersion: 2 },
    ),
  );
  assert.throws(
    () =>
      assertRelayHealth(
        { status: "ready", protocolVersion: 2 },
        { protocolVersion: 2, eventSchemaVersion: 1, browserProtocolVersion: 2 },
      ),
    /event schema mismatch/,
  );
  assert.throws(
    () =>
      assertRelayHealth(
        {
          status: "error",
          protocolVersion: 2,
          eventSchemaVersion: 1,
          browserProtocolVersion: 2,
        },
        { protocolVersion: 2, eventSchemaVersion: 1, browserProtocolVersion: 2 },
      ),
    /is not ready/,
  );
  assert.throws(
    () =>
      assertRelayHealth(
        {
          status: "ready",
          protocolVersion: 2,
          eventSchemaVersion: 1,
          browserProtocolVersion: 3,
        },
        { protocolVersion: 2, eventSchemaVersion: 1, browserProtocolVersion: 2 },
      ),
    /browser protocol mismatch/,
  );
});
