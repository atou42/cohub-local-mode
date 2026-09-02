import assert from "node:assert/strict";
import test from "node:test";
import { handleFederatedApi } from "./federated-handler.ts";

const sourceSpaceId = "11111111-1111-4111-8111-111111111111";
const targetSpaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const toolCallId = "55555555-5555-4555-8555-555555555555";
const actorUserId = "66666666666646668666666666666666";

function request() {
	return new Request(
		`https://relay-node.example/api/spaces/${targetSpaceId}/fs/file`,
		{
			method: "PUT",
			headers: {
				authorization: "Bearer cloud-execution-token",
				"content-type": "application/json",
				"x-cohub-source-space": sourceSpaceId,
				"x-cohub-source-session": sessionId,
				"x-cohub-source-turn": turnId,
				"x-cohub-source-tool-call": toolCallId,
			},
			body: JSON.stringify({
				path: "shared/result.txt",
				content: "written",
				encoding: "utf-8",
			}),
		},
	);
}

function cloudFetch(input: RequestInfo | URL) {
	const url = String(input);
	if (url.endsWith("/api/me")) return Promise.resolve(Response.json({ uuid: actorUserId }));
	return Promise.resolve(Response.json({
		session: { id: sessionId, spaceId: sourceSpaceId },
		turn: {
			id: turnId,
			status: "running",
			userUuid: actorUserId,
			userContent: [{
				type: "text",
				text: "@local write it",
				_meta: {
					mentions: [{
						type: "space",
						spaceId: targetSpaceId,
						origin: "local",
					}],
				},
			}],
		},
	}));
}

function input(stub: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }) {
	return {
		request: request(),
		stub,
		cloudApiOrigin: "https://api.cohub.example",
		ownerUserId: actorUserId,
		maxBodyBytes: 64 * 1024,
	};
}

test("returns the Local filesystem response after the relay command completes", async () => {
	const acceptedBodies: Record<string, unknown>[] = [];
	const stub = {
		async fetch(raw: RequestInfo | URL, init?: RequestInit) {
			const url = String(raw);
			if (url.endsWith("/internal/status")) {
				return Response.json({ connected: true });
			}
			if (url.endsWith("/internal/commands") && init?.method === "POST") {
				acceptedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return Response.json({ command: { id: "command-1" }, deduplicated: false }, { status: 202 });
			}
			return Response.json({
				command: {
					id: "command-1",
					status: "succeeded",
					result: {
						status: 200,
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ path: "shared/result.txt", size: 7 }),
					},
				},
			});
		},
	};
	const response = await handleFederatedApi(input(stub), { fetch: cloudFetch });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { path: "shared/result.txt", size: 7 });
	assert.equal(acceptedBodies[0]?.kind, "federated_fs");
	assert.equal(
		(acceptedBodies[0]?.request as Record<string, unknown>)?.method,
		"PUT",
	);
});

test("returns an explicit offline error without enqueuing a mutation", async () => {
	let commandCalls = 0;
	const stub = {
		async fetch(raw: RequestInfo | URL) {
			if (String(raw).endsWith("/internal/status")) {
				return Response.json({ connected: false });
			}
			commandCalls += 1;
			return Response.json({});
		},
	};
	const response = await handleFederatedApi(input(stub), { fetch: cloudFetch });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		code: "local_node_offline",
		message: "The Local node is offline",
	});
	assert.equal(commandCalls, 0);
});

test("preserves a Local permission denial instead of relabeling it as a relay failure", async () => {
	const stub = {
		async fetch(raw: RequestInfo | URL, init?: RequestInit) {
			const url = String(raw);
			if (url.endsWith("/internal/status")) return Response.json({ connected: true });
			if (url.endsWith("/internal/commands") && init?.method === "POST") {
				return Response.json({ command: { id: "command-1" }, deduplicated: false }, { status: 202 });
			}
			return Response.json({
				command: {
					id: "command-1",
					status: "succeeded",
					result: {
						status: 403,
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ message: "forbidden" }),
					},
				},
			});
		},
	};
	const response = await handleFederatedApi(input(stub), { fetch: cloudFetch });
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { message: "forbidden" });
});
