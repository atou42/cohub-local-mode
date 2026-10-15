import assert from "node:assert/strict";
import { test } from "node:test";
import { callDecisionUpstream } from "./client.js";

test("decision retries at most once, never for 4xx or client aborts", async () => {
  for (const [status, aborted, expected] of [[502, false, 2], [0, false, 2], [400, false, 1], [403, false, 1], [0, true, 1]] as const) {
    let calls = 0;
    const outcome = await callDecisionUpstream({
      model: {
        provider: "cohub", id: "test", name: "Test", hidden: false,
        input: ["text"], maxImages: 0, baseUrl: "https://router.test/openrouter", apiKey: "test-key",
      },
      state: "Ticket",
      questions: { refund: { type: "noul", instructions: "Refund?" } },
      userId: "user", spaceId: "space", decisionId: "decision",
      signal: aborted ? AbortSignal.abort() : undefined,
      fetch: async () => {
        calls += 1;
        if (status === 0) throw new Error("Connection closed");
        return Response.json({ error: { message: "Upstream rejected request" } }, { status });
      },
    });
    assert.equal(calls, expected);
    assert.equal(outcome.attempts.length, expected);
    assert.equal(outcome.status, aborted ? "aborted" : "failed");
  }
});
