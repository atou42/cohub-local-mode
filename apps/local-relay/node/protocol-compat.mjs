import {
  LOCAL_RELAY_BROWSER_PROTOCOL_VERSION,
  LOCAL_RELAY_EVENT_SCHEMA_VERSION,
  LOCAL_RELAY_NODE_PROTOCOL_VERSION,
} from "../../../packages/protocol/src/local-relay-compatibility.ts";

export const RELAY_PROTOCOL_VERSION = LOCAL_RELAY_NODE_PROTOCOL_VERSION;
export const RELAY_BROWSER_PROTOCOL_VERSION =
  LOCAL_RELAY_BROWSER_PROTOCOL_VERSION;
export const RELAY_EVENT_SCHEMA_VERSION = LOCAL_RELAY_EVENT_SCHEMA_VERSION;

export function assertRelayReadyCompatibility(message) {
  if (
    message?.type !== "ready" ||
    message.protocolVersion !== RELAY_PROTOCOL_VERSION
  ) {
    throw new Error("relay protocol mismatch");
  }
  if (message.eventSchemaVersion !== RELAY_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `relay event schema mismatch: node=${RELAY_EVENT_SCHEMA_VERSION} relay=${message.eventSchemaVersion ?? "missing"}`,
    );
  }
}
