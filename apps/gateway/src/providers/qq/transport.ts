import { createLogger } from "@cohub/infra/logging";
import WebSocket from "ws";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { getTracer, runInActiveSpan } from "@cohub/infra/tracing/propagator";
import { isQQRateLimitError, QQApiError, type QQApiClient } from "./api.js";
import {
  clearQQSessionState,
  getQQSessionState,
  setQQSessionState,
  updateQQStatus,
} from "./state.js";
import {
  markChannelDegraded,
  markChannelError,
} from "../../channel-health.js";
import type { QQDispatchEvent, QQWSPayload } from "./types.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const INTENT_GROUP_AND_C2C = 1 << 25;
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
export const QQ_GATEWAY_INTENTS = INTENT_GROUP_AND_C2C | INTENT_PUBLIC_GUILD_MESSAGES;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_CONFIG_ERROR_MS = 5 * 60_000;
const RATE_LIMIT_BASE_MS = 60_000;
const RATE_LIMIT_MAX_MS = 5 * 60_000;

export class QQGatewayCloseError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason: string,
  ) {
    super(`WebSocket closed: code=${code}${reason ? ` reason=${reason}` : ""}`);
    this.name = "QQGatewayCloseError";
  }
}

export function resolveQQReconnectDelay(error: unknown, reconnectAttempts: number, random = Math.random): number {
  if (isQQRateLimitError(error)) {
    if (error.retryAfterMs != null) return Math.max(RECONNECT_BASE_MS, Math.min(RATE_LIMIT_MAX_MS, error.retryAfterMs));
    const delay = Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** reconnectAttempts);
    return Math.floor(delay / 2 + random() * (delay / 2));
  }
  if (error instanceof QQApiError && error.retryAfterMs != null) {
    return Math.max(RECONNECT_BASE_MS, error.retryAfterMs);
  }
  if (
    (error instanceof QQApiError && error.status >= 400 && error.status < 500) ||
    (error instanceof QQGatewayCloseError && error.code === 4014)
  ) {
    return RECONNECT_CONFIG_ERROR_MS;
  }
  const exponentialDelay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
  return Math.floor(random() * exponentialDelay);
}
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;
const tracer = getTracer("cohub-gateway");

type QQWebSocketTransportOptions = {
  channelId: string;
  api: QQApiClient;
  onEvent: (event: QQDispatchEvent) => void | Promise<void>;
  onReady?: () => void;
};

export class QQWebSocketTransport {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnectAttempts = 0;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private receivedHello = false;

  constructor(private readonly options: QQWebSocketTransportOptions) {}

  start() {
    void this.loadSessionAndConnect();
  }

  private async loadSessionAndConnect() {
    const state = await getQQSessionState(this.options.channelId).catch(() => null);
    if (state) {
      this.sessionId = state.sessionId;
      this.lastSeq = state.lastSeq;
    }
    await this.connect();
  }

  stop() {
    this.destroyed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  private async connect(forceRefreshToken = false) {
    if (this.destroyed) return;
    try {
      await runInActiveSpan(tracer, "gateway.qq.connect", {
        attributes: { "gateway.channel_id": this.options.channelId, "gateway.provider": "qq" },
      }, ROOT_CONTEXT, () => this.openWebSocket(forceRefreshToken));
    } catch (error) {
      this.noteConnectFailure(error);
      this.scheduleReconnect(error);
    }
  }

  private async openWebSocket(forceRefreshToken: boolean) {
    if (!(this.sessionId && this.lastSeq != null)) {
      await this.options.api.prepareSessionStart();
    }
    this.receivedHello = false;
    const ws = new WebSocket(this.options.api.websocketUrl(), {
      headers: { "User-Agent": "CohubGateway/1.0 QQBotProvider" },
      handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      logger.info(`[QQ:${this.options.channelId}] WebSocket connected`);
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      void this.handleMessage(ws, String(data)).catch((error) => logger.error(`[QQ:${this.options.channelId}] message handling failed`, error));
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      const closeError = new QQGatewayCloseError(code, reason.toString().trim());
      logger.warn(`[QQ:${this.options.channelId}] WebSocket closed`, { code, reason: closeError.reason });
      if (!this.receivedHello) this.options.api.invalidateGateway();
      if (!this.destroyed) {
        void markChannelDegraded(this.options.channelId, closeError).catch(() => undefined);
        this.scheduleReconnect(closeError);
      }
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      logger.error(`[QQ:${this.options.channelId}] WebSocket error`, error);
      void markChannelDegraded(this.options.channelId, error).catch(() => undefined);
    });

    if (forceRefreshToken) await this.options.api.getAccessToken(true);
  }

  private async handleMessage(ws: WebSocket, raw: string) {
    if (this.ws !== ws) return;
    const payload = JSON.parse(raw) as QQWSPayload;
    const { op, d, s, t } = payload;
    if (typeof s === "number") {
      this.lastSeq = s;
      if (this.sessionId) {
        await setQQSessionState(this.options.channelId, { sessionId: this.sessionId, lastSeq: s, updatedAt: Date.now() }).catch((error) => {
          logger.warn(`[QQ:${this.options.channelId}] failed to persist last seq`, error);
        });
      }
    }

    if (op === OP_HELLO) {
      this.receivedHello = true;
      const interval = typeof (d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval === "number"
        ? (d as { heartbeat_interval: number }).heartbeat_interval
        : 45_000;
      try {
        await this.identifyOrResume();
        if (this.ws !== ws) return;
        this.startHeartbeat(interval);
      } catch (error) {
        if (this.ws !== ws) return;
        this.noteConnectFailure(error);
        this.scheduleReconnect(error);
        ws.close();
      }
      return;
    }

    if (op === OP_DISPATCH) {
      if (t === "READY") {
        const ready = d as { session_id?: string };
        this.sessionId = ready.session_id ?? null;
        if (this.sessionId) {
          await setQQSessionState(this.options.channelId, { sessionId: this.sessionId, lastSeq: this.lastSeq, updatedAt: Date.now() });
        }
        logger.info(`[QQ:${this.options.channelId}] WebSocket ready`, { sessionId: this.sessionId });
        await updateQQStatus(this.options.channelId, { lastReadyAt: Date.now() }).catch(() => undefined);
        this.markReady();
        return;
      }
      if (t === "RESUMED") {
        logger.info(`[QQ:${this.options.channelId}] WebSocket resumed`);
        this.markReady();
        return;
      }
      if (t) await this.options.onEvent({ eventType: t, data: d, seq: s, raw: payload });
      return;
    }

    if (op === OP_RECONNECT) {
      logger.info(`[QQ:${this.options.channelId}] server requested reconnect`);
      this.reconnectNow();
      return;
    }

    if (op === OP_INVALID_SESSION) {
      const canResume = d === true;
      if (!canResume) {
        this.sessionId = null;
        this.lastSeq = null;
        await clearQQSessionState(this.options.channelId).catch(() => undefined);
      }
      logger.warn(`[QQ:${this.options.channelId}] invalid session`, { canResume });
      void markChannelDegraded(this.options.channelId, "Invalid QQ session").catch(() => undefined);
      this.reconnectNow();
      return;
    }

    if (op === OP_HEARTBEAT_ACK) return;
  }

  private async identifyOrResume() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const accessToken = await this.options.api.getAccessToken();
    if (this.sessionId && this.lastSeq != null) {
      ws.send(JSON.stringify({
        op: OP_RESUME,
        d: {
          token: `QQBot ${accessToken}`,
          session_id: this.sessionId,
          seq: this.lastSeq,
        },
      }));
      return;
    }

    ws.send(JSON.stringify({
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${accessToken}`,
        intents: QQ_GATEWAY_INTENTS,
        shard: [0, 1],
      },
    }));
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }));
      }
    }, intervalMs);
  }

  private reconnectNow() {
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.scheduleReconnect();
  }

  private markReady() {
    this.reconnectAttempts = 0;
    this.options.onReady?.();
  }

  private noteConnectFailure(error: unknown) {
    if (isQQRateLimitError(error)) {
      logger.warn(`[QQ:${this.options.channelId}] rate limited`, error);
      void markChannelDegraded(this.options.channelId, error).catch(() => undefined);
      return;
    }
    logger.error(`[QQ:${this.options.channelId}] failed to connect`, error);
    void markChannelError(this.options.channelId, error).catch(() => undefined);
  }

  private scheduleReconnect(error?: unknown) {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = resolveQQReconnectDelay(error, this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }
}
