import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionClient } from "../src/apis/spaces.js";
import { HttpError, HttpTransport } from "../src/transport.js";

test("space-scoped session reads reject another space's session", async () => {
  const transport = new HttpTransport({
    apiBaseUrl: "https://cohub.test",
    fetch: async () => Response.json({
      session: { id: "chat", spaceId: "other-space" },
      turns: [],
      hasMore: false,
    }),
  });
  const client = new SessionClient("space", "chat", transport, null);
  for (const read of [
    () => client.get(),
    () => client.turns.listPaginated(),
    () => client.turns.index(),
    () => client.turns.window({ sequence: 1 }),
  ]) {
    await assert.rejects(read, (error) =>
      error instanceof HttpError && error.status === 404 &&
      error.code === "session_context_mismatch",
    );
  }
});
