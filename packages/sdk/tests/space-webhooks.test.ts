import assert from "node:assert/strict";
import { test } from "node:test";
import { SpaceWebhooksApi } from "@neta-art/cohub";
import { SPACE_HOOK_WEBHOOK_SECRET_HEADER } from "@cohub/protocol";
import type { HttpTransport } from "../src/transport.js";

type Sent = { path: string; init?: RequestInit };

function createApi(handler?: (sent: Sent) => unknown) {
  const sent: Sent[] = [];
  const transport = {
    request: async (path: string, init?: RequestInit) => {
      const entry = { path, init };
      sent.push(entry);
      return handler ? handler(entry) : {};
    },
  } as unknown as HttpTransport;
  return { api: new SpaceWebhooksApi(transport, "space-1"), sent };
}

test("SpaceWebhooksApi.path builds the public trigger path", () => {
  const { api } = createApi();
  assert.equal(api.path("mail"), "/api/spaces/space-1/webhooks/mail");
});

test("SpaceWebhooksApi.trigger posts JSON and forwards the secret header", async () => {
  const { api, sent } = createApi(() => ({ taskRunId: "task-1", hook: ".cohub/hooks/mail.yml", eventId: "event-1" }));
  const result = await api.trigger("mail", { from: "a@b.c" }, { secret: "wh_1" });

  assert.equal(sent[0]?.path, "/api/spaces/space-1/webhooks/mail");
  assert.equal(sent[0]?.init?.method, "POST");
  assert.equal(sent[0]?.init?.body, '{"from":"a@b.c"}');
  const headers = sent[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers[SPACE_HOOK_WEBHOOK_SECRET_HEADER], "wh_1");
  assert.equal((sent[0]?.init as { skipUnauthorizedHandler?: boolean })?.skipUnauthorizedHandler, true);
  assert.equal(result.taskRunId, "task-1");
});

test("SpaceWebhooksApi.trigger omits the secret header when absent", async () => {
  const { api, sent } = createApi();
  await api.trigger("mail");

  const headers = sent[0]?.init?.headers as Record<string, string>;
  assert.equal(SPACE_HOOK_WEBHOOK_SECRET_HEADER in headers, false);
  assert.equal(sent[0]?.init?.body, "null");
});

test("SpaceWebhooksApi.list targets the space webhook collection", async () => {
  const { api, sent } = createApi(() => ({ items: [] }));
  await api.list();

  assert.equal(sent[0]?.path, "/api/spaces/space-1/webhooks");
});
