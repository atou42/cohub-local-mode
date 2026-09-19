import assert from "node:assert/strict";
import test from "node:test";
import { authorizeFederatedFileRequest } from "./federated-api.ts";
import { RelayProtocolError } from "./protocol.ts";

const sourceSpaceId = "11111111-1111-4111-8111-111111111111";
const targetSpaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const toolCallId = "55555555-5555-4555-8555-555555555555";
const actorUserId = "66666666666646668666666666666666";

function request(path = `/api/spaces/${targetSpaceId}/fs/file`) {
	return new Request(`https://relay-node.example${path}`, {
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
	});
}

function deleteRequest() {
	return new Request(
		`https://relay-node.example/api/spaces/${targetSpaceId}/fs/node?path=shared%2Fresult.txt&recursive=false`,
		{
			method: "DELETE",
			headers: {
				authorization: "Bearer cloud-execution-token",
				"x-cohub-source-space": sourceSpaceId,
				"x-cohub-source-session": sessionId,
				"x-cohub-source-turn": turnId,
				"x-cohub-source-tool-call": toolCallId,
			},
		},
	);
}

function turnPayload(origin: "local" | "cloud" = "local") {
	return {
		session: { id: sessionId, spaceId: sourceSpaceId },
		turn: {
			id: turnId,
			status: "running",
			userUuid: actorUserId,
			userContent: [{
				type: "text",
				text: "@local write it",
				_meta: {
					mentions: [{ type: "space", spaceId: targetSpaceId, origin }],
				},
			}],
		},
	};
}

function dependencies(payload = turnPayload()) {
	const requests: Request[] = [];
	return {
		requests,
		deps: {
			cloudApiOrigin: "https://api.cohub.example",
			ownerUserId: actorUserId,
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const next = new Request(input, init);
				requests.push(next);
				if (next.url.endsWith("/api/me")) {
					return Response.json({ uuid: actorUserId });
				}
				return Response.json(payload);
			},
		},
	};
}

test("authorizes an explicitly mentioned Local Space mutation and binds idempotency", async () => {
	const { requests, deps } = dependencies();
	const first = await authorizeFederatedFileRequest(request(), deps);
	const second = await authorizeFederatedFileRequest(request(), deps);

	assert.equal(first.actorUserId, actorUserId);
	assert.equal(first.targetSpaceId, targetSpaceId);
	assert.equal(first.request.method, "PUT");
	assert.equal(first.request.path, `/api/spaces/${targetSpaceId}/fs/file`);
	assert.match(first.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(second.idempotencyKey, first.idempotencyKey);
	assert.deepEqual(JSON.parse(first.request.body), {
		path: "shared/result.txt",
		content: "written",
		encoding: "utf-8",
		mutationId: first.idempotencyKey,
	});
	assert.equal(requests.length, 4);
	assert.equal(requests[0]?.headers.get("authorization"), "Bearer cloud-execution-token");
});

test("invokes the Cloud fetch binding with the Worker global receiver", async () => {
	const { deps } = dependencies();
	const strictFetch = async function(
		this: unknown,
		input: RequestInfo | URL,
		init?: RequestInit,
	) {
		assert.equal(this, globalThis);
		return deps.fetch(input, init);
	};

	const authorized = await authorizeFederatedFileRequest(request(), {
		...deps,
		fetch: strictFetch as typeof fetch,
	});
	assert.equal(authorized.targetSpaceId, targetSpaceId);
});

test("rejects a target that is not explicitly mentioned as Local", async () => {
	const { deps } = dependencies(turnPayload("cloud"));
	await assert.rejects(
		authorizeFederatedFileRequest(request(), deps),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "local_space_not_mentioned" &&
			error.status === 403,
	);
});

test("binds a delete query to the same deterministic mutation receipt", async () => {
	const { deps } = dependencies();
	const authorized = await authorizeFederatedFileRequest(deleteRequest(), deps);
	const url = new URL(authorized.request.path, "https://relay.internal");
	assert.equal(authorized.request.method, "DELETE");
	assert.equal(url.searchParams.get("path"), "shared/result.txt");
	assert.equal(url.searchParams.get("recursive"), "false");
	assert.equal(url.searchParams.get("mutationId"), authorized.idempotencyKey);
});

test("rejects a Cloud actor that does not own the Local node", async () => {
	const { deps } = dependencies();
	await assert.rejects(
		authorizeFederatedFileRequest(request(), { ...deps, ownerUserId: "different-user" }),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "federated_actor_mismatch" &&
			error.status === 403,
	);
});

test("rejects arbitrary Local API routes", async () => {
	const { deps } = dependencies();
	await assert.rejects(
		authorizeFederatedFileRequest(
			request(`/api/spaces/${targetSpaceId}/members`),
			deps,
		),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "path_not_allowed" &&
			error.status === 403,
	);
});
