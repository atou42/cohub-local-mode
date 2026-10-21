import type { ContentBlock } from "@cohub/protocol/core";
import type { GatewayMediaItem, PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import { createLogger } from "@cohub/infra/logging";
import { OutboundDeliveryUnknownError, type GatewayOutboundContext } from "../base.js";
import { extractMediaLinks, isVideoUrl, normalizeMediaUrl } from "../../media-links.js";
import { renderWeChatText } from "./media/text.js";
import { uploadImageContentBlock } from "./media/image.js";
import { uploadWeChatMediaItem } from "./media/upload.js";
import { sendWeChatMessageItems, sendWeChatTextMessage } from "./api.js";
import type { WeChatMessageItem } from "./types.js";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;
const isVideoSource = (source: GatewayMediaItem["source"]) => source.type === "url" && isVideoUrl(source.url);

export function planWeChatDelivery(cmd: PlannedGatewayOutboundCommand) {
  const output = cmd.meta?.sessionOutput;
  const isError = output?.type === "session.turn.error";
  const textParts = isError ? [output.error] : cmd.content.flatMap((block) => {
    if (block.type === "text" || block.type === "system_note") {
      return [block.text.replace(
        /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
        (match, label: string, url: string) => isVideoUrl(url) ? `[${label || "Video"}](${url})` : match,
      )];
    }
    if (block.type === "image" && block.source.type === "url" && isVideoSource(block.source)) return [block.source.url];
    return [];
  });
  const text = renderWeChatText(textParts.join("\n"));
  const images = isError ? [] : cmd.content.filter((block): block is ImageBlock => block.type === "image" && !isVideoSource(block.source));
  const imageUrls = new Set(images.flatMap((image) => image.source.type === "url" ? [normalizeMediaUrl(image.source.url)] : []));
  const media = output?.type === "session.message.persisted"
    ? extractMediaLinks(cmd.content, { maxItems: 100 }).filter((item) => {
      if (item.kind === "video" || isVideoSource(item.source)) return false;
      return !(item.kind === "image" && item.source.type === "url" && imageUrls.has(normalizeMediaUrl(item.source.url)));
    }).slice(0, 6)
    : [];
  return { text, images, media };
}

const logger = createLogger({ serviceName: "cohub-gateway" });
const IMAGE_BUDGET_MS = 45_000;
const ATTACHMENT_BUDGET_MS = 90_000;
const defaults = { uploadImageContentBlock, uploadWeChatMediaItem, sendWeChatMessageItems, sendWeChatTextMessage };

export async function deliverWeChatReply(input: {
  command: PlannedGatewayOutboundCommand;
  credentials: { baseUrl: string; cdnBaseUrl: string; token: string };
  contextToken: string | null;
  context?: GatewayOutboundContext;
}, transport = defaults) {
  const { command: cmd, credentials, contextToken, context } = input;
  const plan = planWeChatDelivery(cmd);
  const parentSignal = context?.signal ?? new AbortController().signal;
  const checkpoint: GatewayOutboundContext["checkpoint"] = context?.checkpoint
    ?? (async <T, P = undefined>(_id: string, send: (prepared: P) => Promise<T>, prepare?: () => Promise<P>) => send(prepare ? await prepare() : undefined as P));
  const common = { ...credentials, to: cmd.externalChatId, contextToken };
  let lastExternalMessageId: string | undefined;
  if (plan.text) {
    const result = await checkpoint("text", () => transport.sendWeChatTextMessage({ ...common, text: plan.text, signal: parentSignal }));
    lastExternalMessageId = result.externalMessageId;
  }
  const failures: string[] = [];
  const sendMedia = async (id: string, source: ImageBlock | GatewayMediaItem) => {
    parentSignal.throwIfAborted();
    const isImage = "type" in source || source.kind === "image";
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(isImage ? IMAGE_BUDGET_MS : ATTACHMENT_BUDGET_MS)]);
    try {
      const result = await checkpoint(id, (send) => send(), async () => {
        let item: WeChatMessageItem;
        try {
          item = isImage
            ? await transport.uploadImageContentBlock({ ...common, block: "type" in source ? source : { type: "image", source: source.source }, signal })
            : await transport.uploadWeChatMediaItem({ ...common, item: source as GatewayMediaItem, signal });
        } catch (error) {
          parentSignal.throwIfAborted();
          if (isImage && source.source.type === "url") {
            if (lastExternalMessageId && plan.text.includes(source.source.url)) {
              const deliveredId = lastExternalMessageId;
              return async () => ({ externalMessageId: deliveredId });
            }
            logger.warn("[WeChat] Image upload failed; sending source URL", { commandId: cmd.commandId, itemId: id, error });
            const url = source.source.url;
            return () => transport.sendWeChatTextMessage({ ...common, text: url, signal: parentSignal });
          }
          throw error;
        }
        signal.throwIfAborted();
        return () => transport.sendWeChatMessageItems({ ...common, items: [item], signal });
      });
      lastExternalMessageId = result.externalMessageId;
    } catch (error) {
      parentSignal.throwIfAborted();
      if (error instanceof OutboundDeliveryUnknownError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${id}: ${message}`);
      logger.warn("[WeChat] Outbound media failed", { commandId: cmd.commandId, channelId: cmd.channelId, itemId: id, error });
    }
  };
  for (const [index, image] of plan.images.entries()) await sendMedia(`image:${index}`, image);
  for (const [index, item] of plan.media.entries()) await sendMedia(`media:${index}`, item);
  return { success: failures.length === 0, externalMessageId: lastExternalMessageId, error: failures.length ? failures.join("; ") : undefined };
}
