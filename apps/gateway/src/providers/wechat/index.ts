import { createLogger } from "@cohub/infra/logging";
import type { ContentBlock } from "@cohub/protocol/core";
import type { WeChatChannelConfig } from "@cohub/protocol/gateway";
import type { GatewayInboundEvent, GatewaySessionOutput } from "@cohub/protocol/gateway";
import type { PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import { randomUUID } from "node:crypto";
import type { GatewayProvider, GatewayOutboundContext } from "../base.js";
import { deliverWeChatReply } from "./outbound.js";
import { publishInboundEvent } from "../../bus.js";
import { resolveChannelCommand } from "../../channel-commands.js";
import { getSpaceChannelConfig } from "../../redis.js";
import { getWeChatUpdates, notifyWeChatStart, notifyWeChatStop } from "./api.js";
import {
  getWeChatContextToken,
  getWeChatSyncBuf,
  releaseWeChatMessageReservation,
  reserveWeChatMessage,
  setWeChatContextToken,
  setWeChatSyncBuf,
  updateWeChatStatus,
} from "./state.js";
import {
  WECHAT_DEFAULT_BASE_URL,
  WECHAT_DEFAULT_CDN_BASE_URL,
  WeChatMessageItemType,
  type WeChatCredentials,
  type WeChatMessage,
  type WeChatMessageItem,
} from "./types.js";
import { WECHAT_INBOUND_IMAGE_MAX_COUNT, downloadImageItem } from "./media/image.js";
import { ingestInboundMedia } from "../../media/inbound-attachments.js";
import { imageExtensionFromMimeType } from "../../media/mime.js";
import { WECHAT_INBOUND_FILE_MAX_COUNT, downloadAttachmentItem } from "./media/file.js";
import {
  markChannelDegraded,
  markChannelError,
  markChannelReady
} from "../../channel-health.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_BACKOFF_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const SESSION_EXPIRED_ERRCODE = -14;

type ResolvedCredentials = {
  token: string;
  accountId?: string;
  userId?: string;
  baseUrl: string;
  cdnBaseUrl: string;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(new Error("aborted"));
  }, { once: true });
});

const resolveWeChatBaseUrl = (value: string | undefined) => {
  try {
    const url = new URL(value?.trim() || WECHAT_DEFAULT_BASE_URL);
    if (url.protocol === "https:" && (url.hostname === "ilinkai.weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))) {
      return url.toString();
    }
  } catch {
    // fall through to default
  }
  return WECHAT_DEFAULT_BASE_URL;
};

const resolveCredentials = (credentials: WeChatCredentials): ResolvedCredentials => {
  const token = credentials.token?.trim();
  if (!token) throw new Error("wechat credentials.token is required");
  return {
    token,
    accountId: credentials.accountId?.trim() || undefined,
    userId: credentials.userId?.trim() || undefined,
    baseUrl: resolveWeChatBaseUrl(credentials.baseUrl),
    cdnBaseUrl: credentials.cdnBaseUrl?.trim() || WECHAT_DEFAULT_CDN_BASE_URL,
  };
};

const bodyFromItem = (item: WeChatMessageItem): string => {
  if (item.type === WeChatMessageItemType.TEXT && item.text_item?.text != null) {
    const text = String(item.text_item.text);
    const ref = item.ref_msg;
    if (!ref) return text;
    const refParts = [ref.title, ref.message_item ? bodyFromItem(ref.message_item) : null]
      .map((value) => value?.trim())
      .filter(Boolean);
    return refParts.length > 0 ? `[Quote: ${refParts.join(" | ")} ]\n${text}` : text;
  }
  if (item.type === WeChatMessageItemType.VOICE && item.voice_item?.text) {
    return item.voice_item.text;
  }
  if (item.type === WeChatMessageItemType.IMAGE) return "[Image]";
  if (item.type === WeChatMessageItemType.FILE) return "[File]";
  if (item.type === WeChatMessageItemType.VIDEO) return "[Video]";
  return "";
};

const textFromMessage = (msg: WeChatMessage, options: { includeMediaPlaceholders?: boolean } = {}) => {
  const includeMediaPlaceholders = options.includeMediaPlaceholders ?? true;
  const parts = (msg.item_list ?? [])
    .filter((item) => includeMediaPlaceholders || item.type === WeChatMessageItemType.TEXT || item.type === WeChatMessageItemType.VOICE)
    .map(bodyFromItem)
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.join("\n").trim();
};

const messageExternalId = (msg: WeChatMessage) => {
  if (msg.message_id != null) return String(msg.message_id);
  if (msg.client_id?.trim()) return msg.client_id.trim();
  if (msg.seq != null) return `seq:${msg.seq}`;
  return randomUUID();
};

const getSessionOutput = (cmd: PlannedGatewayOutboundCommand): GatewaySessionOutput | null => {
  const output = cmd.meta?.sessionOutput;
  if (!output || typeof output !== "object") return null;
  return output as GatewaySessionOutput;
};

export class WeChatProvider implements GatewayProvider {
  private readonly abortController = new AbortController();
  private readonly credentials: ResolvedCredentials;
  private healthReady = false;

  constructor(private readonly channelId: string, credentials: WeChatCredentials) {
    this.credentials = resolveCredentials(credentials);
    void this.start().catch((error) => {
      if (!this.abortController.signal.aborted) logger.error(`[WeChat:${channelId}] poll loop stopped`, error);
    });
  }

  destroy(): void {
    this.abortController.abort();
    void this.notifyStop();
  }

  async handleOutbound(cmd: PlannedGatewayOutboundCommand, context?: GatewayOutboundContext) {
    if (cmd.provider !== "wechat") return { success: false, error: "provider mismatch", retryable: false };
    const externalChatId = cmd.externalChatId?.trim();
    if (!externalChatId) return { success: false, error: "missing externalChatId", retryable: false };
    const output = getSessionOutput(cmd);
    const config = await getSpaceChannelConfig<WeChatChannelConfig>(this.channelId);
    if (output?.type === "session.turn.patch" && config?.outbound?.showIntermediateStatus !== true) return { success: true };
    const result = await deliverWeChatReply({
      command: cmd,
      credentials: this.credentials,
      contextToken: await getWeChatContextToken(this.channelId, externalChatId),
      context,
    });
    if (result.externalMessageId) await updateWeChatStatus(this.channelId, { lastOutboundAt: Date.now() });
    if (!result.success) await updateWeChatStatus(this.channelId, { lastErrorAt: Date.now(), lastError: result.error });
    return result;
  }

  private async start() {
    await this.notifyStart();
    await this.pollLoop();
  }

  private async notifyStart() {
    try {
      const response = await notifyWeChatStart({
        baseUrl: this.credentials.baseUrl,
        token: this.credentials.token,
      });
      if ((response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)) {
        logger.warn(`[WeChat:${this.channelId}] notifyStart failed ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`);
      }
    } catch (error) {
      logger.warn(`[WeChat:${this.channelId}] notifyStart failed`, error);
    }
  }

  private async notifyStop() {
    try {
      const response = await notifyWeChatStop({
        baseUrl: this.credentials.baseUrl,
        token: this.credentials.token,
      });
      if ((response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)) {
        logger.warn(`[WeChat:${this.channelId}] notifyStop failed ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`);
      }
    } catch (error) {
      logger.warn(`[WeChat:${this.channelId}] notifyStop failed`, error);
    }
  }

  private async pollLoop() {
    let getUpdatesBuf = await getWeChatSyncBuf(this.channelId);
    if (!getUpdatesBuf) logger.info(`[WeChat:${this.channelId}] no sync cursor found, starting fresh`);

    let timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (!this.abortController.signal.aborted) {
      try {
        const response = await getWeChatUpdates({
          baseUrl: this.credentials.baseUrl,
          token: this.credentials.token,
          getUpdatesBuf,
          timeoutMs,
          signal: this.abortController.signal,
        });

        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = response.longpolling_timeout_ms;
        }

        const apiError = (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0);
        if (apiError) {
          const isSessionExpired = response.ret === SESSION_EXPIRED_ERRCODE || response.errcode === SESSION_EXPIRED_ERRCODE;
          const errorMessage = `ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`;
          await updateWeChatStatus(this.channelId, { lastErrorAt: Date.now(), lastError: errorMessage });
          if (isSessionExpired) {
            consecutiveFailures = 0;
            logger.warn(`[WeChat:${this.channelId}] session expired, backing off ${SESSION_EXPIRED_BACKOFF_MS}ms`);
            this.healthReady = false;
            void markChannelError(this.channelId, errorMessage, {
              reasonCode: "auth_failed",
              message: "Authentication failed",
            }).catch(() => undefined);
            await sleep(SESSION_EXPIRED_BACKOFF_MS, this.abortController.signal);
            continue;
          }
          consecutiveFailures += 1;
          logger.warn(`[WeChat:${this.channelId}] getUpdates failed ${errorMessage}`);
          this.healthReady = false;
          void markChannelDegraded(this.channelId, errorMessage).catch(() => undefined);
          const delay = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
          await sleep(delay, this.abortController.signal);
          continue;
        }

        consecutiveFailures = 0;
        await updateWeChatStatus(this.channelId, { lastPollAt: Date.now() });
        if (!this.healthReady) {
          this.healthReady = true;
          void markChannelReady(this.channelId).catch(() => undefined);
        }
        for (const message of response.msgs ?? []) {
          await this.publishMessage(message);
        }

        if (response.get_updates_buf) {
          getUpdatesBuf = response.get_updates_buf;
          await setWeChatSyncBuf(this.channelId, getUpdatesBuf);
        }
      } catch (error) {
        if (this.abortController.signal.aborted) return;
        consecutiveFailures += 1;
        logger.error(`[WeChat:${this.channelId}] getUpdates error`, error);
        await updateWeChatStatus(this.channelId, {
          lastErrorAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
        });
        this.healthReady = false;
        void markChannelDegraded(this.channelId, error).catch(() => undefined);
        const delay = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        await sleep(delay, this.abortController.signal).catch(() => undefined);
      }
    }
  }

  private async contentFromMessage(message: WeChatMessage, externalMessageId: string, eventBase: Omit<GatewayInboundEvent, "eventType" | "command" | "content">) {
    const content: ContentBlock[] = [];
    const text = textFromMessage(message, { includeMediaPlaceholders: false });
    if (text) content.push({ type: "text", text });

    const downloadedImages: Array<{ id: string; buffer: Buffer; mediaType: string }> = [];
    const downloadedFiles: Array<{
      id: string;
      filePath: string;
      size: number;
      cleanup: () => Promise<void>;
      filename: string;
      relativePath: string;
      mediaType: string | null;
    }> = [];
    let imageCount = 0;
    let fileCount = 0;
    for (const item of message.item_list ?? []) {
      if (item.type === WeChatMessageItemType.IMAGE) {
        imageCount += 1;
        if (imageCount > WECHAT_INBOUND_IMAGE_MAX_COUNT) {
          content.push({ type: "text", text: "[Image skipped: too many images]" });
          continue;
        }
        try {
          const image = await downloadImageItem({
            item,
            cdnBaseUrl: this.credentials.cdnBaseUrl,
            channelId: this.channelId,
            externalMessageId,
          });
          if (!image) {
            content.push({ type: "text", text: "[Image]" });
            continue;
          }
          downloadedImages.push({ id: `image-${downloadedImages.length}`, buffer: image.buffer, mediaType: image.mediaType });
        } catch (error) {
          logger.warn(`[WeChat:${this.channelId}] image download failed`, error);
          content.push({ type: "text", text: "[Image unavailable]" });
        }
      }

      if (item.type === WeChatMessageItemType.FILE || item.type === WeChatMessageItemType.VIDEO || item.type === WeChatMessageItemType.VOICE) {
        fileCount += 1;
        if (fileCount > WECHAT_INBOUND_FILE_MAX_COUNT) {
          content.push({ type: "text", text: "[File skipped: too many files]" });
          continue;
        }
        try {
          const file = await downloadAttachmentItem({
            item,
            cdnBaseUrl: this.credentials.cdnBaseUrl,
            channelId: this.channelId,
            externalMessageId,
          });
          if (!file) {
            content.push({ type: "text", text: item.type === WeChatMessageItemType.VOICE ? "[Voice]" : item.type === WeChatMessageItemType.VIDEO ? "[Video]" : "[File]" });
            continue;
          }
          downloadedFiles.push({
            id: `file-${downloadedFiles.length}`,
            filePath: file.filePath,
            size: file.size,
            cleanup: file.cleanup,
            filename: file.filename,
            relativePath: file.relativePath,
            mediaType: file.mediaType,
          });
        } catch (error) {
          logger.warn(`[WeChat:${this.channelId}] file download failed`, error);
          content.push({ type: "text", text: "[File unavailable]" });
        }
      }
    }

    if (downloadedImages.length > 0 || downloadedFiles.length > 0) {
      try {
        const ingested = await ingestInboundMedia({
          event: { ...eventBase, eventType: "message_create", content } satisfies GatewayInboundEvent,
          source: "wechat",
          images: downloadedImages.map((image) => ({
            id: image.id,
            buffer: image.buffer,
            mediaType: image.mediaType,
            filename: `${image.id}.${imageExtensionFromMimeType(image.mediaType)}`,
          })),
          files: downloadedFiles.map((file) => ({
            id: file.id,
            filePath: file.filePath,
            size: file.size,
            mediaType: file.mediaType,
            name: file.filename,
            relativePath: file.relativePath,
          })),
          label: `wechat:${this.channelId}`,
        });
        content.push(...ingested.blocks);
      } finally {
        await Promise.all(downloadedFiles.map((file) => file.cleanup().catch(() => undefined)));
      }
    }

    return content;
  }

  private async publishMessage(message: WeChatMessage) {
    const fromUserId = message.from_user_id?.trim();
    if (!fromUserId) return;

    const externalMessageId = messageExternalId(message);
    const reserved = await reserveWeChatMessage(this.channelId, externalMessageId);
    if (!reserved) return;

    const text = textFromMessage(message);
    const bindingKey = `wechat:${this.credentials.accountId ?? this.channelId}:dm:${fromUserId}`;
    const channelCommand = resolveChannelCommand(text);
    const eventBase = {
      eventId: `wechat:${this.channelId}:${externalMessageId}`,
      timestamp: message.create_time_ms ?? Date.now(),
      channelId: this.channelId,
      provider: "wechat" as const,
      externalChatId: fromUserId,
      externalMessageId,
      bindingKey,
      binding: { key: bindingKey, parentKey: null },
      conversation: {
        id: fromUserId,
        meta: {
          isDm: true,
          sourceChannel: `wechat:dm:${fromUserId}`,
          accountId: this.credentials.accountId ?? null,
          userId: this.credentials.userId ?? null,
          wechatSessionId: message.session_id ?? null,
        },
      },
      message: {
        meta: {
          wechatSessionId: message.session_id ?? null,
          contextToken: message.context_token ?? null,
        },
      },
      sender: { id: fromUserId, name: fromUserId },
      providerEvent: message,
      meta: {
        accountId: this.credentials.accountId ?? null,
        seq: message.seq ?? null,
        itemTypes: message.item_list?.map((item) => item.type).filter((value) => value != null) ?? [],
      },
    } satisfies Omit<GatewayInboundEvent, "eventType" | "command" | "content">;

    const content = await this.contentFromMessage(message, externalMessageId, eventBase);
    if (content.length === 0) {
      await releaseWeChatMessageReservation(this.channelId, externalMessageId).catch(() => undefined);
      return;
    }

    const event: GatewayInboundEvent = channelCommand
      ? { ...eventBase, content, eventType: "channel_command", command: channelCommand }
      : { ...eventBase, content, eventType: "message_create" };

    try {
      await publishInboundEvent(event);
      await updateWeChatStatus(this.channelId, { lastInboundAt: Date.now() });
      if (message.context_token) await setWeChatContextToken(this.channelId, fromUserId, message.context_token);
    } catch (error) {
      await releaseWeChatMessageReservation(this.channelId, externalMessageId).catch(() => undefined);
      throw error;
    }
  }
}
