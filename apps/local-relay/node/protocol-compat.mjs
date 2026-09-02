export const RELAY_PROTOCOL_VERSION = 3;
export const RELAY_EVENT_SCHEMA_VERSION = 1;

export function assertRelayReadyCompatibility(message) {
  if (
    !message ||
    message.type !== "ready" ||
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
