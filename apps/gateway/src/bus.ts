import { createLogger } from "@cohub/infra/logging";
import { randomUUID } from "node:crypto";
import type { GatewayConversationCreateEvent, GatewayInboundEvent } from "@cohub/protocol/gateway";
import { buildTraceHeaders } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { gatewayConfig } from "./config.js";
import { touchChannelInbound } from "./channel-health.js";

export { initOutboundConsumerGroup, listenOutboundCommands, getOutboundStreamForNode } from "./outbound-consumer.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
const inboundDedup = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10000;

const buildInboundDedupKey = (event: GatewayInboundEvent) => {
  const provider = event.provider?.trim();
  const chatId = event.externalChatId?.trim();
  const messageId = event.externalMessageId?.trim();
  if (provider && chatId && messageId) return `${provider}:${chatId}:${messageId}`;
  return event.eventId;
};

export const publishInboundEvent = async (event: GatewayInboundEvent) => {
  const dedupKey = buildInboundDedupKey(event);
  if (inboundDedup.has(dedupKey)) {
    logger.info(`[Bus] Duplicate inbound event ${dedupKey}, skipping`);
    return;
  }
  if (inboundDedup.size > DEDUP_MAX_ENTRIES) {
    const now = Date.now();
    for (const [id, ts] of inboundDedup) {
      if (now - ts > DEDUP_TTL_MS) inboundDedup.delete(id);
    }
  }

  const traceCarrier = injectTrace();
  const enrichedEvent = Object.keys(traceCarrier).length > 0 ? { ...event, ...traceCarrier } : event;
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders({ requestId: event.eventId }),
    },
    body: JSON.stringify(enrichedEvent),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway inbound submit failed ${response.status}: ${text}`);
  }
  inboundDedup.set(dedupKey, Date.now());
  if (event.channelId) void touchChannelInbound(event.channelId).catch(() => undefined);
  logger.info(`[Bus] Inbound submitted: ${event.eventId.slice(0, 8)}`);
};

export const publishConversationCreateEvent = async (
  input: Omit<GatewayConversationCreateEvent, "eventId" | "timestamp" | "eventType" | "content" | "sender" | "command"> & { sender?: GatewayConversationCreateEvent["sender"] }
) => {
  await publishInboundEvent({
    eventId: randomUUID(),
    timestamp: Date.now(),
    eventType: "conversation_create",
    sender: input.sender ?? { id: "system", name: "system" },
    content: [],
    ...input,
  });
};
