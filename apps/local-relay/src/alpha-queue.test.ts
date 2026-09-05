import assert from "node:assert/strict";
import test from "node:test";
import { createAlphaQueueHandler } from "./alpha-queue.ts";
import { RELAY_NODE_IDENTITY_HEADER } from "./node-identity.ts";
import { RELAY_PROTOCOL_VERSION } from "./protocol.ts";

function queueMessage(body: unknown) {
	let acknowledgements = 0;
	let retries = 0;
	return {
		message: {
			body,
			ack() {
				acknowledgements += 1;
			},
			retry() {
				retries += 1;
			},
		},
		result: () => ({ acknowledgements, retries }),
	};
}

test("alpha wakeups route to the exact per-device Durable Object", async () => {
	const nodeId = "a".repeat(64);
	const item = queueMessage({
		protocolVersion: RELAY_PROTOCOL_VERSION,
		nodeId,
		commandId: "command-1",
	});
	const requests: Request[] = [];
	await createAlphaQueueHandler()(
		{ messages: [item.message] } as never,
		{
			NODES: {
				getByName(name: string) {
					assert.equal(name, nodeId);
					return {
						async fetch(request: Request) {
							requests.push(request);
							return Response.json({ ok: true });
						},
					};
				},
			},
		} as never,
	);
	assert.deepEqual(item.result(), { acknowledgements: 1, retries: 0 });
	const request = requests[0];
	assert.ok(request);
	assert.equal(new URL(request.url).pathname, "/internal/wake");
	assert.equal(request.headers.get(RELAY_NODE_IDENTITY_HEADER), nodeId);
});

test("alpha wakeups retry transient node failures and reject malformed identities", async () => {
	const failed = queueMessage({
		protocolVersion: RELAY_PROTOCOL_VERSION,
		nodeId: "b".repeat(64),
		commandId: "command-2",
	});
	const malformed = queueMessage({
		protocolVersion: RELAY_PROTOCOL_VERSION,
		nodeId: "mac-mini",
		commandId: "command-3",
	});
	const originalError = console.error;
	console.error = () => undefined;
	try {
		await createAlphaQueueHandler()(
			{ messages: [failed.message, malformed.message] } as never,
			{
				NODES: {
					getByName() {
						return {
							async fetch() {
								return Response.json({ message: "unavailable" }, { status: 503 });
							},
						};
					},
				},
			} as never,
		);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(failed.result(), { acknowledgements: 0, retries: 1 });
	assert.deepEqual(malformed.result(), { acknowledgements: 1, retries: 0 });
});
