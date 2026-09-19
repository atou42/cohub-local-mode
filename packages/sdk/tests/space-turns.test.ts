import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.js";

test("space turns list forwards stable filters and cursors", async () => {
  let requestUrl = "";
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({
        turns: [],
        snapshotAt: "2026-07-31T08:00:00.000Z",
        snapshotCursor: "snapshot",
        pageInfo: { hasMore: false, nextCursor: null },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.space("space-1").turns.list({
    author: "others",
    after: "after-cursor",
    before: "2026-07-31T08:00:00.000Z",
    cursor: "page-cursor",
    limit: 6,
    sessionId: "session-1",
  });

  assert.equal(
    requestUrl,
    "https://api.example.test/api/spaces/space-1/turns?author=others&after=after-cursor&before=2026-07-31T08%3A00%3A00.000Z&cursor=page-cursor&limit=6&sessionId=session-1",
  );
});

test("session turn intermediate reads the CDN archive through signed URLs", async () => {
  const requests: string[] = [];
  const objectKey = "spaces/space-1/sessions/session-1/turns/turn-1/intermediate/messages.json";
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ urls: { [objectKey]: "https://cdn.example.test/messages.json" } }), { status: 200 });
    },
  });
  const archive = await client.space("space-1").session("session-1").turns.intermediate.get("turn-1", objectKey, {
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("signed-urls")) {
        return new Response(JSON.stringify({ urls: { [objectKey]: "https://cdn.example.test/messages.json" } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        version: 1,
        spaceId: "space-1",
        sessionId: "session-1",
        turnId: "turn-1",
        summary: { messageCount: 1, toolCallCount: 0 },
        messages: [],
      }), { status: 200 });
    },
  });

  assert.equal(archive?.turnId, "turn-1");
  assert.deepEqual(requests, [
    "https://api.example.test/api/sessions/session-1/turns/turn-1/signed-urls",
    "https://cdn.example.test/messages.json",
  ]);
});

test("session turn intermediate reads persisted messages when no archive exists", async () => {
  const requests: string[] = [];
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        messages: [{
          id: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "bash", input: {} }],
          text: null,
          provider: null,
          model: null,
          stopReason: null,
          errorMessage: null,
          usage: null,
          durationMs: 12,
          toolCallsObjectKey: null,
          meta: null,
          createdAt: "2026-09-03T00:00:00.000Z",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const archive = await client
    .space("space-1")
    .session("session-1")
    .turns.intermediate.get("turn-1", null);

  assert.equal(archive?.summary.messageCount, 1);
  assert.equal(archive?.summary.toolCallCount, 1);
  assert.equal(archive?.messages[0]?.id, "message-1");
  assert.deepEqual(requests, [
    "https://api.example.test/api/sessions/session-1/turns/turn-1/intermediate",
  ]);
});

test("session turn intermediate falls back to persisted messages when the archive is unavailable", async () => {
  const requests: string[] = [];
  const objectKey = "spaces/space-1/sessions/session-1/turns/turn-1/intermediate/messages.json";
  const client = createHttpClient({ baseUrl: "https://api.example.test" });

  const archive = await client
    .space("space-1")
    .session("session-1")
    .turns.intermediate.get("turn-1", objectKey, {
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).includes("signed-urls")) {
          return new Response(JSON.stringify({
            urls: { [objectKey]: "https://cdn.example.test/messages.json" },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (String(url).includes("cdn.example.test")) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

  assert.deepEqual(archive?.messages, []);
  assert.deepEqual(requests, [
    "https://api.example.test/api/sessions/session-1/turns/turn-1/signed-urls",
    "https://cdn.example.test/messages.json",
    "https://api.example.test/api/sessions/session-1/turns/turn-1/intermediate",
  ]);
});
