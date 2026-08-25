import assert from "node:assert/strict";
import test from "node:test";
import {
	assertRelayAttachmentFresh,
	parseNodeMessage,
	RELAY_PROTOCOL_VERSION,
	RelayProtocolError,
	validateRelayAttachmentCreateInput,
	validateRelayCommandInput,
} from "./protocol.ts";

const spaceId = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";
const sessionId = "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02";
const clientMessageId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const attachmentId = "669526bb-bf65-4013-a825-4f61adf199f8";

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

test("rejects stale protocol versions and invalid attempts", () => {
	assert.throws(
		() =>
			parseNodeMessage({
				protocolVersion: 2,
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
