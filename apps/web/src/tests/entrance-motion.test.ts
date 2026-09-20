import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ENTRANCE_DURATION_MS,
	ENTRANCE_REDUCED_MS,
	ENTRANCE_TOTAL_MS,
	entranceLandingAlpha,
	entrancePose,
	entranceProgress,
	entranceTotalMs,
} from "../lib/board/runtime/entrance-motion";

test("entrance pose starts lifted, scaled down and transparent", () => {
	const pose = entrancePose("node-a", 0);
	assert.ok(pose.y < 0);
	assert.ok(pose.scaleX < 1);
	assert.equal(pose.alpha, 0);
});

test("entrance pose settles at identity at t=1", () => {
	const pose = entrancePose("node-a", 1);
	assert.equal(pose.x, 0);
	assert.equal(pose.y, 0);
	assert.equal(pose.rotation, 0);
	assert.equal(pose.scaleX, 1);
	assert.equal(pose.scaleY, 1);
	assert.equal(pose.alpha, 1);
});

test("reduced motion only fades alpha and has no landing tail", () => {
	const pose = entrancePose("node-a", 0.5, true);
	assert.equal(pose.x, 0);
	assert.equal(pose.y, 0);
	assert.equal(pose.rotation, 0);
	assert.equal(pose.scaleX, 1);
	assert.ok(pose.alpha > 0 && pose.alpha < 1);
	assert.equal(entranceTotalMs(true), ENTRANCE_REDUCED_MS);
	assert.equal(entranceLandingAlpha(ENTRANCE_DURATION_MS + 10, true), 0);
});

test("hashed trajectories differ between ids", () => {
	const a = entrancePose("left", 0.2);
	const b = entrancePose("right", 0.2);
	assert.notEqual(a.x, b.x);
});

test("progress helpers clamp to the entrance window", () => {
	assert.equal(entranceProgress(0, false), 0);
	assert.equal(entranceProgress(ENTRANCE_DURATION_MS, false), 1);
	assert.equal(entranceProgress(ENTRANCE_TOTAL_MS, false), 1);
	assert.equal(entranceLandingAlpha(0), 0);
	assert.ok(entranceLandingAlpha(ENTRANCE_DURATION_MS + 10) > 0);
	assert.equal(entranceLandingAlpha(ENTRANCE_TOTAL_MS), 0);
});

test("deal parameters customize the preset without changing its lifecycle", () => {
	const pose = entrancePose("node-a", 0, false, {
		lift: 140,
		swing: 0,
		tilt: 0,
		scale: 0.7,
	});
	assert.equal(pose.x, 0);
	assert.equal(pose.y, -140);
	assert.equal(pose.rotation, 0);
	assert.ok(Math.abs(pose.scaleX - 0.7) < Number.EPSILON);
	assert.equal(entranceProgress(600, false, { duration: 600 }), 1);
	assert.equal(entranceTotalMs(false, { duration: 600, landing: 100 }), 700);
});
