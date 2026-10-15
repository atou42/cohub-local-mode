import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDecisionState } from "../src/commands/decision.js";

const image = { type: "image_url" as const, image_url: { url: "https://example.test/receipt.webp" } };

test("decision input preserves original state or rejects incompatible additions", () => {
  assert.deepEqual(mergeDecisionState("Original ticket", "", [image]), ["Original ticket", image]);
  const original = ["Original ticket", image];
  assert.deepEqual(mergeDecisionState(original, "Extra context", [image]), [...original, "Extra context", image]);
  assert.deepEqual(original, ["Original ticket", image]);
  const state = { ticket: "Original ticket" };
  assert.equal(mergeDecisionState(state, "", []), state);
  assert.throws(() => mergeDecisionState(state, "", [image]), /Cannot combine a JSON object state/);
  assert.throws(() => mergeDecisionState(state, "Extra context", []), /Cannot combine a JSON object state/);
});
