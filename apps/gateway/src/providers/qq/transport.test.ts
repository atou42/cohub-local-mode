import assert from "node:assert/strict";
import test from "node:test";
import { QQApiError } from "./api.js";
import { QQGatewayCloseError, QQ_GATEWAY_INTENTS, resolveQQReconnectDelay } from "./transport.js";

const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGE = 1 << 12;
const INTENT_GROUP_AND_C2C = 1 << 25;
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;

test("requests only the QQ events handled by the provider", () => {
  assert.equal(QQ_GATEWAY_INTENTS & INTENT_GROUP_AND_C2C, INTENT_GROUP_AND_C2C);
  assert.equal(QQ_GATEWAY_INTENTS & INTENT_PUBLIC_GUILD_MESSAGES, INTENT_PUBLIC_GUILD_MESSAGES);
  assert.equal(QQ_GATEWAY_INTENTS & INTENT_GUILD_MESSAGES, 0);
  assert.equal(QQ_GATEWAY_INTENTS & INTENT_DIRECT_MESSAGE, 0);
});

test("Retry-After never bypasses the base reconnect delay", () => {
  assert.equal(resolveQQReconnectDelay(new QQApiError("limited", 429, "/gateway", undefined, undefined, 0), 0), 1_000);
  assert.equal(resolveQQReconnectDelay(new QQApiError("limited", 429, "/gateway", undefined, undefined, 250), 0), 1_000);
  assert.equal(resolveQQReconnectDelay(new QQApiError("limited", 429, "/gateway", undefined, undefined, 2_500), 0), 2_500);
});

test("frequency-limit 4xx backs off as rate limit instead of a config error", () => {
  const limited = new QQApiError("QQ API GET /gateway failed: 400 接口调用超过频率限制", 400, "/gateway", 11264, "接口调用超过频率限制");
  assert.equal(resolveQQReconnectDelay(limited, 0, () => 0), 30_000);
  assert.equal(resolveQQReconnectDelay(limited, 0, () => 1), 60_000);
});

test("reconnect delay retains config and jitter behavior", () => {
  assert.equal(resolveQQReconnectDelay(new QQApiError("unauthorized", 401, "/gateway"), 0), 5 * 60_000);
  assert.equal(resolveQQReconnectDelay(new QQGatewayCloseError(4014, "disallowed intents"), 0), 5 * 60_000);
  assert.equal(resolveQQReconnectDelay(new Error("network"), 2, () => 0.5), 2_000);
});
