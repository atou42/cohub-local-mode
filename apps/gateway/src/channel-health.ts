import type {
  ChannelHealth,
  ChannelHealthReasonCode,
  ChannelRuntimeState,
} from "@cohub/protocol/gateway";
import { redisCommandClient } from "./redis.js";

const HEALTH_TTL_SECONDS = 60 * 60 * 24 * 30;
const DETAIL_MAX_CHARS = 500;
const MESSAGE_MAX_CHARS = 160;

export type ChannelHealthPatch = {
  state?: ChannelRuntimeState;
  reasonCode?: ChannelHealthReasonCode | null;
  message?: string | null;
  detail?: string | null;
  lastReadyAt?: number | string | null;
  lastErrorAt?: number | string | null;
  lastInboundAt?: number | string | null;
  lastOutboundAt?: number | string | null;
  nodeId?: string | null;
  meta?: Record<string, string | number | boolean | null | undefined> | null;
};

const healthKey = (channelId: string) => `gateway:channel:${channelId}:health`;

const truncate = (value: string, max: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
};

const redactSecrets = (value: string) =>
  value
    .replace(/(token|secret|password|authorization|app[_-]?secret|client[_-]?secret)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, (match) => (match.length > 40 ? "[redacted]" : match));

const toIso = (value: number | string | null | undefined): string | null => {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && /^\d+$/.test(value.trim())) {
      return new Date(asNumber).toISOString();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
};

const sanitizeDetail = (value: string | null | undefined) => {
  if (value == null) return null;
  const cleaned = redactSecrets(String(value));
  if (!cleaned.trim()) return null;
  return truncate(cleaned, DETAIL_MAX_CHARS);
};

const sanitizeMessage = (value: string | null | undefined) => {
  if (value == null) return null;
  const cleaned = redactSecrets(String(value)).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return truncate(cleaned, MESSAGE_MAX_CHARS);
};

export function classifyChannelError(raw: unknown): {
  reasonCode: ChannelHealthReasonCode;
  message: string;
  detail: string;
} {
  const detail = raw instanceof Error ? raw.message : String(raw ?? "unknown error");
  const text = detail.toLowerCase();

  if (
    text.includes("invalid appid") ||
    text.includes("invalid app id") ||
    text.includes("invalid token") ||
    text.includes("incorrect login details") ||
    text.includes("invalid credentials") ||
    text.includes("tokeninvalid") ||
    (text.includes("app_id") && text.includes("invalid"))
  ) {
    return {
      reasonCode: "invalid_credentials",
      message: "Credentials are invalid",
      detail,
    };
  }

  if (text.includes("disallowed intent") || /\b4014\b/.test(text)) {
    return {
      reasonCode: "permission",
      message: "Missing permissions",
      detail,
    };
  }

  if (
    text.includes("频率限制") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("session start limit") ||
    /\b429\b/.test(text)
  ) {
    return {
      reasonCode: "rate_limit",
      message: "Rate limited",
      detail,
    };
  }

  if (
    text.includes("unauthorized") ||
    text.includes("401") ||
    text.includes("403") ||
    (text.includes("auth") && (text.includes("fail") || text.includes("denied"))) ||
    text.includes("token expired") ||
    text.includes("session expired") ||
    text.includes("errcode=-14") ||
    text.includes("ret=-14")
  ) {
    return {
      reasonCode: "auth_failed",
      message: "Authentication failed",
      detail,
    };
  }

  if (
    text.includes("missing permission") ||
    text.includes("missing access") ||
    text.includes("missing intents") ||
    text.includes("forbidden")
  ) {
    return {
      reasonCode: "permission",
      message: "Missing permissions",
      detail,
    };
  }

  if (
    text.includes("econn") ||
    text.includes("etimedout") ||
    text.includes("enotfound") ||
    text.includes("socket hang up") ||
    text.includes("network") ||
    text.includes("disconnect") ||
    text.includes("websocket")
  ) {
    return {
      reasonCode: "network",
      message: "Connection interrupted",
      detail,
    };
  }

  return {
    reasonCode: "unknown",
    message: "Channel error",
    detail,
  };
}

function flattenMeta(meta: ChannelHealthPatch["meta"]): Record<string, string> {
  if (!meta) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    out[key] = truncate(text, 120);
  }
  return out;
}

export async function setChannelHealth(channelId: string, patch: ChannelHealthPatch): Promise<void> {
  if (!channelId.trim()) return;

  const entries: string[] = ["updatedAt", new Date().toISOString()];

  if (patch.state !== undefined) entries.push("state", patch.state);
  if (patch.reasonCode !== undefined) entries.push("reasonCode", patch.reasonCode ?? "");
  if (patch.message !== undefined) entries.push("message", sanitizeMessage(patch.message) ?? "");
  if (patch.detail !== undefined) entries.push("detail", sanitizeDetail(patch.detail) ?? "");
  if (patch.nodeId !== undefined) entries.push("nodeId", patch.nodeId ?? "");

  for (const field of ["lastReadyAt", "lastErrorAt", "lastInboundAt", "lastOutboundAt"] as const) {
    if (patch[field] !== undefined) {
      entries.push(field, toIso(patch[field]) ?? "");
    }
  }

  const multi = redisCommandClient.multi().hset(healthKey(channelId), ...entries);

  if (patch.meta === null) {
    multi.hdel(healthKey(channelId), "meta");
  } else {
    const meta = flattenMeta(patch.meta);
    if (Object.keys(meta).length > 0) {
      multi.hset(healthKey(channelId), "meta", JSON.stringify(meta));
    }
  }

  await multi.expire(healthKey(channelId), HEALTH_TTL_SECONDS).exec();
}

export async function markChannelConnecting(channelId: string, nodeId?: string | null) {
  await setChannelHealth(channelId, {
    state: "connecting",
    reasonCode: null,
    message: null,
    detail: null,
    nodeId: nodeId ?? null,
    meta: null,
  });
}

export async function markChannelReady(
  channelId: string,
  options: { nodeId?: string | null; meta?: ChannelHealthPatch["meta"] } = {},
) {
  const now = Date.now();
  await setChannelHealth(channelId, {
    state: "ready",
    reasonCode: null,
    message: null,
    detail: null,
    lastReadyAt: now,
    nodeId: options.nodeId ?? null,
    meta: options.meta,
  });
}

export async function markChannelDegraded(
  channelId: string,
  raw: unknown,
  options: { nodeId?: string | null } = {},
) {
  const classified = classifyChannelError(raw);
  await setChannelHealth(channelId, {
    state: "degraded",
    reasonCode: classified.reasonCode,
    message: classified.message,
    detail: classified.detail,
    lastErrorAt: Date.now(),
    nodeId: options.nodeId ?? null,
  });
}

export async function markChannelError(
  channelId: string,
  raw: unknown,
  options: {
    nodeId?: string | null;
    reasonCode?: ChannelHealthReasonCode;
    message?: string;
  } = {},
) {
  const classified = classifyChannelError(raw);
  await setChannelHealth(channelId, {
    state: "error",
    reasonCode: options.reasonCode ?? classified.reasonCode,
    message: options.message ?? classified.message,
    detail: classified.detail,
    lastErrorAt: Date.now(),
    nodeId: options.nodeId ?? null,
    meta: null,
  });
}

export async function markChannelStopped(channelId: string) {
  await setChannelHealth(channelId, {
    state: "stopped",
    reasonCode: null,
    message: null,
    detail: null,
    nodeId: null,
    meta: null,
  });
}

export async function touchChannelInbound(channelId: string) {
  await setChannelHealth(channelId, { lastInboundAt: Date.now() });
}

export async function touchChannelOutbound(channelId: string) {
  await setChannelHealth(channelId, { lastOutboundAt: Date.now() });
}

/** Bound helpers for a single channel — preferred entry for new providers. */
export function channelHealthReporter(channelId: string) {
  return {
    ready: (options: { nodeId?: string | null; meta?: ChannelHealthPatch["meta"] } = {}) =>
      markChannelReady(channelId, options),
    error: (
      raw: unknown,
      options: {
        nodeId?: string | null;
        reasonCode?: ChannelHealthReasonCode;
        message?: string;
      } = {},
    ) => markChannelError(channelId, raw, options),
    degraded: (raw: unknown, options: { nodeId?: string | null } = {}) =>
      markChannelDegraded(channelId, raw, options),
    inbound: () => touchChannelInbound(channelId),
    outbound: () => touchChannelOutbound(channelId),
  };
}

function parseHealthHash(raw: Record<string, string> | null | undefined): ChannelHealth | null {
  if (!raw || Object.keys(raw).length === 0) return null;

  const state = (raw.state as ChannelRuntimeState | undefined) ?? "connecting";
  let meta: Record<string, string> | null = null;
  if (raw.meta) {
    try {
      const parsed = JSON.parse(raw.meta) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, value]) => value != null && String(value).trim())
            .map(([key, value]) => [key, String(value)]),
        );
      }
    } catch {
      meta = null;
    }
  }

  return {
    state,
    reasonCode: (raw.reasonCode as ChannelHealthReasonCode | undefined) || null,
    message: raw.message?.trim() || null,
    detail: raw.detail?.trim() || null,
    lastReadyAt: raw.lastReadyAt?.trim() || null,
    lastErrorAt: raw.lastErrorAt?.trim() || null,
    lastInboundAt: raw.lastInboundAt?.trim() || null,
    lastOutboundAt: raw.lastOutboundAt?.trim() || null,
    nodeId: raw.nodeId?.trim() || null,
    updatedAt: raw.updatedAt?.trim() || new Date(0).toISOString(),
    meta,
  };
}

export async function getChannelHealth(channelId: string): Promise<ChannelHealth | null> {
  const raw = await redisCommandClient.hgetall(healthKey(channelId));
  return parseHealthHash(raw);
}

export async function getChannelHealthMap(channelIds: string[]): Promise<Map<string, ChannelHealth | null>> {
  const uniqueIds = Array.from(new Set(channelIds.filter((id) => Boolean(id?.trim()))));
  const result = new Map<string, ChannelHealth | null>();
  if (uniqueIds.length === 0) return result;

  const pipeline = redisCommandClient.pipeline();
  for (const channelId of uniqueIds) {
    pipeline.hgetall(healthKey(channelId));
  }
  const rows = await pipeline.exec();

  uniqueIds.forEach((channelId, index) => {
    const entry = rows?.[index];
    const raw = entry && entry[0] == null ? (entry[1] as Record<string, string>) : null;
    result.set(channelId, parseHealthHash(raw));
  });

  return result;
}

export function healthKeyForTests(channelId: string) {
  return healthKey(channelId);
}
