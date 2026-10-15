import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  createNodeBoardRenderer,
  exportBoardImageBytes,
  type BoardNodeRenderer,
} from "../../src/board/export/node/index.js";
import { createBoardAnimationSampler } from "../../src/board/model/sampling.js";
import { boardSequence } from "../../src/board/model/authoring.js";
import { boardDocument } from "./fixtures.js";

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

let renderer: BoardNodeRenderer;
before(async () => {
  renderer = await createNodeBoardRenderer();
});
after(() => renderer.destroy());
const box = { type: "shape", size: { width: 30, height: 30 }, style: { fill: "blue", strokeWidth: 0 } };

test("camera export retains exact pixels for fractional zoom and honors size limits", async () => {
  const document = boardDocument({ items: { square: { ...box, size: { width: 300, height: 300 } } }, animations: {
    intro: { duration: 1000, tracks: { focus: { target: "camera", property: "focus", keyframes: [{ at: 0, value: "square" }] } } },
  } });
  const options = { at: { animation: "intro", time: 0 }, camera: { width: 1600, height: 900 } };
  const output = required(exportBoardImageBytes(renderer, document, options));
  const { loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(output.bytes);
  assert.equal(output.plan.width, 1600);
  assert.equal(output.plan.height, 900);
  assert.equal(image.width, 1600);
  assert.equal(image.height, 900);
  const clamped = required(exportBoardImageBytes(renderer, document, { ...options, maxEdge: 800 }));
  assert.ok(clamped.plan.clamped);
  assert.equal(clamped.plan.width, 800);
  assert.equal(clamped.plan.height, 450);
});

test("trail export retains clipped ancestors outside the selected region", async () => {
  const document = boardDocument({ items: {
    frame: { type: "frame", size: { width: 100, height: 100 }, props: { decoration: "none" } },
    target: { ...box, opacity: 0 },
    trail: { type: "effect", parent: "frame", style: { fill: "amber" }, props: { kind: "trail", follow: "target", particleSize: 8 } },
  }, animations: { intro: { duration: 1000, tracks: { move: { target: "target", property: "position", keyframes: [{ at: 0, value: { x: 150, y: 30 } }, { at: 1000, value: { x: 300, y: 30 } }] } } } } });
  const output = required(exportBoardImageBytes(renderer, document, { at: { animation: "intro", time: 900 }, background: "transparent", region: { kind: "rect", rect: { x: 130, y: 0, width: 220, height: 100 } }, scale: 1 }));
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const image = await loadImage(output.bytes);
  const ctx = createCanvas(image.width, image.height).getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  assert.ok(pixels.every((value, index) => index % 4 !== 3 || value === 0));
});

test("chapter compilation preserves replace priority and additive order", () => {
  const sourceTracks = Object.fromEntries(["z", "a", ...Array.from({ length: 10 }, (_, i) => `m${i}`)].map((id, i) => [id, { target: "box", property: "position.x", keyframes: [{ at: 0, value: i + 100 }] }]));
  const document = boardDocument({ items: { box }, animations: { source: { duration: 1000, tracks: sourceTracks } } });
  const sequence = boardSequence(document, [{ animation: "source" }]);
  const expected = createBoardAnimationSampler(document, "source").at(500).document.items.box?.position.x;
  const actual = createBoardAnimationSampler({ ...document, animations: { ...document.animations, sequence } }, "sequence").at(500).document.items.box?.position.x;
  assert.equal(expected, 100);
  assert.equal(actual, expected);
  assert.deepEqual(Object.values(sequence.tracks).map((track) => track.keyframes[0]?.value), Object.values(sourceTracks).map((track) => track.keyframes[0]?.value));
});

test("chapter composition rejects shared additive properties without changing sources", () => {
  const document = boardDocument({ items: { box, other: box }, animations: {
    a: { duration: 1000, tracks: { grow: { target: "box", property: "scale", composite: "add", keyframes: [{ at: 0, value: 1 }, { at: 1000, value: 2 }] } } },
    b: { duration: 1000, tracks: { shrink: { target: "box", property: "scale", composite: "add", keyframes: [{ at: 0, value: 2 }, { at: 1000, value: 1 }] } } },
    c: { duration: 1000, tracks: { move: { target: "other", property: "scale", composite: "add", keyframes: [{ at: 0, value: 1 }, { at: 1000, value: 2 }] } } },
    component: { duration: 1000, tracks: { x: { target: "box", property: "scale.x", keyframes: [{ at: 0, value: 1 }] } } },
  } });
  const before = JSON.stringify(document);
  assert.throws(() => boardSequence(document, [{ animation: "a" }, { animation: "b" }]), /share additive tracks/);
  assert.throws(() => boardSequence(document, [{ animation: "component" }, { animation: "a" }]), /share additive tracks/);
  assert.doesNotThrow(() => boardSequence(document, [{ animation: "a" }, { animation: "c" }]));
  assert.equal(JSON.stringify(document), before);
});

test("trail direct seeking equals sequential sampling and survives emitter culling", () => {
  const document = boardDocument({
    items: {
      box,
      trail: { type: "effect", props: { kind: "trail", follow: "box", particleSize: 8 }, style: { fill: "amber" } },
    },
    animations: {
      intro: {
        duration: 1000,
        tracks: {
          move: {
            target: "box",
            property: "position",
            keyframes: [
              { at: 0, value: { x: 0, y: 0 } },
              { at: 1000, value: { x: 600, y: 0 } },
            ],
          },
        },
      },
    },
  });
  const options = {
    at: { animation: "intro", time: 900 },
    region: { kind: "rect" as const, rect: { x: 300, y: 0, width: 400, height: 100 } },
    scale: 1,
  };
  const direct = required(exportBoardImageBytes(renderer, document, options));
  const sampler = createBoardAnimationSampler(document, "intro");
  for (let time = 0; time < 900; time += 100)
    exportBoardImageBytes(renderer, document, { ...options, sampler, at: { animation: "intro", time } });
  const sequential = required(exportBoardImageBytes(renderer, document, { ...options, sampler }));
  const noTrail = required(
    exportBoardImageBytes(renderer, { ...document, items: { box: required(document.items.box) } }, options),
  );
  assert.deepEqual(direct.bytes, sequential.bytes);
  assert.notDeepEqual(direct.bytes, noTrail.bytes);
});
