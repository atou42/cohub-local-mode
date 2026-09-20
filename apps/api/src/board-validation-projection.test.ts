import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardEffect, BoardOperation } from "@cohub/protocol";
import { collectEnterMotionItemIds, collectValidationNodeIds } from "./board-validation-projection.js";

test("validation projection includes only node ids referenced by the transaction", () => {
  const operations: BoardOperation[] = [
    { type: "node.patch", payload: { nodeId: "title", patch: { x: 20 } } },
    {
      type: "connection.create",
      payload: {
        connection: {
          id: "edge",
          source: { itemId: "title", anchor: { kind: "auto" } },
          target: { itemId: "hero", anchor: { kind: "auto" } },
          relation: "related",
          direction: "forward",
          label: "",
          routing: { kind: "curve", bend: 0, waypoints: [] },
          style: { color: "brand", size: 2, line: "solid" },
          metadata: {},
        },
      },
    },
    {
      type: "effect.upsert",
      payload: {
        effect: {
          id: "pulse",
          target: { type: "item", itemId: "hero" },
          kind: "effects.pulse",
          kindVersion: 1,
          enabled: true,
          lifecycle: "manual",
          timeOrigin: "board",
          layer: "front",
          seed: "seed",
          params: {},
          assetRefs: [],
          metadata: {},
        },
      },
    },
  ];
  assert.deepEqual(new Set(collectValidationNodeIds(operations)), new Set(["title", "hero"]));
});

function effectUpsert(
  effect: Pick<BoardEffect, "id" | "target" | "kind" | "lifecycle" | "timeOrigin" | "seed">,
): BoardOperation {
  return {
    type: "effect.upsert",
    payload: {
      effect: {
        kindVersion: 1,
        enabled: true,
        layer: "front",
        params: {},
        assetRefs: [],
        metadata: {},
        ...effect,
      },
    },
  };
}

test("on-enter upserts project their target items so existing enter effects are loaded", () => {
  const enter = effectUpsert({
    id: "deal-b",
    target: { type: "item", itemId: "hero" },
    kind: "effects.deal",
    lifecycle: "on-enter",
    timeOrigin: "activation",
    seed: "deal-b",
  });
  const pulse = effectUpsert({
    id: "pulse",
    target: { type: "item", itemId: "title" },
    kind: "effects.pulse",
    lifecycle: "when-visible",
    timeOrigin: "visible",
    seed: "pulse",
  });
  // A second effect id on the same node is exactly what a touched-id-only query would miss.
  assert.deepEqual(collectEnterMotionItemIds([enter, pulse]), ["hero"]);
  assert.deepEqual(collectEnterMotionItemIds([pulse]), []);
});
