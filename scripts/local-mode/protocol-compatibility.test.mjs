import assert from "node:assert/strict";
import test from "node:test";

import {
  RELAY_EVENT_SCHEMA_VERSION as relayNodeEventSchemaVersion,
  RELAY_PROTOCOL_VERSION as relayNodeProtocolVersion,
} from "../../apps/local-relay/node/protocol-compat.mjs";
import {
  RELAY_BROWSER_PROTOCOL_VERSION as relayWorkerBrowserProtocolVersion,
  RELAY_EVENT_SCHEMA_VERSION as relayWorkerEventSchemaVersion,
  RELAY_PROTOCOL_VERSION as relayWorkerProtocolVersion,
} from "../../apps/local-relay/src/protocol.ts";
import {
  RELAY_BROWSER_PROTOCOL_VERSION as webProtocolVersion,
  parseLocalRelayBrowserMessage,
} from "../../apps/web/src/lib/local-relay-events.ts";
import {
  LOCAL_RELAY_BROWSER_PROTOCOL_VERSION as sourceBrowserProtocolVersion,
  LOCAL_RELAY_EVENT_SCHEMA_VERSION as sourceEventSchemaVersion,
  LOCAL_RELAY_NODE_PROTOCOL_VERSION as sourceNodeProtocolVersion,
} from "../../packages/protocol/src/local-relay-compatibility.ts";

test("locks the deployed wire contract until a backwards-compatible migration exists", () => {
  assert.equal(sourceNodeProtocolVersion, 3);
  assert.equal(sourceBrowserProtocolVersion, 2);
  assert.equal(sourceEventSchemaVersion, 1);
});

test("Web, Relay Worker, and Relay Node use compatible wire versions", () => {
  assert.equal(webProtocolVersion, sourceBrowserProtocolVersion);
  assert.equal(webProtocolVersion, relayWorkerBrowserProtocolVersion);
  assert.equal(relayWorkerProtocolVersion, sourceNodeProtocolVersion);
  assert.equal(relayWorkerProtocolVersion, relayNodeProtocolVersion);
  assert.equal(relayWorkerEventSchemaVersion, sourceEventSchemaVersion);
  assert.equal(relayWorkerEventSchemaVersion, relayNodeEventSchemaVersion);
});

test("the Web parser accepts every Relay browser frame", () => {
  const command = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "running",
    errorCode: null,
    errorMessage: null,
    result: null,
  };
  const event = {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "turn.completed",
    spaceId: "33333333-3333-4333-8333-333333333333",
    sessionId: "44444444-4444-4444-8444-444444444444",
    turnId: "55555555-5555-4555-8555-555555555555",
    completedAt: "2026-09-03T00:00:00.000Z",
    turn: null,
    truncated: false,
  };
  for (const frame of [
    {
      protocolVersion: relayWorkerBrowserProtocolVersion,
      type: "snapshot",
      commands: [command],
      events: [event],
    },
    {
      protocolVersion: relayWorkerBrowserProtocolVersion,
      type: "command.updated",
      command,
    },
    {
      protocolVersion: relayWorkerBrowserProtocolVersion,
      type: "turn.event",
      event,
    },
  ]) {
    assert.equal(parseLocalRelayBrowserMessage(frame).ok, true);
  }
});
