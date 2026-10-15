import { config } from "../config.js";

export type CloudflareRealtimeConfig = {
  turn: { keyId: string; apiToken: string } | null;
  sfu: { appId: string; appSecret: string } | null;
};

export function getCloudflareRealtimeConfig(): CloudflareRealtimeConfig {
  const { rtcTurnKeyId, rtcTurnKeyApiToken, rtcSfuAppId, rtcSfuAppSecret } = config;
  return {
    turn: rtcTurnKeyId && rtcTurnKeyApiToken ? { keyId: rtcTurnKeyId, apiToken: rtcTurnKeyApiToken } : null,
    sfu: rtcSfuAppId && rtcSfuAppSecret ? { appId: rtcSfuAppId, appSecret: rtcSfuAppSecret } : null,
  };
}
