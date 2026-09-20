import assert from "node:assert/strict";
import { test } from "node:test";
import { sameCommandItemSequence } from "../lib/command-palette/merge-results";

type KeySource = Parameters<typeof sameCommandItemSequence>[0][number];

function space(id: string): KeySource {
	return {
		type: "space",
		id,
		spaceId: id,
		sessionId: null,
		turnId: null,
	};
}

function session(id: string, spaceId: string): KeySource {
	return {
		type: "session",
		id,
		spaceId,
		sessionId: id,
		turnId: null,
	};
}

function turn(id: string, sessionId: string): KeySource {
	return {
		type: "turn",
		id,
		spaceId: "s1",
		sessionId,
		turnId: id,
	};
}

test("identical ordered keys are the same sequence", () => {
	const left = [space("a"), session("s1", "a"), turn("t1", "s1")];
	const right = [space("a"), session("s1", "a"), turn("t1", "s1")];
	assert.equal(sameCommandItemSequence(left, right), true);
});

test("a different order is not the same sequence", () => {
	const left = [space("a"), space("b")];
	const right = [space("b"), space("a")];
	assert.equal(sameCommandItemSequence(left, right), false);
});

test("a different length is not the same sequence", () => {
	assert.equal(sameCommandItemSequence([space("a")], []), false);
});

test("same space id but a different resource type is not the same sequence", () => {
	const left = [space("a")];
	const right: KeySource[] = [
		{ type: "command", id: "a", spaceId: "a", sessionId: null, turnId: null },
	];
	assert.equal(sameCommandItemSequence(left, right), false);
});
