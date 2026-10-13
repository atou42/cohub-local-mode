import assert from "node:assert/strict";
import test from "node:test";
import { RoomsApi } from "../src/apis/rooms.js";
import type { HttpTransport } from "../src/transport.js";

test("room event polling respects the total limit", async () => {
  const limits: string[] = [];
  const api = new RoomsApi({
    async request(path: string) {
      limits.push(new URL(path, "https://api.example.com").searchParams.get("limit") ?? "");
      assert.ok(limits.length <= 2, "Polling must stop at the total limit");
      return { events: [{ self: true }], cursor: limits.length, truncated: false };
    },
  } as unknown as HttpTransport);
  const result = await api.events("room", { limit: 2, waitMs: 60_000 });
  assert.deepEqual(limits, ["2", "1"]);
  assert.equal(result.events.length, 2);
  assert.equal(result.cursor, 2);
});
