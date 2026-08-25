import assert from "node:assert/strict";
import { test } from "node:test";
import {
	connectLocalRelayEvents,
	nextRelayEventReconnectDelay,
	parseLocalRelayBrowserMessage,
	RELAY_BROWSER_PROTOCOL_VERSION,
	RELAY_EVENTS_RECONNECT_MAX_MS,
	RELAY_EVENTS_RECONNECT_MIN_MS,
	resolveLocalRelayEventsUrl,
} from "../lib/local-relay-events";

const runningTurn = {
	id: "11111111-1111-4111-8111-111111111111",
	sessionId: "22222222-2222-4222-8222-222222222222",
	status: "running",
};

function command(status = "queued") {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		status,
		errorCode: null,
		errorMessage: null,
		result: null,
	};
}

function turnEvent(overrides: Record<string, unknown> = {}) {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		kind: "turn.completed",
		spaceId: "55555555-5555-4555-8555-555555555555",
		sessionId: "22222222-2222-4222-8222-222222222222",
		turnId: runningTurn.id,
		completedAt: "2026-08-26T00:00:00.000Z",
		turn: { session: { id: runningTurn.sessionId }, turn: runningTurn },
		truncated: false,
		...overrides,
	};
}

test("parses snapshot, command.updated, and turn.event", () => {
	const snapshot = parseLocalRelayBrowserMessage({
		protocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
		type: "snapshot",
		commands: [command("succeeded")],
		events: [turnEvent()],
	});
	assert.equal(snapshot.ok, true);
	if (!snapshot.ok) return;
	assert.equal(snapshot.message.type, "snapshot");
	if (snapshot.message.type !== "snapshot") return;
	assert.equal(snapshot.message.commands[0]?.status, "succeeded");
	assert.equal(snapshot.message.events[0]?.kind, "turn.completed");

	const updated = parseLocalRelayBrowserMessage(
		JSON.stringify({
			protocolVersion: 2,
			type: "command.updated",
			command: command("running"),
		}),
	);
	assert.equal(updated.ok, true);
	if (!updated.ok) return;
	assert.equal(updated.message.type, "command.updated");

	const event = parseLocalRelayBrowserMessage({
		protocolVersion: 2,
		type: "turn.event",
		event: turnEvent({ truncated: true, turn: null }),
	});
	assert.equal(event.ok, true);
	if (!event.ok) return;
	assert.equal(event.message.type, "turn.event");
	if (event.message.type !== "turn.event") return;
	assert.equal(event.message.event.truncated, true);
	assert.equal(event.message.event.turn, null);
});

test("ignores unknown types and warns on missing fields", () => {
	assert.deepEqual(
		parseLocalRelayBrowserMessage({
			protocolVersion: 2,
			type: "node-heartbeat",
		}),
		{ ok: false, reason: "unknown-type" },
	);
	const missing = parseLocalRelayBrowserMessage({
		protocolVersion: 2,
		type: "command.updated",
	});
	assert.equal(missing.ok, false);
	if (missing.ok) return;
	assert.equal(missing.reason, "invalid-fields");
	assert.match(missing.warning ?? "", /command.updated/);

	const mismatch = parseLocalRelayBrowserMessage({
		protocolVersion: 1,
		type: "snapshot",
		commands: [],
		events: [],
	});
	assert.equal(mismatch.ok, false);
	if (mismatch.ok) return;
	assert.equal(mismatch.reason, "protocol-mismatch");
});

test("snapshot drops invalid entries and keeps valid ones", () => {
	const parsed = parseLocalRelayBrowserMessage({
		protocolVersion: 2,
		type: "snapshot",
		commands: [command(), { id: "bad" }, "nope"],
		events: [turnEvent(), { kind: "turn.completed" }],
	});
	assert.equal(parsed.ok, true);
	if (!parsed.ok || parsed.message.type !== "snapshot") return;
	assert.equal(parsed.message.commands.length, 1);
	assert.equal(parsed.message.events.length, 1);
});

test("resolves same-origin wss URL and reconnect delay stays in range", () => {
	assert.equal(
		resolveLocalRelayEventsUrl("/relay/v1/nodes/mac-mini/events", {
			protocol: "https:",
			host: "cohub.example",
		}),
		"wss://cohub.example/relay/v1/nodes/mac-mini/events",
	);
	assert.equal(
		resolveLocalRelayEventsUrl("/relay/v1/nodes/mac-mini/events", {
			protocol: "http:",
			host: "localhost:5173",
		}),
		"ws://localhost:5173/relay/v1/nodes/mac-mini/events",
	);
	const delay = nextRelayEventReconnectDelay(0, () => 0);
	assert.ok(delay >= RELAY_EVENTS_RECONNECT_MIN_MS * 0.5);
	assert.ok(delay <= RELAY_EVENTS_RECONNECT_MIN_MS);
	assert.equal(nextRelayEventReconnectDelay(20, () => 1), RELAY_EVENTS_RECONNECT_MAX_MS);
});

test("event socket dispatches snapshot and reconnects after close", async () => {
	const sockets: FakeSocket[] = [];
	const timers: Array<() => void> = [];
	class FakeSocket {
		url: string;
		onopen: ((event: unknown) => void) | null = null;
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onerror: ((event: unknown) => void) | null = null;
		onclose: ((event: unknown) => void) | null = null;
		closed = false;
		constructor(url: string) {
			this.url = url;
			sockets.push(this);
		}
		close() {
			this.closed = true;
		}
	}
	const snapshots: unknown[] = [];
	let available = 0;
	let unavailable = 0;
	const connection = connectLocalRelayEvents({
		url: "wss://example/events",
		WebSocket: FakeSocket as unknown as new (url: string) => FakeSocket,
		random: () => 0,
		setTimeout: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeout: () => undefined,
		handlers: {
			onSnapshot: (message) => snapshots.push(message),
			onAvailable: () => {
				available += 1;
			},
			onUnavailable: () => {
				unavailable += 1;
			},
		},
	});
	assert.equal(sockets.length, 1);
	sockets[0]?.onmessage?.({
		data: JSON.stringify({
			protocolVersion: 2,
			type: "snapshot",
			commands: [],
			events: [],
		}),
	});
	assert.equal(snapshots.length, 1);
	assert.equal(available, 1);
	sockets[0]?.onclose?.({});
	assert.equal(unavailable, 0);
	assert.equal(timers.length, 1);
	timers[0]?.();
	assert.equal(sockets.length, 2);
	sockets[1]?.onclose?.({});
	assert.equal(unavailable, 1);
	const scheduledAfterSecondClose = timers.length;
	connection.close();
	for (const flush of timers.slice()) flush();
	assert.equal(sockets.length, 2);
	assert.equal(timers.length, scheduledAfterSecondClose);
});
