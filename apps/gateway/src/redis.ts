import { Redis } from "ioredis";
import type { ChannelConfig } from "@cohub/protocol/gateway";
import { summarizeRedisUrl } from "./logging.js";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-gateway" });
export type RedisStreamEntry = [string, string[]];

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
logger.info("[Redis] Connecting to Redis", { redis: summarizeRedisUrl(redisUrl) });

/**
 * Shared command client for short-lived, non-blocking Redis commands only.
 */
export const redisCommandClient = new Redis(redisUrl, { disableClientInfo: true });

redisCommandClient.on("connect", () => {
  logger.info("[Redis] Command client connected successfully");
});

redisCommandClient.on("error", (err) => {
  logger.error("[Redis] Command client error:", err);
});

redisCommandClient.on("close", () => {
  logger.warn("[Redis] Command client closed");
});

redisCommandClient.on("reconnecting", () => {
  logger.info("[Redis] Command client reconnecting...");
});

export const getGatewayNodeOutboundStreamKey = (nodeId: string) => `stream:gateway:node:${nodeId}:outbound`;
export { REALTIME_OUTBOUND_CHANNEL, AGENT_REALTIME_PATCH_CHANNEL } from "@cohub/protocol/realtime";
export const createBlockingRedisClient = () => {
  const client = redisCommandClient.duplicate({ lazyConnect: true });

  client.on("connect", () => {
    logger.info("[Redis] Blocking client connected successfully");
  });

  client.on("error", (err) => {
    logger.error("[Redis] Blocking client error:", err);
  });

  client.on("close", () => {
    logger.warn("[Redis] Blocking client closed");
  });

  client.on("reconnecting", () => {
    logger.info("[Redis] Blocking client reconnecting...");
  });

  return client;
};

export const createPubSubRedisClient = () => {
  const client = redisCommandClient.duplicate({ lazyConnect: true });

  client.on("connect", () => {
    logger.info("[Redis] PubSub client connected successfully");
  });

  client.on("error", (err) => {
    logger.error("[Redis] PubSub client error:", err);
  });

  client.on("close", () => {
    logger.warn("[Redis] PubSub client closed");
  });

  client.on("reconnecting", () => {
    logger.info("[Redis] PubSub client reconnecting...");
  });

  return client;
};

export const getSpaceChannelConfig = async <TConfig extends ChannelConfig = ChannelConfig>(
  spaceChannelId: string,
): Promise<TConfig | null> => {
  const now = Date.now();
  const cached = spaceChannelConfigCache.get(spaceChannelId);
  if (cached && cached.expiresAt > now) {
    return (cached.value as TConfig | null) ?? null;
  }

  const raw = await redisCommandClient.get(getSpaceChannelConfigKey(spaceChannelId));
  if (!raw) {
    spaceChannelConfigCache.set(spaceChannelId, { expiresAt: now + SPACE_CHANNEL_CONFIG_TTL_MS, value: null });
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as TConfig;
    spaceChannelConfigCache.set(spaceChannelId, {
      expiresAt: now + SPACE_CHANNEL_CONFIG_TTL_MS,
      value: parsed,
    });
    return parsed;
  } catch (error) {
    logger.error(`[Redis] Failed to parse space channel config for ${spaceChannelId}:`, error);
    spaceChannelConfigCache.set(spaceChannelId, { expiresAt: now + 1000, value: null });
    return null;
  }
};

export const getTurnMessageExternalRef = async (spaceChannelId: string, turnAnchorMessageId: string) => {
  const value = await redisCommandClient.get(getTurnMessageRefKey(spaceChannelId, turnAnchorMessageId));
  return value?.trim() || null;
};

export const setTurnMessageExternalRef = async (
  spaceChannelId: string,
  turnAnchorMessageId: string,
  externalMessageId: string,
) => {
  await redisCommandClient.set(
    getTurnMessageRefKey(spaceChannelId, turnAnchorMessageId),
    externalMessageId,
    "EX",
    TURN_MESSAGE_REF_TTL_SECONDS,
  );
};

const getSpaceChannelConfigKey = (spaceChannelId: string) => `gateway:space_channel_config:${spaceChannelId}`;
const getTurnMessageRefKey = (spaceChannelId: string, turnAnchorMessageId: string) =>
  `gateway:turn_message_ref:${spaceChannelId}:${turnAnchorMessageId}`;
const spaceChannelConfigCache = new Map<string, { expiresAt: number; value: ChannelConfig | null }>();
const SPACE_CHANNEL_CONFIG_TTL_MS = 3000;
const TURN_MESSAGE_REF_TTL_SECONDS = 60 * 30;
