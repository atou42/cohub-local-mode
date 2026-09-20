import assert from "node:assert/strict";
import test from "node:test";
import {
  isQQRateLimitError,
  parseQQGatewayBot,
  parseRetryAfterMs,
  QQApiClient,
  QQApiError,
  qqWebsocketUrlFromApiBase,
} from "./api.js";

test("parseRetryAfterMs handles absent, delta, and HTTP-date values", () => {
  const now = Date.parse("2026-08-03T07:00:00.000Z");
  assert.equal(parseRetryAfterMs(null, now), undefined);
  assert.equal(parseRetryAfterMs("", now), undefined);
  assert.equal(parseRetryAfterMs("1.5", now), 1_500);
  assert.equal(parseRetryAfterMs("Mon, 03 Aug 2026 07:00:05 GMT", now), 5_000);
  assert.equal(parseRetryAfterMs("invalid", now), undefined);
});

test("qqWebsocketUrlFromApiBase derives the well-known websocket path", () => {
  assert.equal(qqWebsocketUrlFromApiBase("https://api.sgroup.qq.com"), "wss://api.sgroup.qq.com/websocket");
  assert.equal(qqWebsocketUrlFromApiBase("https://api.sgroup.qq.com/"), "wss://api.sgroup.qq.com/websocket");
  assert.equal(qqWebsocketUrlFromApiBase("https://sandbox.api.sgroup.qq.com"), "wss://sandbox.api.sgroup.qq.com/websocket");
  assert.equal(qqWebsocketUrlFromApiBase("http://localhost:8080"), "ws://localhost:8080/websocket");
});

test("QQApiClient connects with the well-known websocket URL", () => {
  const client = new QQApiClient({ appId: "app", clientSecret: "secret" });
  assert.equal(client.websocketUrl(), "wss://api.sgroup.qq.com/websocket");
  const sandbox = new QQApiClient({ appId: "app", clientSecret: "secret", baseUrl: "https://sandbox.api.sgroup.qq.com" });
  assert.equal(sandbox.websocketUrl(), "wss://sandbox.api.sgroup.qq.com/websocket");
});

test("parseQQGatewayBot reads url and session_start_limit", () => {
  const now = Date.parse("2026-09-09T00:00:00.000Z");
  assert.deepEqual(
    parseQQGatewayBot({
      url: "wss://api.sgroup.qq.com/websocket",
      session_start_limit: { total: 1000, remaining: 4, reset_after: 5_000, max_concurrency: 1 },
    }, now),
    {
      url: "wss://api.sgroup.qq.com/websocket",
      limit: { remaining: 4, resetAt: now + 5_000, maxConcurrency: 1 },
    },
  );
  assert.deepEqual(parseQQGatewayBot({ url: "  " }, now), { url: "", limit: null });
});

test("isQQRateLimitError matches 429 and frequency-limit 4xx", () => {
  assert.equal(isQQRateLimitError(new QQApiError("limited", 429, "/gateway/bot")), true);
  assert.equal(
    isQQRateLimitError(new QQApiError("QQ API GET /gateway failed: 400 接口调用超过频率限制", 400, "/gateway", 11264, "接口调用超过频率限制")),
    true,
  );
  assert.equal(isQQRateLimitError(new QQApiError("unauthorized", 401, "/gateway")), false);
  assert.equal(isQQRateLimitError(new Error("频率限制")), false);
});
