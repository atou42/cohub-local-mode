import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardReplayEntry } from "@neta-art/cohub/board";
import {
	replayEntryAt,
	replayFraction,
	replayNextVersion,
	replayPreviousVersion,
	replayStep,
	replayVersionAt,
} from "$lib/board/board-replay";

/**
 * Timeline math over a sparse, sorted version list. Versions 1 2 3 4 6 with
 * floor 0: v5 is a no-op gap that must resolve to the step below it.
 */
const entries: BoardReplayEntry[] = [1, 2, 3, 4, 6].map((version) => ({
	version,
	actorId: "a",
	kind: "human",
	at: version,
	visual: true,
}));

test("step and fraction lay entries out evenly and treat gaps as the step below", () => {
	assert.equal(replayStep(entries, 0, 0), 0);
	assert.equal(replayStep(entries, 0, 1), 1);
	assert.equal(replayStep(entries, 0, 4), 4);
	assert.equal(replayStep(entries, 0, 5), 5);
	assert.equal(replayStep(entries, 0, 6), 5);
	assert.equal(replayStep(entries, 0, 99), 5);
	assert.equal(replayFraction(entries, 0, 0), 0);
	assert.equal(replayFraction(entries, 0, 6), 1);
	assert.equal(replayFraction([], 0, 0), 1);
});

test("scrubber fraction round-trips to the version under it", () => {
	assert.equal(replayVersionAt(entries, 0, 0), 0);
	assert.equal(replayVersionAt(entries, 0, 1), 6);
	assert.equal(replayVersionAt(entries, 0, -1), 0);
	assert.equal(replayVersionAt(entries, 0, 2), 6);
	for (const entry of entries) {
		assert.equal(
			replayVersionAt(entries, 0, replayFraction(entries, 0, entry.version)),
			entry.version,
		);
	}
	assert.equal(replayVersionAt([], 3, 0.5), 3);
});

test("entry lookup is exact", () => {
	assert.equal(replayEntryAt(entries, 4)?.version, 4);
	assert.equal(replayEntryAt(entries, 5), null);
	assert.equal(replayEntryAt(entries, 0), null);
	assert.equal(replayEntryAt([], 1), null);
});

test("previous and next step across gaps and clamp at the ends", () => {
	assert.equal(replayPreviousVersion(entries, 0, 6), 4);
	assert.equal(replayPreviousVersion(entries, 0, 5), 4);
	assert.equal(replayPreviousVersion(entries, 0, 1), 0);
	assert.equal(replayPreviousVersion(entries, 0, 0), 0);
	assert.equal(replayNextVersion(entries, 0), 1);
	assert.equal(replayNextVersion(entries, 4), 6);
	assert.equal(replayNextVersion(entries, 5), 6);
	assert.equal(replayNextVersion(entries, 6), 6);
	assert.equal(replayNextVersion([], 3), 3);
});
