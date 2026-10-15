import { eq } from "drizzle-orm";
import { apps } from "@cohub/db";
import { AppRtcService, AppRtcStore, SfuClient } from "@cohub/core/app-rtc";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";
import { getCloudflareRealtimeConfig } from "./rtc/config.js";
import { getIceServers } from "./rtc/ice.js";

const { sfu } = getCloudflareRealtimeConfig();

export const appRtc = new AppRtcService({
  store: new AppRtcStore(redisCommandClient),
  sfu: sfu ? new SfuClient(sfu) : null,
  logger: createLogger({ serviceName: "cohub-api" }),
  iceServers: async (userUuid) => (await getIceServers(userUuid)).iceServers,
});

export async function loadAppForRtc(appId: string) {
  const [app] = await db.select({ status: apps.status, spaceId: apps.spaceId }).from(apps).where(eq(apps.id, appId)).limit(1);
  return app ?? null;
}
