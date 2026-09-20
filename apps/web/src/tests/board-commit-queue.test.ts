import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardDocument, BoardItem } from "@neta-art/cohub/board";
import { createCommitQueue } from "../lib/board/board-commit-queue.ts";

function makeDoc(items: BoardItem[]): BoardDocument {
	return {
		kind: "cohub.board",
		version: 1,
		appearance: {
			background: { kind: "grid" },
			grid: { visible: true, size: 32, opacity: 0.22 },
		},
		viewport: { x: 0, y: 0, zoom: 1 },
		items,
		connections: [],
	};
}

function textItem(id: string, text: string): BoardItem {
	return {
		id,
		type: "text",
		text,
		color: "neutral",
		fontSize: 18,
		frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
	};
}

test("commits run serially, never concurrently", async () => {
	let inFlight = 0;
	let maxConcurrent = 0;
	const queue = createCommitQueue(async () => {
		inFlight += 1;
		maxConcurrent = Math.max(maxConcurrent, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 5));
		inFlight -= 1;
	});
	queue.reset(makeDoc([]));
	const results = await Promise.all([
		queue.commit(makeDoc([textItem("a", "1")])),
		queue.commit(makeDoc([textItem("a", "1"), textItem("b", "2")])),
		queue.commit(
			makeDoc([textItem("a", "1"), textItem("b", "2"), textItem("c", "3")]),
		),
	]);
	assert.equal(maxConcurrent, 1);
	for (const result of results) assert.equal(result.ok, true);
});

test("each commit only sends the delta against the advancing baseline", async () => {
	const queue = createCommitQueue(async () => {});
	queue.reset(makeDoc([]));
	const r1 = await queue.commit(makeDoc([textItem("a", "1")]));
	const r2 = await queue.commit(
		makeDoc([textItem("a", "1"), textItem("b", "2")]),
	);
	assert.ok(r1.ok && r2.ok);
	// First commit creates "a".
	assert.equal(r1.commands.length, 1);
	assert.equal(r1.commands[0]?.type, "item.create");
	assert.equal(
		r1.commands[0]?.type === "item.create" && r1.commands[0].item.id,
		"a",
	);
	// Second commit creates only "b" — it must not re-create "a".
	assert.equal(r2.commands.length, 1);
	assert.equal(r2.commands[0]?.type, "item.create");
	assert.equal(
		r2.commands[0]?.type === "item.create" && r2.commands[0].item.id,
		"b",
	);
});

test("a failed commit does not advance the baseline; the next re-sends", async () => {
	let shouldFail = true;
	const queue = createCommitQueue(async () => {
		if (shouldFail) throw new Error("network down");
	});
	queue.reset(makeDoc([]));
	const snapshot = makeDoc([textItem("a", "1")]);

	const failed = await queue.commit(snapshot);
	assert.equal(failed.ok, false);

	shouldFail = false;
	const retried = await queue.commit(snapshot);
	assert.ok(retried.ok);
	// Baseline never advanced, so the create is re-sent in full.
	assert.equal(retried.commands.length, 1);
	assert.equal(
		retried.commands[0]?.type === "item.create" && retried.commands[0].item.id,
		"a",
	);
});

test("isEcho recognises a committed snapshot exactly once", async () => {
	const queue = createCommitQueue(async () => {});
	queue.reset(makeDoc([]));
	const snapshot = makeDoc([textItem("a", "1")]);
	await queue.commit(snapshot);
	assert.equal(queue.isEcho(snapshot), true);
	// Consumed — a second check no longer matches.
	assert.equal(queue.isEcho(snapshot), false);
	// An unrelated document is never an echo.
	assert.equal(queue.isEcho(makeDoc([textItem("z", "9")])), false);
});

test("a commit with no changes is a no-op that skips onCommit", async () => {
	let called = 0;
	const queue = createCommitQueue(async () => {
		called += 1;
	});
	queue.reset(makeDoc([]));
	const result = await queue.commit(makeDoc([]));
	assert.ok(result.ok);
	assert.equal(result.commands.length, 0);
	assert.equal(called, 0);
});

test("the queue keeps processing after a failure", async () => {
	let failNext = true;
	const queue = createCommitQueue(async () => {
		if (failNext) {
			failNext = false;
			throw new Error("transient");
		}
	});
	queue.reset(makeDoc([]));
	const first = await queue.commit(makeDoc([textItem("a", "1")]));
	assert.equal(first.ok, false);
	const second = await queue.commit(makeDoc([textItem("a", "1")]));
	assert.ok(second.ok);
	assert.equal(second.commands.length, 1);
});

test("reset is a barrier: an in-flight commit cannot advance the baseline", async () => {
	let resolveFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	let calls = 0;
	const queue = createCommitQueue(async () => {
		calls += 1;
		if (calls === 1) await firstBlocked;
	});
	const d0 = makeDoc([]);
	const d1 = makeDoc([textItem("a", "1")]);
	const d2 = makeDoc([textItem("b", "2")]);
	queue.reset(d0);

	const inFlight = queue.commit(d1);
	await new Promise((resolve) => setTimeout(resolve, 0)); // let it start
	queue.reset(d2); // external update arrives mid-flight
	resolveFirst?.();
	await inFlight;

	// Baseline is now d2 (the in-flight d1 must not have advanced it), so the
	// next diff only contains the delta from d2.
	const d3 = makeDoc([textItem("b", "2"), textItem("c", "3")]);
	const result = await queue.commit(d3);
	assert.ok(result.ok);
	assert.equal(result.commands.length, 1);
	assert.equal(
		result.commands[0]?.type === "item.create" && result.commands[0].item.id,
		"c",
	);
});

test("reset clears the echo set", async () => {
	const queue = createCommitQueue(async () => {});
	queue.reset(makeDoc([]));
	const snapshot = makeDoc([textItem("a", "1")]);
	await queue.commit(snapshot);
	queue.reset(makeDoc([textItem("z", "9")]));
	assert.equal(queue.isEcho(snapshot), false);
});

test("reset preserves serialization: onCommit never runs concurrently", async () => {
	let inFlight = 0;
	let maxConcurrent = 0;
	let resolveBlock: (() => void) | undefined;
	const blocked = new Promise<void>((resolve) => {
		resolveBlock = resolve;
	});
	let shouldBlock = true;
	const queue = createCommitQueue(async () => {
		inFlight += 1;
		maxConcurrent = Math.max(maxConcurrent, inFlight);
		if (shouldBlock) {
			shouldBlock = false;
			await blocked;
		}
		inFlight -= 1;
	});
	queue.reset(makeDoc([]));
	const first = queue.commit(makeDoc([textItem("a", "1")]));
	await new Promise((resolve) => setTimeout(resolve, 0)); // let it start
	queue.reset(makeDoc([textItem("b", "2")])); // barrier while first is in flight
	const second = queue.commit(
		makeDoc([textItem("b", "2"), textItem("c", "3")]),
	);
	resolveBlock?.();
	await Promise.all([first, second]);
	assert.equal(maxConcurrent, 1);
});
