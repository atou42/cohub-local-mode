import { resolveLogtoEndpoint } from "@cohub/identity";

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const env = process.env.ENV === "prod" ? "prod" : "dev";

export const gatewayConfig = {
  apiBaseUrl: normalizeBaseUrl(process.env.API_BASE_URL ?? "http://localhost:8787"),
  workerSecret: process.env.WORKER_SECRET ?? "",
  logtoEndpoint: resolveLogtoEndpoint({ endpoint: process.env.LOGTO_ENDPOINT, env }),
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? "0.0.0.0",
  // Pod IP used to build the cluster-internal relay endpoint advertised to
  // agents for local sandboxes. Falls back to localhost for single-node dev.
  podIp: (process.env.POD_IP ?? "127.0.0.1").trim(),
  nodeId: process.env.POD_NAME || process.env.HOSTNAME || "unknown",
  bullmqRedisUrl: process.env.BULLMQ_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379",
  volcAsr: {
    apiKey: process.env.VOLC_ASR_API_KEY ?? "",
    resourceId: "volc.seedasr.sauc.duration",
    url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  },
};

export type GatewayAuthUser = {
  uuid: string;
  nick_name?: string;
  avatar_url?: string;
  [key: string]: unknown;
};
