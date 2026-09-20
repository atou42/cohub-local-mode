import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOARD_BUILTIN_CAPABILITIES,
	DEFAULT_BOARD_RENDER_LIMITS,
} from "@cohub/protocol";
import { compileComposition, createBoardExtensionRegistry } from "../src/board/animation.js";
import { patchBoardAppearance } from "../src/board/mutation.js";
import { createBattleFixture } from "./fixtures/battle.js";

test("battle fixture compilation is deterministic", () => {
	const input = { leftImagePath: "assets/left.png", rightImagePath: "assets/right.png" };
	assert.deepEqual(createBattleFixture(input), createBattleFixture(input));
});

test("battle fixtures preserve Board playback policy", () => {
	const fixture = createBattleFixture({
		leftImagePath: "assets/left.png",
		rightImagePath: "assets/right.png",
		autoplayDelay: 750,
	});
	assert.deepEqual(fixture.metadata.playback, {
		compositionId: "battle",
		delayMs: 750,
	});
});

test("built-in registry validates and estimates the battle fixture", () => {
	const fixture = createBattleFixture({
		leftImagePath: "assets/left.png",
		rightImagePath: "assets/right.png",
	});
	const registry = createBoardExtensionRegistry();
	const validation = registry.validate({ composition: fixture.composition, effects: fixture.effects });
	assert.equal(validation.valid, true);
	assert.equal(validation.peakCost.particles, 420);
	assert.equal(validation.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNKNOWN_")), false);
	assert.deepEqual(registry.capabilities(), BOARD_BUILTIN_CAPABILITIES);
});

test("SDK validator returns diagnostics for invalid compositions", () => {
	const result = createBoardExtensionRegistry().validate({
		composition: { bad: true } as never,
	});
	assert.equal(result.valid, false);
	assert.equal(result.diagnostics[0]?.code, "INVALID_COMPOSITION");
});

test("SDK validator includes effects and custom render limits", () => {
	const fixture = createBattleFixture({ leftImagePath: "left.png", rightImagePath: "right.png" });
	const result = createBoardExtensionRegistry().validate({
		composition: fixture.composition,
		effects: fixture.effects,
		limits: { particles: 100, vertices: 1_000_000, dynamicVertices: 1_000_000, drawCalls: 1_000, filterPasses: 1_000, renderTexturePixels: 1_000_000_000, textureBytes: 1_000_000_000, bufferBytes: 1_000_000_000, simulationSteps: 1_000_000 },
	});
	assert.equal(result.peakCost.particles, 420);
	assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "RENDER_BUDGET_EXCEEDED" && diagnostic.path === "particles"), true);
});

test("SDK render limits stay aligned with the protocol", async () => {
	const { DEFAULT_BOARD_LIMITS } = await import("../src/board/animation.js");
	assert.deepEqual(DEFAULT_BOARD_LIMITS, DEFAULT_BOARD_RENDER_LIMITS);
});

test("resident effects add to the render budget instead of sharing one slot", () => {
	const effect = (id: string) => ({
		id,
		target: { type: "item" as const, itemId: id },
		kind: "effects.deal",
		kindVersion: 1,
		enabled: true,
		lifecycle: "on-enter" as const,
		timeOrigin: "activation" as const,
		layer: "front" as const,
		seed: id,
		params: {},
		assetRefs: [],
		metadata: {},
	});
	const result = createBoardExtensionRegistry().validate({
		composition: compileComposition({ id: "empty", name: "Empty", duration: 1 }),
		effects: [effect("a"), effect("b"), effect("c")],
	});
	assert.equal(result.peakCost.drawCalls, 3);
	assert.equal(result.valid, true);
});

test("Board appearance patches preserve nested settings", () => {
	const appearance = patchBoardAppearance({
		background: { kind: "solid" },
		grid: { visible: true, size: 32, opacity: 0.2 },
	}, { background: { kind: "solid", color: "#123456" } });
	assert.equal(appearance.grid.visible, true);
	assert.equal(appearance.background.color, "#123456");
});

test("registry reports invalid particle bounds without dropping the clip", () => {
	const fixture = createBattleFixture({
		leftImagePath: "assets/left.png",
		rightImagePath: "assets/right.png",
	});
	const particles = fixture.clips.find((clip) => clip.kind === "effects.particles");
	if (!particles) throw new Error("battle fixture is missing particles");
	const validation = createBoardExtensionRegistry().validate({
		composition: {
			...fixture.composition,
			timeline: {
				...fixture.composition.timeline,
				clips: [{ ...particles, params: { count: 100 } }],
			},
		},
	});
	assert.equal(validation.valid, false);
	assert.equal(validation.diagnostics[0]?.code, "PARTICLE_BOUNDS_REQUIRED");
});

test("an unshipped built-in effect version is reported, not silently accepted", () => {
	const result = createBoardExtensionRegistry().validate({
		composition: compileComposition({ id: "empty", name: "Empty", duration: 1 }),
		effects: [{
			id: "deal-v2",
			target: { type: "item", itemId: "hero" },
			kind: "effects.deal",
			kindVersion: 2,
			enabled: true,
			lifecycle: "on-enter",
			timeOrigin: "activation",
			layer: "front",
			seed: "deal-v2",
			params: {},
			assetRefs: [],
			metadata: {},
		}],
	});
	assert.ok(result.diagnostics.some((d) => d.code === "UNKNOWN_EFFECT" && d.path === "effects.deal-v2"));
	// No renderer means no render cost either.
	assert.equal(result.peakCost.drawCalls, 0);
});
