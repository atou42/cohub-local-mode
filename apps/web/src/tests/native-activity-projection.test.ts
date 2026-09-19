import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeDisplayName } from "$lib/native-activity/display-name";
import {
	applyNativeActivityTurn,
	buildNativeActivitySnapshot,
	parseNativeActivityTurn,
	parseTurnRealtimeEvent,
	reconcilePinnedSpaceOrder,
	resolveNativeFreshness,
	selectNativePulseFocus,
} from "$lib/native-activity/projection";
import type {
	NativeActivitySpaceSource,
	NativeActivityTurn,
} from "$lib/native-activity/types";

const timestamp = (minute: number) =>
	`2026-08-31T10:${String(minute).padStart(2, "0")}:00.000Z`;

function turn(
	input: {
		id?: string;
		spaceId?: string;
		sessionId?: string;
		sequence?: number;
		status?: NativeActivityTurn["status"];
		minute?: number;
		sourceOrder?: number;
	} = {},
): NativeActivityTurn {
	const minute = input.minute ?? 0;
	return {
		id: input.id ?? "00000000-0000-4000-8000-000000000001",
		spaceId: input.spaceId ?? "00000000-0000-4000-8000-000000000010",
		sessionId: input.sessionId ?? "00000000-0000-4000-8000-000000000020",
		sessionTitle: "Ship Focus Board",
		sessionSource: "manual",
		sessionHarness: "codex",
		sequence: input.sequence ?? 1,
		status: input.status ?? "running",
		provider: "openai",
		model: "gpt-5.6-sol",
		userPreview: "Build the bridge",
		assistantPreview: null,
		startedAt: timestamp(minute),
		completedAt: null,
		createdAt: timestamp(minute),
		updatedAt: timestamp(minute),
		errorMessage: null,
		sourceOrder: input.sourceOrder ?? minute,
	};
}

const spaces = [
	{
		id: "00000000-0000-4000-8000-000000000010",
		name: "One",
		origin: "local",
		isPinned: true,
	},
	{
		id: "00000000-0000-4000-8000-000000000011",
		name: "Two",
		origin: "cloud",
		isPinned: true,
	},
	{
		id: "00000000-0000-4000-8000-000000000012",
		name: "Three",
		origin: "cloud",
		isPinned: true,
	},
	{
		id: "00000000-0000-4000-8000-000000000013",
		name: "Current",
		origin: "local",
		isPinned: false,
	},
] satisfies [
	NativeActivitySpaceSource,
	NativeActivitySpaceSource,
	NativeActivitySpaceSource,
	NativeActivitySpaceSource,
];

test("pinned Space order remains stable and appends newly pinned Spaces", () => {
	assert.deepEqual(
		reconcilePinnedSpaceOrder(
			[spaces[1].id, spaces[0].id],
			[spaces[0], spaces[1], spaces[2], spaces[3]],
		),
		[spaces[1].id, spaces[0].id, spaces[2].id],
	);
	assert.deepEqual(
		reconcilePinnedSpaceOrder(
			[spaces[1].id, spaces[0].id, spaces[2].id],
			[{ ...spaces[0], isPinned: false }, spaces[1], spaces[2]],
		),
		[spaces[1].id, spaces[2].id],
	);
});

test("explicit focus wins even when a newer active turn is dispatched", () => {
	const explicit = {
		spaceId: spaces[0].id,
		sessionId: "00000000-0000-4000-8000-000000000020",
		explicit: true as const,
	};
	const selected = selectNativePulseFocus({
		explicitFocus: explicit,
		candidateSpaceIds: [spaces[0].id, spaces[1].id],
		turnsBySpace: new Map([
			[spaces[0].id, [turn({ minute: 1 })]],
			[
				spaces[1].id,
				[
					turn({
						id: "00000000-0000-4000-8000-000000000002",
						spaceId: spaces[1].id,
						sessionId: "00000000-0000-4000-8000-000000000021",
						minute: 9,
					}),
				],
			],
		]),
	});
	assert.deepEqual(selected, explicit);
});

test("without explicit focus the newest active turn in the current route Space wins", () => {
	const selected = selectNativePulseFocus({
		explicitFocus: null,
		candidateSpaceIds: [spaces[0].id, spaces[3].id],
		turnsBySpace: new Map([
			[spaces[0].id, [turn({ minute: 2 })]],
			[
				spaces[3].id,
				[
					turn({
						id: "00000000-0000-4000-8000-000000000003",
						spaceId: spaces[3].id,
						sessionId: "00000000-0000-4000-8000-000000000023",
						minute: 8,
					}),
				],
			],
		]),
	});
	assert.deepEqual(selected, {
		spaceId: spaces[3].id,
		sessionId: "00000000-0000-4000-8000-000000000023",
		explicit: false,
	});
});

test("an unpinned explicit focus joins the catalog without changing board order", () => {
	const watched = [spaces[0].id, spaces[1].id, spaces[2].id];
	const focusedTurn = turn({
		id: "00000000-0000-4000-8000-000000000004",
		spaceId: spaces[3].id,
		sessionId: "00000000-0000-4000-8000-000000000024",
		minute: 7,
	});
	const snapshot = buildNativeActivitySnapshot({
		revision: 7,
		generatedAt: timestamp(9),
		freshness: "live",
		spaces,
		watchedSpaceIds: watched,
		turnsBySpace: new Map([[spaces[3].id, [focusedTurn]]]),
		focus: {
			spaceId: spaces[3].id,
			sessionId: focusedTurn.sessionId,
			explicit: true,
		},
	});
	assert.deepEqual(snapshot.boardSpaceIds, watched);
	assert.deepEqual(
		snapshot.spaces.map((space) => space.spaceId),
		[...watched, spaces[3].id],
	);
	assert.equal(snapshot.primarySpaceId, spaces[3].id);
	assert.equal(snapshot.spaces.at(-1)?.isPrimary, true);
});

test("an explicit empty Session never falls back to another Turn in the same Space", () => {
	const otherSessionTurn = turn({
		sessionId: "00000000-0000-4000-8000-000000000099",
		minute: 7,
	});
	const snapshot = buildNativeActivitySnapshot({
		revision: 8,
		generatedAt: timestamp(9),
		freshness: "live",
		spaces,
		watchedSpaceIds: [spaces[0].id],
		turnsBySpace: new Map([[spaces[0].id, [otherSessionTurn]]]),
		focus: {
			spaceId: spaces[0].id,
			sessionId: "00000000-0000-4000-8000-000000000098",
			explicit: true,
		},
	});
	assert.equal(snapshot.primarySessionId, null);
	assert.equal(snapshot.spaces[0]?.activity, null);
});

test("realtime parser accepts text fields and preserves REST session harness", () => {
	const previous = turn({ minute: 1 });
	const parsed = parseTurnRealtimeEvent(
		{
			id: "event-2",
			timestamp: 20,
			domain: "session",
			type: "session.turn.updated",
			spaceId: previous.spaceId,
			sessionId: previous.sessionId,
			payload: {
				turn: {
					id: previous.id,
					assistantText: "Authoritative realtime summary",
					updatedAt: timestamp(2),
				},
			},
		},
		previous,
	);
	assert.equal(parsed.accepted, true);
	if (!parsed.accepted) return;
	assert.equal(parsed.turn.assistantPreview, "Authoritative realtime summary");
	assert.equal(parsed.turn.sessionHarness, "codex");

	const restParsed = parseNativeActivityTurn({
		spaceId: previous.spaceId,
		sourceOrder: 1,
		turn: {
			...previous,
		},
		session: {
			title: "Session",
			source: "discord",
			agentHarness: "cursor",
		},
	});
	assert.equal(restParsed.accepted, true);
	if (restParsed.accepted) {
		assert.equal(restParsed.turn.sessionSource, "discord");
		assert.equal(restParsed.turn.sessionHarness, "cursor");
	}
});

test("malformed events are rejected instead of becoming healthy state", () => {
	const parsed = parseTurnRealtimeEvent({
		id: "bad-event",
		timestamp: 1,
		domain: "session",
		type: "session.turn.updated",
		spaceId: spaces[0].id,
		sessionId: "00000000-0000-4000-8000-000000000020",
		payload: {
			turn: {
				id: "00000000-0000-4000-8000-000000000001",
				status: "mystery",
				updatedAt: "not-a-date",
			},
		},
	});
	assert.equal(parsed.accepted, false);
});

test("native display names match the database limit and reject unsafe text", () => {
	assert.equal(parseNativeDisplayName("  Focus Board  "), "Focus Board");
	assert.equal(parseNativeDisplayName("x".repeat(255)), "x".repeat(255));
	assert.equal(parseNativeDisplayName("😀".repeat(255)), "😀".repeat(255));
	for (const invalid of [
		undefined,
		"",
		"   ",
		"bad\u0001name",
		"bad\u2028name",
		"bad\u2029name",
		"x".repeat(256),
	]) {
		assert.equal(parseNativeDisplayName(invalid), null);
	}
});

test("REST Turns reject a missing Session name instead of using its UUID", () => {
	const source = turn();
	const parsed = parseNativeActivityTurn({
		spaceId: source.spaceId,
		turn: source,
		session: {
			title: null,
			source: "manual",
			agentHarness: "codex",
		},
		sourceOrder: source.sourceOrder,
	});
	assert.equal(parsed.accepted, false);
	if (!parsed.accepted) assert.match(parsed.reason, /display name/);
});

test("freshness stays recovering until REST reconciliation and becomes stale on failure", () => {
	assert.equal(
		resolveNativeFreshness({
			online: true,
			connectionState: "open",
			reconciling: true,
			hasReconciled: true,
			reconcileFailed: false,
		}),
		"recovering",
	);
	assert.equal(
		resolveNativeFreshness({
			online: true,
			connectionState: "open",
			reconciling: false,
			hasReconciled: true,
			reconcileFailed: true,
		}),
		"stale",
	);
	assert.equal(
		resolveNativeFreshness({
			online: true,
			connectionState: "open",
			reconciling: false,
			hasReconciled: true,
			reconcileFailed: false,
		}),
		"live",
	);
});

test("duplicate and out-of-order turn updates do not replace current state", () => {
	const current = turn({ minute: 5, sourceOrder: 10 });
	const duplicate = applyNativeActivityTurn([current], { ...current });
	assert.equal(duplicate.accepted, false);
	assert.equal(duplicate.reason, "duplicate");
	assert.equal(duplicate.turns[0], current);

	const older = applyNativeActivityTurn(
		[current],
		turn({ minute: 4, sourceOrder: 20 }),
	);
	assert.equal(older.accepted, false);
	assert.equal(older.reason, "out_of_order");
	assert.equal(older.turns[0], current);

	const terminal = turn({ minute: 6, status: "completed", sourceOrder: 30 });
	const regression = applyNativeActivityTurn(
		[terminal],
		turn({ minute: 7, status: "running", sourceOrder: 40 }),
	);
	assert.equal(regression.accepted, false);
	assert.equal(regression.reason, "invalid_regression");
});
