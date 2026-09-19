import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createIOSStandaloneViewportState,
	isIOSStandaloneViewport,
	transitionIOSStandaloneViewport,
} from "$lib/ios-standalone-viewport";

test("viewport recovery only activates for an installed iOS app", () => {
	const iphone = {
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15",
		platform: "iPhone",
		maxTouchPoints: 5,
		standalone: true,
	};

	assert.equal(isIOSStandaloneViewport(iphone, false), true);
	assert.equal(
		isIOSStandaloneViewport({ ...iphone, standalone: false }, false),
		false,
	);
	assert.equal(
		isIOSStandaloneViewport(
			{
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
				platform: "MacIntel",
				maxTouchPoints: 0,
				standalone: true,
			},
			true,
		),
		false,
	);
	assert.equal(
		isIOSStandaloneViewport(
			{
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
				platform: "MacIntel",
				maxTouchPoints: 5,
				standalone: false,
			},
			true,
		),
		true,
	);
});

test("a stale post-keyboard viewport cannot replace the resting app height", () => {
	let result = {
		state: createIOSStandaloneViewportState({ width: 393, height: 852 }),
		heightOverride: null as number | null,
	};

	result = transitionIOSStandaloneViewport(result.state, {
		type: "focus",
		sample: { width: 393, height: 852 },
	});
	assert.equal(result.heightOverride, null);

	result = transitionIOSStandaloneViewport(result.state, {
		type: "resize",
		sample: { width: 393, height: 511 },
	});
	assert.equal(result.state.resting.height, 852);
	assert.equal(result.heightOverride, null);

	result = transitionIOSStandaloneViewport(result.state, { type: "blur" });
	assert.equal(result.heightOverride, 852);

	result = transitionIOSStandaloneViewport(result.state, {
		type: "resize",
		sample: { width: 393, height: 744 },
	});
	assert.equal(result.state.resting.height, 852);
	assert.equal(result.heightOverride, 852);

	result = transitionIOSStandaloneViewport(result.state, {
		type: "focus",
		sample: { width: 393, height: 852 },
	});
	result = transitionIOSStandaloneViewport(result.state, { type: "blur" });
	assert.equal(result.heightOverride, 852);
});

test("a real orientation change establishes a new resting height", () => {
	const initial = createIOSStandaloneViewportState({ width: 393, height: 852 });
	const changed = transitionIOSStandaloneViewport(initial, {
		type: "resize",
		sample: { width: 852, height: 393 },
	});

	assert.deepEqual(changed.state.resting, { width: 852, height: 393 });
	assert.equal(changed.state.phase, "resting");
	assert.equal(changed.heightOverride, null);
});

test("an orientation change during focus does not cache the keyboard height", () => {
	const initial = createIOSStandaloneViewportState({ width: 393, height: 852 });
	const focused = transitionIOSStandaloneViewport(initial, {
		type: "focus",
		sample: { width: 393, height: 852 },
	});
	const rotated = transitionIOSStandaloneViewport(focused.state, {
		type: "resize",
		sample: { width: 852, height: 248 },
	});
	const transferred = transitionIOSStandaloneViewport(rotated.state, {
		type: "focus",
		sample: { width: 852, height: 248 },
	});

	assert.deepEqual(transferred.state.resting, { width: 393, height: 852 });
	assert.equal(transferred.heightOverride, null);
});

test("invalid viewport measurements fail instead of becoming layout state", () => {
	assert.throws(
		() => createIOSStandaloneViewportState({ width: 393, height: 0 }),
		/viewport height must be a positive finite number/,
	);
});
