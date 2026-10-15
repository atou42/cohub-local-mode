import { createDecisionsModelsLoader } from "@cohub/infra/config-runtime/decisions";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";

export const loadDecisionModels = createDecisionsModelsLoader({
  platformConfigRoot: config.platformConfigRoot,
  redis: redisCommandClient,
});
