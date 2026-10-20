import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeBoardRenderer } from "../../src/board/export/node/index.js";
import { buildBoardScene } from "../../src/board/model/scene.js";
import { inspectBoardItems } from "../../src/board/render/diagnostics.js";
import { boardDocument } from "./fixtures.js";

test("selected diagnostics are limited after filtering unrelated items", async () => {
  const renderer = await createNodeBoardRenderer();
  try {
    const scene = buildBoardScene(boardDocument({ items: {
      ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`effect-${index}`, {
        type: "effect", props: { kind: "glow", follow: "title" },
      }])),
      title: { type: "text", props: { text: "Title" } },
      overlap: { type: "text", props: { text: "Overlap" } },
    } }));
    assert.equal(inspectBoardItems(scene).diagnostics.length, 100);
    assert.deepEqual(inspectBoardItems(scene, new Set(["title"])).diagnostics, [
      { code: "text-overlap", item: "title", related: "overlap" },
    ]);
  } finally {
    renderer.destroy();
  }
});
