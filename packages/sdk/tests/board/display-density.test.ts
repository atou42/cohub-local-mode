import assert from "node:assert/strict";
import { test } from "node:test";
import type { Text } from "pixi.js";
import { getBoardResolution, syncTextResolution, textResolutionForZoom } from "../../src/board/render/text-resolution.js";

test("board density supports DPR 3 within the canvas pixel budget", () => {
	assert.equal(getBoardResolution({ width: 390, height: 844 }, 3), 3);
	const size = { width: 3840, height: 2160 };
	assert.ok(size.width * size.height * getBoardResolution(size, 3) ** 2 <= 8_000_000 + 1);
});

test("shared resolution state refreshes every text label", () => {
	const resolution = textResolutionForZoom(1);
	const state = { resolution };
	const labels = [{ resolution: 0 }, { resolution: 0 }] as Text[];
	for (const text of labels) syncTextResolution(text, state, 1);
	assert.deepEqual(labels.map((text) => text.resolution), [resolution, resolution]);
});
