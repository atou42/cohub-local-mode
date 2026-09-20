import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type BoardRuntimeData,
	diffBoardRuntimeData,
	sameBoardAnimationSpec,
} from "../lib/board/runtime/board-runtime.ts";

function runtime(patch: Partial<BoardRuntimeData> = {}): BoardRuntimeData {
	return {
		boardId: "board",
		effects: [],
		compositions: [],
		enter: null,
		playback: null,
		playbackPolicy: null,
		...patch,
	};
}

test("diffBoardRuntimeData reports no change for identical references", () => {
	const base = runtime();
	assert.deepEqual(diffBoardRuntimeData(base, base), {
		board: false,
		effects: false,
		compositions: false,
		enter: false,
		playback: false,
		playbackPolicy: false,
	});
	// A fresh wrapper around the same slices is still not a change.
	assert.deepEqual(diffBoardRuntimeData(base, runtime({ ...base })), {
		board: false,
		effects: false,
		compositions: false,
		enter: false,
		playback: false,
		playbackPolicy: false,
	});
});

test("diffBoardRuntimeData compares enter by value, not reference", () => {
	const prev = runtime({
		enter: { kind: "effects.deal", kindVersion: 1, params: { lift: 90 } },
	});
	const sameValue = runtime({
		enter: { kind: "effects.deal", kindVersion: 1, params: { lift: 90 } },
	});
	const differentValue = runtime({
		enter: { kind: "effects.deal", kindVersion: 1, params: { lift: 120 } },
	});
	assert.equal(diffBoardRuntimeData(prev, sameValue).enter, false);
	assert.equal(diffBoardRuntimeData(prev, differentValue).enter, true);
	assert.equal(diffBoardRuntimeData(prev, runtime()).enter, true);
});

test("diffBoardRuntimeData tracks each runtime slice independently", () => {
	const base = runtime();
	const next: BoardRuntimeData = {
		...base,
		effects: [],
		playbackPolicy: { compositionId: "sequence", delayMs: 0 },
	};
	const diff = diffBoardRuntimeData(base, next);
	assert.equal(diff.effects, true);
	assert.equal(diff.playbackPolicy, true);
	assert.equal(diff.compositions, false);
	assert.equal(diff.playback, false);
	assert.equal(diff.board, false);
	assert.equal(diff.enter, false);
});

test("sameBoardAnimationSpec distinguishes kind, version and absence", () => {
	const deal = { kind: "effects.deal", kindVersion: 1, params: {} };
	assert.equal(sameBoardAnimationSpec(deal, { ...deal, params: {} }), true);
	assert.equal(
		sameBoardAnimationSpec(deal, { ...deal, kindVersion: 2 }),
		false,
	);
	assert.equal(sameBoardAnimationSpec(null, null), true);
	assert.equal(sameBoardAnimationSpec(null, deal), false);
});
