import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";
import type { Fetch } from "../src/transport.js";

test("Runtime exposes only explicit snapshot-bound stop confirmation, not manual recovery", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
  };
  const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch });
  assert.equal("recoverRuntime" in client.space("space"), false);
  await client.space("space").confirmRuntimeStopped("session", { expectedTurnId: "11111111-1111-4111-8111-111111111111", revision: "snapshot", confirmed: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.example.test/api/spaces/space/sessions/session/runtime/confirm-stopped");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(new Headers(requests[0]?.init?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { expectedTurnId: "11111111-1111-4111-8111-111111111111", revision: "snapshot", confirmed: true });
});
