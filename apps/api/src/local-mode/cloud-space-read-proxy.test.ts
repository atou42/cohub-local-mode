import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import { createCloudSpaceReadProxy } from "./cloud-space-read-proxy.js";

const sourceSpaceId = "11111111-1111-4111-8111-111111111111";
const targetSpaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const actorUserId = "44444444-4444-4444-8444-444444444444";

const execution = {
  type: "execution" as const,
  actorUserId,
  spaceId: sourceSpaceId,
  sessionId,
  turnId: "55555555-5555-4555-8555-555555555555",
  source: "external_harness",
  scopes: [],
  expiresAt: Date.now() + 60_000,
};

function mention(origin?: "cloud" | "local"): ContentBlock[] {
  return [{
    type: "text",
    text: `@[Cloud context](cohub://spaces/${targetSpaceId})`,
    _meta: {
      mentions: [{ type: "space", spaceId: targetSpaceId, ...(origin ? { origin } : {}) }],
    },
  }];
}

function activeTurn(userContent: ContentBlock[]) {
  return [{ status: "running", userUuid: actorUserId, userContent }];
}

test("an execution-bound external harness can read an explicitly mentioned cloud Space", async () => {
  const requests: Request[] = [];
  const proxy = createCloudSpaceReadProxy({
    nodeOrigin: "local",
    cloudApiOrigin: "https://api.cohub.test",
    loadRecentSessionTurns: async () => activeTurn(mention("cloud")),
    resolveAccessToken: async () => "host-cloud-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/api/me")) {
        return Response.json({ uuid: actorUserId, profile: {}, email: null });
      }
      return Response.json({ entries: [{ name: "README.md", path: "README.md", type: "file" }] });
    },
  });

  const response = await proxy({ execution, targetSpaceId, endpoint: "tree", path: "" });
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    entries: [{ name: "README.md", path: "README.md", type: "file" }],
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer host-cloud-token");
  assert.equal(requests[1]?.headers.get("x-cohub-source-space"), sourceSpaceId);
  assert.equal(requests[1]?.headers.get("x-cohub-source-session"), sessionId);
  assert.equal(requests[1]?.headers.get("x-cohub-source-via"), "tool");
  assert.match(requests[1]?.url ?? "", new RegExp(`/api/spaces/${targetSpaceId}/fs/tree`));
});

test("local and legacy mentions never fall through to the cloud proxy", async () => {
  for (const content of [mention("local"), mention()]) {
    let fetched = false;
    const proxy = createCloudSpaceReadProxy({
      nodeOrigin: "local",
      cloudApiOrigin: "https://api.cohub.test",
      loadRecentSessionTurns: async () => activeTurn(content),
      resolveAccessToken: async () => "host-cloud-token",
      fetch: async () => {
        fetched = true;
        return new Response();
      },
    });
    assert.equal(
      await proxy({ execution, targetSpaceId, endpoint: "file", path: "README.md" }),
      null,
    );
    assert.equal(fetched, false);
  }
});

test("the host cloud account must match the execution actor", async () => {
  const proxy = createCloudSpaceReadProxy({
    nodeOrigin: "local",
    cloudApiOrigin: "https://api.cohub.test",
    loadRecentSessionTurns: async () => activeTurn(mention("cloud")),
    resolveAccessToken: async () => "host-cloud-token",
    fetch: async () => Response.json({
      uuid: "66666666-6666-4666-8666-666666666666",
      profile: {},
      email: null,
    }),
  });
  const response = await proxy({ execution, targetSpaceId, endpoint: "tree", path: "" });
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    code: "cloud_account_mismatch",
    message: "The connected cloud account does not match this Cohub user.",
  });
});

test("corrupt mention metadata fails explicitly instead of being treated as local", async () => {
  const proxy = createCloudSpaceReadProxy({
    nodeOrigin: "local",
    cloudApiOrigin: "https://api.cohub.test",
    loadRecentSessionTurns: async () => activeTurn([{ type: "text", text: "bad", _meta: { mentions: {} } }]),
    resolveAccessToken: async () => "host-cloud-token",
    fetch: async () => new Response(),
  });
  const response = await proxy({ execution, targetSpaceId, endpoint: "tree", path: "" });
  assert.ok(response);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: "cloud_mention_metadata_invalid",
    message: "Space mention metadata is invalid: mentions must be an array.",
  });
});
