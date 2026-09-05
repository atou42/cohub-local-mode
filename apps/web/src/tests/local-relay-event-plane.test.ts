import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildRelaySessionCreation,
	decideRelayCommandReconcile,
	decideRelayTurnEvent,
	findOptimisticTurnForRelayCommand,
	isTerminalRelayTurnStatus,
	mergeRelayCommandStatuses,
	queuedRelayCancelTargets,
	RELAY_TURN_EVENT_DEDUP_CAP,
	rememberRelayEventId,
	shouldCreateRelaySession,
} from "../lib/features/session-chat/local-relay-event-plane";
import type { LocalRelayEventCommand } from "../lib/local-relay-events";

const pending = { sessionId: "session-1" };

function command(
	status: LocalRelayEventCommand["status"],
	result: LocalRelayEventCommand["result"] = null,
): LocalRelayEventCommand {
	return {
		id: "command-1",
		status,
		errorCode: status === "failed" ? "local_api_rejected" : null,
		errorMessage: status === "failed" ? "failed" : null,
		result,
	};
}

function succeededBody(turnStatus: string, extras: Record<string, unknown> = {}) {
	return {
		status: 200,
		headers: {},
		body: JSON.stringify({
			session: { id: "session-1" },
			turn: { id: "turn-1", sessionId: "session-1", status: turnStatus },
			...extras,
		}),
	};
}

test("a first relay send requests Session creation", () => {
	assert.equal(shouldCreateRelaySession(null), true);
	assert.equal(shouldCreateRelaySession(undefined), true);
});

test("a real Session does not request relay creation", () => {
	assert.equal(shouldCreateRelaySession({}), false);
	assert.equal(shouldCreateRelaySession({ meta: null }), false);
	assert.equal(shouldCreateRelaySession({ meta: { relayPending: false } }), false);
	assert.equal(shouldCreateRelaySession({ meta: { relayPending: "true" } }), false);
});

test("failed relay reconciliation preserves the provisional Session for creation on retry", () => {
	const session = {
		id: pending.sessionId,
		meta: { relayPending: true, relayCommandId: "command-1" },
	};
	const decision = decideRelayCommandReconcile(pending, command("failed"));
	assert.deepEqual(decision, { action: "failed" });
	const retry = {
		sessionId: session.id,
		createSession: shouldCreateRelaySession(session),
	};
	assert.deepEqual(retry, { sessionId: pending.sessionId, createSession: true });
	assert.deepEqual(session.meta, {
		relayPending: true,
		relayCommandId: "command-1",
	});
});

test("a successful relay result replaces the provisional Session and stops requesting creation", () => {
	const provisional = { id: pending.sessionId, meta: { relayPending: true } };
	assert.equal(shouldCreateRelaySession(provisional), true);
	const decision = decideRelayCommandReconcile(
		pending,
		command("succeeded", succeededBody("running")),
	);
	assert.equal(decision.action, "succeeded");
	if (decision.action !== "succeeded") throw new Error("Expected relay success");
	assert.equal(decision.session.id, provisional.id);
	assert.equal(shouldCreateRelaySession(decision.session), false);
});

for (const agentHarness of ["codex", "grok", "cursor"] as const) {
	test(`a failed provisional ${agentHarness} Session retries with its original harness`, () => {
		const session = {
			id: pending.sessionId,
			agentHarness,
			meta: { relayPending: true },
		};
		assert.deepEqual(decideRelayCommandReconcile(pending, command("failed")), {
			action: "failed",
		});
		assert.deepEqual(
			{
				sessionId: session.id,
				...buildRelaySessionCreation(session, "pi"),
			},
			{ sessionId: pending.sessionId, createSession: true, agentHarness },
		);
	});
}

test("first relay creation uses the selected harness", () => {
	assert.deepEqual(buildRelaySessionCreation(null, "cursor"), {
		createSession: true,
		agentHarness: "cursor",
	});
});

test("a real relay Session omits the harness even when the picker differs", () => {
	assert.deepEqual(
		buildRelaySessionCreation({ agentHarness: "codex", meta: {} }, "cursor"),
		{ createSession: false },
	);
});

test("relay success removes creation fields from the next send", () => {
	const decision = decideRelayCommandReconcile(
		pending,
		command("succeeded", succeededBody("running", {
			session: { id: pending.sessionId, agentHarness: "codex", meta: {} },
		})),
	);
	assert.equal(decision.action, "succeeded");
	if (decision.action !== "succeeded") throw new Error("Expected relay success");
	assert.equal(decision.session.agentHarness, "codex");
	assert.deepEqual(
		buildRelaySessionCreation(
			decision.session as { agentHarness: "codex"; meta: Record<string, unknown> },
			"cursor",
		),
		{ createSession: false },
	);
});

test("succeeded with a running turn does not complete generation", () => {
	const decision = decideRelayCommandReconcile(
		pending,
		command("succeeded", succeededBody("running")),
	);
	assert.equal(decision.action, "succeeded");
	if (decision.action !== "succeeded") return;
	assert.equal(decision.completeGeneration, false);
	assert.equal(decision.turn.id, "turn-1");
});

test("succeeded with a terminal turn completes generation", () => {
	for (const status of [
		"completed",
		"failed",
		"interrupted",
		"merged",
		"cancelled",
	]) {
		const decision = decideRelayCommandReconcile(
			pending,
			command("succeeded", succeededBody(status)),
		);
		assert.equal(decision.action, "succeeded");
		if (decision.action !== "succeeded") continue;
		assert.equal(decision.completeGeneration, true, status);
	}
	assert.equal(isTerminalRelayTurnStatus("queued"), false);
});

test("cancelled and truncated succeeded results stay distinct", () => {
	assert.deepEqual(decideRelayCommandReconcile(pending, command("cancelled")), {
		action: "cancelled",
	});
	assert.deepEqual(
		decideRelayCommandReconcile(
			pending,
			command("succeeded", {
				status: 200,
				headers: {},
				body: JSON.stringify({ relayTruncated: true, originalBytes: 900_000 }),
			}),
		),
		{ action: "succeeded-truncated" },
	);
	assert.equal(
		decideRelayCommandReconcile(pending, command("queued")).action,
		"ignore-nonterminal",
	);
	assert.equal(
		decideRelayCommandReconcile(pending, command("failed")).action,
		"failed",
	);
});

test("mismatched session or invalid JSON is an invalid payload", () => {
	assert.equal(
		decideRelayCommandReconcile(
			pending,
			command("succeeded", {
				status: 200,
				headers: {},
				body: "{",
			}),
		).action,
		"invalid-payload",
	);
	assert.equal(
		decideRelayCommandReconcile(
			{ sessionId: "other" },
			command("succeeded", succeededBody("completed")),
		).action,
		"invalid-payload",
	);
});

test("turn events dedupe, ignore other spaces, and hydrate truncated payloads", () => {
	const seen = new Set<string>();
	const base = {
		id: "event-1",
		kind: "turn.completed" as const,
		spaceId: "space-1",
		sessionId: "session-1",
		turnId: "turn-1",
		completedAt: "2026-08-26T00:00:00.000Z",
		turn: {
			session: { id: "session-1" },
			turn: { id: "turn-1", status: "completed" },
		},
		truncated: false,
	};
	assert.deepEqual(decideRelayTurnEvent(base, { spaceId: "space-2", seenEventIds: seen }), {
		action: "ignore",
		reason: "space",
	});
	const first = decideRelayTurnEvent(base, { spaceId: "space-1", seenEventIds: seen });
	assert.equal(first.action, "apply-turn");
	if (first.action === "apply-turn") {
		assert.equal(first.turnId, "turn-1");
		assert.equal(first.turn.id, "turn-1");
	}
	assert.deepEqual(decideRelayTurnEvent(base, { spaceId: "space-1", seenEventIds: seen }), {
		action: "ignore",
		reason: "duplicate",
	});
	const truncated = decideRelayTurnEvent(
		{ ...base, id: "event-2", truncated: true, turn: null },
		{ spaceId: "space-1", seenEventIds: seen },
	);
	assert.deepEqual(truncated, {
		action: "hydrate-truncated",
		sessionId: "session-1",
		turnId: "turn-1",
	});
});

test("event id set evicts oldest entries after the cap", () => {
	const seen = new Set<string>();
	for (let i = 0; i < RELAY_TURN_EVENT_DEDUP_CAP; i += 1) {
		assert.equal(rememberRelayEventId(seen, `id-${i}`), true);
	}
	assert.equal(rememberRelayEventId(seen, "id-0"), false);
	assert.equal(rememberRelayEventId(seen, "id-new"), true);
	assert.equal(seen.size, RELAY_TURN_EVENT_DEDUP_CAP);
	assert.equal(seen.has("id-0"), false);
	assert.equal(seen.has("id-1"), true);
});

test("snapshot status merge and queued cancel targeting", () => {
	const merged = mergeRelayCommandStatuses({ a: "queued" }, [
		{ id: "a", status: "running" },
		{ id: "b", status: "queued" },
	]);
	assert.deepEqual(merged, { a: "running", b: "queued" });
	assert.deepEqual(
		queuedRelayCancelTargets(
			[
				{ commandId: "a" },
				{ commandId: "b" },
				{ commandId: "c" },
			],
			{ a: "running", b: "queued" },
		),
		[{ commandId: "b" }],
	);
	assert.equal(
		findOptimisticTurnForRelayCommand(
			[
				{ id: "opt-1", meta: { relayCommandId: "cmd-9" } },
				{ id: "opt-2", meta: { relayCommandId: "cmd-1" } },
			],
			{ commandId: "cmd-1", optimisticTurnId: "missing" },
		)?.id,
		"opt-2",
	);
});
