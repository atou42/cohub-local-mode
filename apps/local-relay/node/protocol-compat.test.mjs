import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRelayReadyCompatibility,
  RELAY_EVENT_SCHEMA_VERSION,
  RELAY_PROTOCOL_VERSION,
} from "./protocol-compat.mjs";

test("accepts a Relay ready message with the current event schema", () => {
  assert.doesNotThrow(() =>
    assertRelayReadyCompatibility({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      type: "ready",
      nodeId: "mac-mini",
      eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
    }),
  );
});

test("rejects a Relay that cannot accept the node's event schema", () => {
  assert.throws(
    () =>
      assertRelayReadyCompatibility({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        type: "ready",
        nodeId: "mac-mini",
      }),
    /event schema mismatch/,
  );
  assert.throws(
    () =>
      assertRelayReadyCompatibility({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        type: "ready",
        nodeId: "mac-mini",
        eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION - 1,
      }),
    /event schema mismatch/,
  );
});
