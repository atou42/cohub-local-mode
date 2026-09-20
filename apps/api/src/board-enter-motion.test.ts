import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardEffect, BoardTransaction } from "@cohub/protocol";
import { contextualValidation, structuralValidation } from "./board-ops.js";

function enterEffect(id: string, itemId: string): Omit<BoardEffect, "boardId" | "revision"> {
  return {
    id,
    target: { type: "item", itemId },
    kind: "effects.deal",
    kindVersion: 1,
    enabled: true,
    lifecycle: "on-enter",
    timeOrigin: "activation",
    layer: "front",
    seed: id,
    params: {},
    assetRefs: [],
    metadata: {},
  };
}

function transaction(effect: Omit<BoardEffect, "boardId" | "revision">): BoardTransaction {
  return {
    txId: "tx",
    boardId: "board",
    baseVersion: 1,
    operations: [{ type: "effect.upsert", payload: { effect } }],
  };
}

test("a node accepts at most one on-enter effect", () => {
  const existing = enterEffect("deal-a", "hero");
  const context = {
    boardVersion: 1,
    nodeIds: ["hero"],
    connections: [],
    effects: [existing],
    compositions: [],
  };

  const conflict = contextualValidation(transaction(enterEffect("deal-b", "hero")), context);
  assert.equal(conflict.valid, false);
  assert.ok(conflict.diagnostics.some((d) => d.code === "ITEM_ENTER_CONFLICT"));

  // Re-applying the same effect id is an update, not a conflict.
  const update = contextualValidation(transaction({ ...existing, enabled: false }), context);
  assert.ok(!update.diagnostics.some((d) => d.code === "ITEM_ENTER_CONFLICT"));
});

test("an unshipped enter-motion version warns instead of silently persisting", () => {
  const result = structuralValidation({
    txId: "tx",
    boardId: "board",
    baseVersion: 1,
    operations: [{
      type: "board.patch",
      payload: {
        patch: {
          metadataPatch: {
            appearance: { motion: { enter: { kind: "effects.deal", kindVersion: 2 } } },
          },
        },
      },
    }],
  });
  assert.ok(result.diagnostics.some((d) => d.code === "UNKNOWN_EFFECT" && d.path?.endsWith("motion.enter")));
  // A warning, not a rejection: the document stays valid and a future runtime may render it.
  assert.equal(result.valid, true);
});
