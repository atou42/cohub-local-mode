import assert from "node:assert/strict";
import test from "node:test";
import {
	assertRelayAttachmentFresh,
	assertRelayOwnerOrigin,
	browserTurnEvents,
	parseNodeMessage,
	parseActivityDisplayName,
	parseActivityOwnerUserId,
	parseActivityWatchPreferences,
	parseActivityWatchReplaceMessage,
	RELAY_PROTOCOL_VERSION,
	RelayProtocolError,
	validateRelayAttachmentCreateInput,
	validateRelayCommandInput,
} from "./protocol.ts";

const spaceId = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";
const sessionId = "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02";
const clientMessageId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const attachmentId = "669526bb-bf65-4013-a825-4f61adf199f8";
const cloudSpaceId = "d2e2ad0e-3d2b-443f-a583-2756604a08bb";
const ownerUserId = "dec89612d5074605aeeb101a2918379a";
const uuidOwnerUserId = "6042060d-5fbd-4a9e-94f0-80d321eda261";
const watchDigest = "a".repeat(64);

function validCommand() {
	return {
		idempotencyKey: clientMessageId,
		request: {
			method: "POST",
			path: `/api/spaces/${spaceId}/prompt`,
			headers: {
				authorization: "Bearer must-not-cross-relay",
			},
			body: JSON.stringify({
				sessionId,
				createSession: true,
				clientMessageId,
				content: [{ type: "text", text: "hello" }],
			}),
		},
	};
}

test("validates an idempotent Local Space prompt and strips caller headers", () => {
	const result = validateRelayCommandInput(validCommand(), {
		maxBodyBytes: 64 * 1024,
	});
	assert.equal(result.idempotencyKey, clientMessageId);
	assert.equal(result.request.path, `/api/spaces/${spaceId}/prompt`);
	assert.deepEqual(result.request.headers, {
		"content-type": "application/json",
		"x-cohub-source-via": "web",
		"x-cohub-relay-command-id": clientMessageId,
	});
	assert.equal("authorization" in result.request.headers, false);
	assert.deepEqual(result.attachmentIds, []);
});

test("validates attachment identity, limits, media type, and checksum", () => {
	assert.deepEqual(
		validateRelayAttachmentCreateInput(
			{
				name: "notes.txt",
				size: 12,
				contentType: "text/plain",
				sha256: "A".repeat(64),
			},
			{ maxBytes: 1024 },
		),
		{
			name: "notes.txt",
			size: 12,
			contentType: "text/plain",
			sha256: "a".repeat(64),
		},
	);
	for (const input of [
		{ name: "../secret", size: 12, contentType: "text/plain", sha256: "a".repeat(64) },
		{ name: "notes.txt", size: 0, contentType: "text/plain", sha256: "a".repeat(64) },
		{ name: "notes.txt", size: 12, contentType: "not a type", sha256: "a".repeat(64) },
		{ name: "notes.txt", size: 12, contentType: "text/plain", sha256: "bad" },
	]) {
		assert.throws(() => validateRelayAttachmentCreateInput(input, { maxBytes: 1024 }));
	}
	assert.throws(
		() =>
			validateRelayAttachmentCreateInput(
				{ name: "large.bin", size: 1025, contentType: "application/octet-stream", sha256: "b".repeat(64) },
				{ maxBytes: 1024 },
			),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "attachment_too_large" &&
			error.status === 413,
	);
});

test("rejects expired and malformed attachment tickets", () => {
	assert.doesNotThrow(() =>
		assertRelayAttachmentFresh("2026-08-25T00:00:01.000Z", Date.parse("2026-08-25T00:00:00.000Z")),
	);
	assert.throws(
		() =>
			assertRelayAttachmentFresh(
				"2026-08-25T00:00:00.000Z",
				Date.parse("2026-08-25T00:00:00.000Z"),
			),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "attachment_expired" &&
			error.status === 410,
	);
	assert.throws(
		() => assertRelayAttachmentFresh("not-a-date", 0),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "attachment_state_invalid" &&
			error.status === 500,
	);
});

test("accepts unique attachment UUIDs and rejects duplicate or malformed refs", () => {
	const input = validCommand();
	Object.assign(input, { attachmentIds: [attachmentId] });
	assert.deepEqual(
		validateRelayCommandInput(input, { maxBodyBytes: 64 * 1024 }).attachmentIds,
		[attachmentId],
	);
	Object.assign(input, { attachmentIds: [attachmentId, attachmentId] });
	assert.throws(
		() => validateRelayCommandInput(input, { maxBodyBytes: 64 * 1024 }),
		(error: unknown) =>
			error instanceof RelayProtocolError && error.code === "invalid_attachment_refs",
	);
});

test("rejects a command outside the prompt allowlist", () => {
	const input = validCommand();
	input.request.path = `/api/spaces/${spaceId}/fs/node`;
	assert.throws(
		() => validateRelayCommandInput(input, { maxBodyBytes: 64 * 1024 }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "path_not_allowed" &&
			error.status === 403,
	);
});

test("accepts a pre-authorized federated filesystem mutation", () => {
	const input = {
		kind: "federated_fs",
		idempotencyKey: clientMessageId,
		request: {
			method: "PUT",
			path: `/api/spaces/${spaceId}/fs/file`,
			headers: { authorization: "must-not-cross-relay" },
			body: JSON.stringify({
				path: "shared/result.txt",
				content: "written",
				encoding: "utf-8",
				mutationId: clientMessageId,
			}),
		},
	};
	const result = validateRelayCommandInput(input, { maxBodyBytes: 64 * 1024 });
	assert.equal(result.request.method, "PUT");
	assert.equal(result.request.path, `/api/spaces/${spaceId}/fs/file`);
	assert.deepEqual(result.request.headers, { "content-type": "application/json" });
	assert.equal("authorization" in result.request.headers, false);
	assert.deepEqual(result.attachmentIds, []);
});

test("rejects a federated mutation whose receipt identity differs", () => {
	assert.throws(
		() => validateRelayCommandInput({
			kind: "federated_fs",
			idempotencyKey: clientMessageId,
			request: {
				method: "DELETE",
				path: `/api/spaces/${spaceId}/fs/node?path=shared%2Fresult.txt&mutationId=${crypto.randomUUID()}`,
				headers: {},
				body: "",
			},
		}, { maxBodyBytes: 64 * 1024 }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "idempotency_mismatch",
	);
});

test("rejects a prompt whose client message identity differs", () => {
	const input = validCommand();
	input.request.body = JSON.stringify({
		sessionId,
		createSession: true,
		clientMessageId: crypto.randomUUID(),
		content: [{ type: "text", text: "hello" }],
	});
	assert.throws(
		() => validateRelayCommandInput(input, { maxBodyBytes: 64 * 1024 }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "idempotency_mismatch",
	);
});

test("requires an explicit relay session materialization decision", () => {
	const input = validCommand();
	input.request.body = JSON.stringify({
		sessionId,
		clientMessageId,
		content: [{ type: "text", text: "hello" }],
	});
	assert.throws(
		() => validateRelayCommandInput(input, { maxBodyBytes: 64 * 1024 }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.message.includes("createSession"),
	);
});

test("rejects command bodies beyond the configured limit", () => {
	const input = validCommand();
	assert.throws(
		() => validateRelayCommandInput(input, { maxBodyBytes: 8 }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "body_too_large" &&
			error.status === 413,
	);
});

test("parses claim, result, failure, and heartbeat node messages", () => {
	assert.deepEqual(
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "claim",
			commandId: "command-1",
		}),
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "claim",
			commandId: "command-1",
		},
	);
	const resultMessage = parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "result",
			commandId: "command-1",
			attempt: 2,
			result: {
				status: 202,
				headers: { "Content-Type": "application/json", ignored: 5 },
				body: "{}",
			},
		});
	assert.equal(resultMessage.type, "result");
	if (resultMessage.type !== "result") throw new Error("expected result message");
	assert.equal(resultMessage.result.headers["content-type"], "application/json");
	assert.equal(
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "failed",
			commandId: "command-1",
			attempt: 2,
			code: "local_api_unavailable",
			message: "connection refused",
		}).type,
		"failed",
	);
	assert.equal(
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "heartbeat",
			commandId: "command-1",
			attempt: 2,
		}).type,
		"heartbeat",
	);
});

test("parses a turn-event and rejects malformed ones", () => {
	const event = {
		id: clientMessageId,
		kind: "turn.completed",
		spaceId,
		sessionId,
		turnId: attachmentId,
		completedAt: "2026-08-26T00:00:00.000Z",
		turn: { status: "completed" },
		truncated: false,
	};
	assert.deepEqual(
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event,
		}),
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event,
		},
	);
	assert.deepEqual(
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, turn: null, truncated: true },
		}),
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, turn: null, truncated: true },
		},
	);
	for (const invalid of [
		{ protocolVersion: RELAY_PROTOCOL_VERSION, type: "turn-event" },
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, kind: "turn.failed" },
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, id: "not-a-uuid" },
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, completedAt: "soon" },
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, truncated: "yes" },
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...event, turn: "done" },
		},
	]) {
		assert.throws(
			() => parseNodeMessage(invalid),
			(error: unknown) =>
				error instanceof RelayProtocolError && error.code === "invalid_request",
		);
	}
});

test("accepts restricted authoritative lifecycle events", () => {
	const base = {
		id: clientMessageId,
		kind: "turn.lifecycle",
		nodeId: "mac-mini",
		origin: "local",
		spaceId,
		sessionId,
		turnId: attachmentId,
		observedAt: "2026-08-31T10:00:00.000Z",
		spaceName: null,
		sessionTitle: null,
	};
	for (const status of [
		"queued",
		"running",
		"abort_requested",
		"completed",
		"failed",
		"interrupted",
		"merged",
		"cancelled",
	]) {
		const parsed = parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...base, status },
		});
		assert.equal(parsed.type, "turn-event");
	}
	const named = parseNodeMessage({
		protocolVersion: RELAY_PROTOCOL_VERSION,
		type: "turn-event",
		event: {
			...base,
			status: "running",
			spaceName: " Local Mac ",
			sessionTitle: "Ship Agent Pulse",
		},
	});
	assert.equal(named.type, "turn-event");
	if (named.type !== "turn-event" || named.event.kind !== "turn.lifecycle") {
		throw new Error("expected lifecycle event");
	}
	assert.equal(named.event.spaceName, "Local Mac");
	assert.equal(named.event.sessionTitle, "Ship Agent Pulse");
	assert.equal(named.event.origin, "local");
	assert.throws(() =>
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...base, origin: "internet", status: "running" },
		}),
	);
	assert.equal(parseActivityDisplayName(undefined, "name", 1_020), null);
	assert.equal(
		parseActivityDisplayName("😀".repeat(255), "spaceName", 1_020),
		"😀".repeat(255),
	);
	assert.equal(
		parseActivityDisplayName("汉".repeat(255), "sessionTitle", 1_020),
		"汉".repeat(255),
	);
	for (const invalidName of [
		"",
		"bad\nname",
		"😀".repeat(256),
		"汉".repeat(256),
		"\ud800",
	]) {
		assert.throws(() => parseActivityDisplayName(invalidName, "name", 1_020));
	}
	assert.throws(() =>
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...base, status: "waiting" },
		}),
	);
	assert.throws(() =>
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			unexpected: true,
			event: { ...base, status: "running" },
		}),
	);
	assert.throws(() =>
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event",
			event: { ...base, status: "running", prompt: "do not accept" },
		}),
	);
});

test("rejects unknown node message fields instead of silently stripping them", () => {
	for (const invalid of [
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "heartbeat",
			unexpected: true,
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "heartbeat",
			commandId: "command-1",
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "claim",
			commandId: "command-1",
			unexpected: true,
		},
	]) {
		assert.throws(
			() => parseNodeMessage(invalid),
			(error: unknown) =>
				error instanceof RelayProtocolError && error.code === "invalid_request",
		);
	}
});

test("rejects stale protocol versions and invalid attempts", () => {
	assert.throws(
		() =>
			parseNodeMessage({
				protocolVersion: 1,
				type: "claim",
				commandId: "command-1",
			}),
		(error: unknown) =>
			error instanceof RelayProtocolError && error.code === "protocol_mismatch",
	);
	assert.throws(
		() =>
			parseNodeMessage({
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "started",
				commandId: "command-1",
				attempt: 0,
			}),
		(error: unknown) =>
			error instanceof RelayProtocolError && error.message.includes("attempt"),
	);
});

test("parses exact origin-qualified Activity watch preferences", () => {
	assert.deepEqual(
		parseActivityWatchPreferences({
			watchedSpaces: [
				{ spaceId, origin: "local" },
				{ spaceId: cloudSpaceId, origin: "cloud" },
			],
			focus: {
				spaceId: cloudSpaceId,
				origin: "cloud",
				sessionId,
				explicit: true,
			},
		}),
		{
			watchedSpaces: [
				{ spaceId, origin: "local" },
				{ spaceId: cloudSpaceId, origin: "cloud" },
			],
			focus: {
				spaceId: cloudSpaceId,
				origin: "cloud",
				sessionId,
				explicit: true,
			},
		},
	);
	assert.deepEqual(
		parseActivityWatchPreferences({ watchedSpaces: [], focus: null }),
		{ watchedSpaces: [], focus: null },
	);
});

test("rejects malformed or ambiguous Activity watch preferences", () => {
	const valid = {
		watchedSpaces: [{ spaceId, origin: "local" }],
		focus: { spaceId, origin: "local", sessionId: null, explicit: false },
	};
	for (const invalid of [
		{ ...valid, ignored: true },
		{ ...valid, watchedSpaces: [{ spaceId, origin: "edge" }] },
		{
			...valid,
			watchedSpaces: [
				{ spaceId, origin: "local" },
				{ spaceId, origin: "local" },
			],
		},
		{
			...valid,
			watchedSpaces: [
				{ spaceId, origin: "local" },
				{ spaceId: cloudSpaceId, origin: "cloud" },
				{ spaceId: sessionId, origin: "local" },
				{ spaceId: attachmentId, origin: "cloud" },
			],
		},
		{ ...valid, watchedSpaces: [{ spaceId: "bad", origin: "local" }] },
		{ ...valid, watchedSpaces: [{ spaceId, origin: "local", name: "Local" }] },
		{ ...valid, focus: { ...valid.focus, sessionId: "bad" } },
		{ ...valid, focus: { ...valid.focus, origin: "remote" } },
		{ ...valid, focus: { ...valid.focus, name: "Do not trust me" } },
	]) {
		assert.throws(
			() => parseActivityWatchPreferences(invalid),
			(error: unknown) =>
				error instanceof RelayProtocolError &&
				error.code === "invalid_activity_watch",
		);
	}
});

test("parses a strict Relay-to-Node Activity watch union replacement", () => {
	const message = {
		protocolVersion: RELAY_PROTOCOL_VERSION,
		type: "activity-watch.replace",
		revision: 7,
		digest: watchDigest,
		ownerUserId,
		expiresAt: "2026-09-01T12:00:00.000Z",
		leaseExpiresAt: "2026-09-01T11:05:00.000Z",
		watchedSpaces: [
			{ spaceId, origin: "local" },
			{ spaceId: cloudSpaceId, origin: "cloud" },
		],
		focus: {
			spaceId: attachmentId,
			origin: "cloud",
			sessionId,
			explicit: true,
		},
	};
	assert.deepEqual(parseActivityWatchReplaceMessage(message), message);
	assert.equal(
		parseActivityOwnerUserId(ownerUserId.toUpperCase()),
		ownerUserId,
	);
	assert.equal(
		parseActivityWatchReplaceMessage({
			...message,
			ownerUserId: uuidOwnerUserId.toUpperCase(),
		}).ownerUserId,
		uuidOwnerUserId,
	);
	for (const focus of [
		{ spaceId: attachmentId, origin: "cloud", sessionId: null, explicit: true },
		{ spaceId: attachmentId, origin: "cloud", sessionId: null, explicit: false },
	]) {
		assert.deepEqual(parseActivityWatchReplaceMessage({ ...message, focus }).focus, focus);
	}
});

test("rejects unsafe Activity watch replacement snapshots", () => {
	const valid = {
		protocolVersion: RELAY_PROTOCOL_VERSION,
		type: "activity-watch.replace",
		revision: 1,
		digest: watchDigest,
		ownerUserId,
		expiresAt: "2026-09-01T12:00:00.000Z",
		leaseExpiresAt: "2026-09-01T11:05:00.000Z",
		watchedSpaces: [{ spaceId, origin: "local" }],
		focus: null,
	};
	for (const invalid of [
		{ ...valid, protocolVersion: 1 },
		{ ...valid, extra: true },
		{ ...valid, revision: 0 },
		{ ...valid, revision: 1.5 },
		{ ...valid, digest: "bad" },
		{ ...valid, ownerUserId: "bad" },
		{ ...valid, ownerUserId: "g".repeat(32) },
		{ ...valid, ownerUserId: "a".repeat(31) },
		{ ...valid, ownerUserId: `${"a".repeat(31)}-` },
		{ ...valid, expiresAt: "later" },
		{
			...valid,
			expiresAt: "2026-09-01T11:00:00.000Z",
			leaseExpiresAt: "2026-09-01T11:05:00.000Z",
		},
		{ ...valid, watchedSpaces: [{ spaceId, origin: "internet" }] },
		{
			...valid,
			watchedSpaces: [
				{ spaceId, origin: "local" },
				{ spaceId: cloudSpaceId, origin: "cloud" },
				{ spaceId: sessionId, origin: "local" },
				{ spaceId: attachmentId, origin: "cloud" },
			],
		},
		{
			...valid,
			watchedSpaces: [
				{ spaceId, origin: "local" },
				{ spaceId, origin: "local" },
			],
		},
		{ ...valid, focus: { spaceId, origin: "local", sessionId: "bad", explicit: true } },
		{ ...valid, focus: { spaceId, origin: "edge", sessionId: null, explicit: false } },
		{
			...valid,
			focus: {
				spaceId,
				origin: "local",
				sessionId,
				explicit: true,
				title: "Untrusted",
			},
		},
	]) {
		assert.throws(() => parseActivityWatchReplaceMessage(invalid));
	}
	assert.throws(
		() => parseActivityWatchReplaceMessage({ ...valid, protocolVersion: 1 }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "protocol_mismatch",
	);
});

test("parses an exact Activity watch acknowledgement from Node", () => {
	assert.deepEqual(
		parseNodeMessage({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "activity-watch.ack",
			revision: 8,
			digest: watchDigest.toUpperCase(),
		}),
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "activity-watch.ack",
			revision: 8,
			digest: watchDigest,
		},
	);
	for (const invalid of [
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "activity-watch.ack",
			revision: 0,
			digest: watchDigest,
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "activity-watch.ack",
			revision: 1,
			digest: "bad",
		},
		{
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "activity-watch.ack",
			revision: 1,
			digest: watchDigest,
			extra: true,
		},
	]) {
		assert.throws(
			() => parseNodeMessage(invalid),
			(error: unknown) =>
				error instanceof RelayProtocolError &&
				error.code === "invalid_activity_watch",
		);
	}
});

test("owner mutation routes reject missing and unapproved origins", () => {
	for (const origin of [null, "https://attacker.example"]) {
		assert.throws(
			() =>
				assertRelayOwnerOrigin({
					method: "PUT",
					suffix: `/activity/devices/${clientMessageId}`,
					origin,
					allowedOrigin: "https://cohub.atou.cc",
				}),
			(error: unknown) =>
				error instanceof RelayProtocolError &&
				error.code === "origin_not_allowed" &&
				error.status === 403,
		);
	}
	assert.doesNotThrow(() =>
		assertRelayOwnerOrigin({
			method: "PUT",
			suffix: `/activity/devices/${clientMessageId}`,
			origin: "https://cohub.atou.cc",
			allowedOrigin: "https://cohub.atou.cc",
		}),
	);
});

test("lifecycle events remain internal and never enter browser turn events", () => {
	const completed = {
		id: clientMessageId,
		kind: "turn.completed" as const,
		spaceId,
		sessionId,
		turnId: attachmentId,
		completedAt: "2026-08-31T10:00:00.000Z",
		turn: { status: "completed" },
		truncated: false,
	};
	const lifecycle = {
		id: attachmentId,
		kind: "turn.lifecycle" as const,
		nodeId: "mac-mini",
		origin: "local" as const,
		spaceId,
		sessionId,
		turnId: attachmentId,
		status: "running" as const,
		observedAt: "2026-08-31T09:59:00.000Z",
		spaceName: null,
		sessionTitle: null,
	};
	assert.deepEqual(browserTurnEvents([lifecycle, completed]), [completed]);
});
