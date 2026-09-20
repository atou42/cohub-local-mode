import type {
	BoardTransactionsPage,
	BoardTransactionsReadInput,
} from "@neta-art/cohub";
import {
	type BoardReplayEntry,
	type BoardReplayPlayer,
	createBoardReplayPlayer,
} from "@neta-art/cohub/board";

export type BoardReplaySpeed = 1 | 2 | 4;
export const BOARD_REPLAY_SPEEDS: readonly BoardReplaySpeed[] = [1, 2, 4];

/**
 * Fixed cadence per step at 1×. Real gaps between edits are seconds to days;
 * a steady beat reads as a story rather than a stutter.
 */
export const BOARD_REPLAY_STEP_MS = 640;
/** Page size for the transaction log; a few hundred versions per round trip. */
export const BOARD_REPLAY_PAGE_SIZE = 200;

export type BoardReplayFetch = (
	input: BoardTransactionsReadInput,
) => Promise<BoardTransactionsPage>;

/** Index of the first entry with `version >= target`; `entries.length` if none. */
function lowerBound(
	entries: readonly BoardReplayEntry[],
	target: number,
): number {
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((entries[mid] as BoardReplayEntry).version < target) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * Timeline position for a version: entries are laid out evenly, not by time,
 * so a burst of 40 nudges does not collapse into one pixel. Returns the 1-based
 * step index (0 at the floor) so both the scrubber and the "n of m" label read it.
 */
export function replayStep(
	entries: readonly BoardReplayEntry[],
	floor: number,
	version: number,
): number {
	if (version <= floor) return 0;
	const index = lowerBound(entries, version);
	return index < entries.length ? index + 1 : entries.length;
}

export function replayFraction(
	entries: readonly BoardReplayEntry[],
	floor: number,
	version: number,
): number {
	return entries.length === 0
		? 1
		: replayStep(entries, floor, version) / entries.length;
}

/** Inverse of `replayFraction`: the version under a scrubber fraction. */
export function replayVersionAt(
	entries: readonly BoardReplayEntry[],
	floor: number,
	fraction: number,
): number {
	if (entries.length === 0) return floor;
	const clamped = Math.max(0, Math.min(1, fraction));
	const position = Math.round(clamped * entries.length);
	if (position <= 0) return floor;
	return entries[Math.min(position, entries.length) - 1]?.version ?? floor;
}

/** The entry that produced `version`, if it is loaded. */
export function replayEntryAt(
	entries: readonly BoardReplayEntry[],
	version: number,
): BoardReplayEntry | null {
	const entry = entries[lowerBound(entries, version)];
	return entry?.version === version ? entry : null;
}

/** Loaded version strictly before `version`, or the floor. */
export function replayPreviousVersion(
	entries: readonly BoardReplayEntry[],
	floor: number,
	version: number,
): number {
	return entries[lowerBound(entries, version) - 1]?.version ?? floor;
}

/** Loaded version strictly after `version`, or `version` at the head. */
export function replayNextVersion(
	entries: readonly BoardReplayEntry[],
	version: number,
): number {
	return entries[lowerBound(entries, version + 1)]?.version ?? version;
}

/**
 * Load the first page and build a player. Kept apart from the component so the
 * fetch shape (and the "first page must carry a snapshot" invariant) is testable.
 */
export async function loadBoardReplay(
	fetch: BoardReplayFetch,
): Promise<{ player: BoardReplayPlayer; nextBefore: number | null }> {
	const page = await fetch({ limit: BOARD_REPLAY_PAGE_SIZE });
	return { player: createBoardReplayPlayer(page), nextBefore: page.nextBefore };
}
