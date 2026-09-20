import assert from "node:assert/strict";
import { test } from "node:test";
import { boardDocumentToSemanticCommands } from "../src/board/semantic-mutation.js";
import type { BoardDocument } from "@cohub/protocol/board-document";

function item(id: string, text: string) {
  return {
    id,
    type: "text" as const,
    frame: { x: 0, y: 0, width: 120, height: 40, rotation: 0 },
    text,
    color: "neutral",
    fontSize: 24,
  };
}

function document(items = [item("a", "A"), item("b", "B")]): BoardDocument {
  return {
    kind: "cohub.board",
    version: 1,
    appearance: {
      background: { kind: "solid" },
      grid: { visible: false, size: 24, opacity: 0.12 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    items,
    connections: [],
  };
}

test("document changes compile to public semantic item commands", () => {
  const before = document();
  const after = document([{ ...before.items[0], text: "Updated" } as ReturnType<typeof item>, before.items[1]]);
  const commands = boardDocumentToSemanticCommands(before, after);
  assert.deepEqual(commands, [{
    type: "item.patch",
    itemId: "a",
    patch: { props: { text: "Updated" } },
  }]);
});

test("z-order changes compile to item.reorder instead of wire orderKey patches", () => {
  const before = document();
  const after = document([before.items[1], before.items[0]]);
  const commands = boardDocumentToSemanticCommands(before, after);
  assert.deepEqual(commands, [{ type: "item.reorder", itemId: "b", index: 0 }]);
});

test("appearance changes use semantic metadataPatch", () => {
  const before = document();
  const after = {
    ...before,
    appearance: { ...before.appearance, mood: "natural" as const },
  };
  assert.deepEqual(boardDocumentToSemanticCommands(before, after), [{
    type: "board.patch",
    patch: { metadataPatch: { appearance: after.appearance } },
  }]);
});
