import { APP_RTC_SWEEP_JOB, AppRtcService, AppRtcStore, SfuClient } from "@cohub/core/app-rtc";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../../../config.js";
import { redisCommandClient } from "../../../redis.js";
import { registerSystemJob } from "../../registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const service = new AppRtcService({
  store: new AppRtcStore(redisCommandClient),
  sfu: config.rtcSfuAppId && config.rtcSfuAppSecret
    ? new SfuClient({ appId: config.rtcSfuAppId, appSecret: config.rtcSfuAppSecret })
    : null,
  logger,
});

registerSystemJob(APP_RTC_SWEEP_JOB, async () => {
  const result = await service.sweep();
  if (result.closed > 0) logger.info("[AppRTC] swept abandoned sessions", result);
  return result;
});
