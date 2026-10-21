import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import type { PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import { deliverWeChatReply, planWeChatDelivery } from "./outbound.js";
import { createOutboundCheckpoint } from "../../outbound-progress.js";
import { OutboundDeliveryUnknownError } from "../base.js";
import { WeChatMessageItemType } from "./types.js";

const command = (content: ContentBlock[]): PlannedGatewayOutboundCommand => ({
  commandId: "command", channelId: "channel", externalChatId: "peer", provider: "wechat", timestamp: Date.now(), content,
  meta: { sessionOutput: { type: "session.message.persisted", spaceId: "space", sessionId: "session", message: {
    id: "message", sessionId: "session", role: "assistant", content, text: null, sequence: 1, provider: null, model: null,
    stopReason: null, errorMessage: null, usage: null, meta: null, startedAt: null, completedAt: null, durationMs: null, createdAt: new Date().toISOString(),
  } } },
});
const credentials = { baseUrl: "https://ilinkai.weixin.qq.com", cdnBaseUrl: "https://cdn.example.com", token: "test" };
const fixture = (signal = new AbortController().signal) => {
  const calls: string[] = [];
  const values = new Map<string, string>();
  const store = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
  const context = { signal, checkpoint: createOutboundCheckpoint(store, signal) };
  const image = { type: WeChatMessageItemType.IMAGE, image_item: { mid_size: 1, media: { encrypt_query_param: "param", aes_key: "key", encrypt_type: 1 } } };
  const transport = {
    sendWeChatTextMessage: async (params: { text: string }) => { calls.push(`text:${params.text}`); return { externalMessageId: "text-id" }; },
    sendWeChatMessageItems: async () => { calls.push("send-media"); return { externalMessageId: "media-id" }; },
    uploadImageContentBlock: async () => { calls.push("upload-image"); return image; },
    uploadWeChatMediaItem: async () => { calls.push("upload-file"); return image; },
  };
  return { calls, context, transport, store, values };
};

test("video URLs retain signed parameters and never enter the upload pipeline", async () => {
  const url = "https://example.com/movie.MP4?signature=a%2Fb&expires=123";
  const cmd = command([{ type: "text", text: `[Watch](${url})` }]);
  const { transport, calls } = fixture();
  const result = await deliverWeChatReply({ command: cmd, credentials, contextToken: "context" }, transport);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [`text:Watch (${url})`]);
  assert.equal(planWeChatDelivery(cmd).media.length, 0);
});

test("cancelled media preparation retries after restart without resending completed text", async () => {
  const controller = new AbortController();
  const { transport, calls, context, store, values } = fixture(controller.signal);
  const upload = transport.uploadImageContentBlock;
  const cmd = command([{ type: "text", text: "Reply" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } }]);
  transport.uploadImageContentBlock = async () => { controller.abort(); throw controller.signal.reason; };
  await assert.rejects(deliverWeChatReply({ command: cmd, credentials, contextToken: null, context }, transport), { name: "AbortError" });
  assert.equal(values.has("image:0"), false);
  transport.uploadImageContentBlock = upload;
  const signal = new AbortController().signal;
  const recovered = { signal, checkpoint: createOutboundCheckpoint(store, signal) };
  assert.equal((await deliverWeChatReply({ command: cmd, credentials, contextToken: null, context: recovered }, transport)).success, true);
  assert.deepEqual(calls, ["text:Reply", "upload-image", "send-media"]);
});

test("unknown send outcomes stop delivery and are not resent on recovery", async () => {
  const { transport, calls, context } = fixture();
  transport.sendWeChatTextMessage = async () => { calls.push("uncertain"); throw new OutboundDeliveryUnknownError("timeout"); };
  const input = { command: command([{ type: "text", text: "Reply" }]), credentials, contextToken: null, context };
  await assert.rejects(deliverWeChatReply(input, transport), OutboundDeliveryUnknownError);
  await assert.rejects(deliverWeChatReply(input, transport), OutboundDeliveryUnknownError);
  assert.deepEqual(calls, ["uncertain"]);
});
