import {
  DECISIONS_CACHE_TTL_SEC,
  getUserDecisionsRedisKey,
  parseDecisionsConfig,
  parseDecisionsUserConfig,
  PLATFORM_DECISIONS_REDIS_KEY,
  readDecisionsCacheFromFile,
  type CachedDecisionsConfig,
} from "@cohub/infra/config-runtime/decisions";
import { redisCommandClient } from "./redis.js";

export async function publishDecisionsCacheFromFile(input: {
  configPath: string;
  scope: "platform" | "user";
  userId?: string;
  sourceCheckpointId?: string | null;
}): Promise<CachedDecisionsConfig> {
  if (input.scope === "user" && !input.userId) {
    throw new Error("userId is required when publishing user decisions cache");
  }
  const redisKey = input.scope === "platform"
    ? PLATFORM_DECISIONS_REDIS_KEY
    : getUserDecisionsRedisKey(input.userId ?? "");
  const cached = await readDecisionsCacheFromFile({
    configPath: input.configPath,
    parse: input.scope === "platform" ? parseDecisionsConfig : parseDecisionsUserConfig,
    sourceCheckpointId: input.sourceCheckpointId,
  });
  await redisCommandClient.set(redisKey, JSON.stringify(cached), "EX", DECISIONS_CACHE_TTL_SEC);
  return cached;
}
