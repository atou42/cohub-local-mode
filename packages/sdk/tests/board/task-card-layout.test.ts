import assert from "node:assert/strict";
import { test } from "node:test";
import { containRect as containTaskPreviewRect } from "../../src/board/render/surface.js";

test("task preview contains landscape media without cropping", () => {
	assert.deepEqual(containTaskPreviewRect(300, 180, 1600, 900), {
		x: 0,
		y: 5.625,
		width: 300,
		height: 168.75,
	});
});

test("task preview contains portrait media without distortion", () => {
	assert.deepEqual(containTaskPreviewRect(300, 180, 900, 1600), {
		x: 99.375,
		y: 0,
		width: 101.25,
		height: 180,
	});
});

test("task preview safely handles missing dimensions", () => {
	assert.deepEqual(containTaskPreviewRect(300, 180, 0, 900), {
		x: 0,
		y: 0,
		width: 0,
		height: 0,
	});
});
