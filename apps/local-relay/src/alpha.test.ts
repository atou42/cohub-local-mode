import assert from "node:assert/strict";
import test from "node:test";
import { alphaNodeId, sha256Hex } from "./alpha-auth.ts";
import { createAlphaHandler } from "./alpha-handler.ts";
import { RELAY_NODE_IDENTITY_HEADER } from "./node-identity.ts";
import { RelayProtocolError } from "./protocol.ts";

const identity = {
	accountId: "a".repeat(64),
	subject: "logto-subject",
	userUuid: "user-uuid",
	clientId: "alpha-client",
};

function environment(
	accountFetch: (request: Request) => Promise<Response>,
	nodeFetch: (request: Request) => Promise<Response> = async () => new Response(),
) {
	return {
		ALLOWED_ORIGIN: "https://dev-cohub.atou.cc",
		LOGTO_ENDPOINT: "https://auth.neta.art",
		LOGTO_API_RESOURCE: "https://api.talesofai",
		LOGTO_APP_ID: "alpha-client",
		ACCOUNTS: {
			getByName(name: string) {
				assert.equal(name, identity.accountId);
				return { fetch: accountFetch };
			},
		},
		NODES: {
			getByName() {
				return { fetch: nodeFetch };
			},
		},
	} as never;
}

test("alpha health is public and identifies the isolated service", async () => {
	let authorizeCalls = 0;
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			authorizeCalls += 1;
			return identity;
		},
	});
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/healthz"),
		environment(async () => new Response()),
	);
	assert.equal(response.status, 200);
	assert.equal(authorizeCalls, 0);
	assert.deepEqual(await response.json(), {
		status: "ready",
		service: "cohub-personal-node-alpha",
		schemaVersion: 1,
	});
});

test("device authorization is proxied without forwarding the browser origin", async () => {
	const upstreamRequests: Request[] = [];
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			throw new Error("device authorization must not require an existing session");
		},
		fetchExternal: async (request) => {
			upstreamRequests.push(request);
			return Response.json({
				device_code: "device-code-secret",
				user_code: "ABCD-EFGH",
				verification_uri: "https://auth.neta.art/device",
				verification_uri_complete:
					"https://auth.neta.art/device?user_code=ABCD-EFGH",
				expires_in: 600,
				interval: 5,
			});
		},
	});
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/auth/device", {
			method: "POST",
			headers: { origin: "https://dev-cohub.atou.cc" },
		}),
		environment(async () => new Response()),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		deviceCode: "device-code-secret",
		userCode: "ABCD-EFGH",
		verificationUri: "https://auth.neta.art/device",
		verificationUriComplete:
			"https://auth.neta.art/device?user_code=ABCD-EFGH",
		expiresInSeconds: 600,
		intervalSeconds: 5,
	});
	const upstream = upstreamRequests[0];
	assert.ok(upstream);
	assert.equal(upstream.headers.get("origin"), null);
	assert.equal(new URL(upstream.url).pathname, "/oidc/device/auth");
	assert.match(await upstream.text(), /client_id=alpha-client/);
});

test("device token polling exposes pending and successful states without an authenticated route", async () => {
	let attempt = 0;
	const upstreamRequests: Request[] = [];
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			throw new Error("device token polling must not require an existing session");
		},
		fetchExternal: async (request) => {
			upstreamRequests.push(request);
			attempt += 1;
			if (attempt === 1) {
				return Response.json(
					{ error: "authorization_pending", error_description: "Pending" },
					{ status: 400 },
				);
			}
			return Response.json({
				access_token: "access-token",
				refresh_token: "refresh-token",
				id_token: "id-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "openid profile email offline_access",
			});
		},
	});
	const request = () =>
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/auth/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://dev-cohub.atou.cc",
			},
			body: JSON.stringify({ deviceCode: "device-code-secret" }),
		});
	const pending = await handler.fetch(
		request(),
		environment(async () => new Response()),
	);
	assert.equal(pending.status, 202);
	assert.deepEqual(await pending.json(), { status: "pending" });

	const complete = await handler.fetch(
		request(),
		environment(async () => new Response()),
	);
	assert.equal(complete.status, 200);
	assert.deepEqual(await complete.json(), {
		status: "complete",
		accessToken: "access-token",
		refreshToken: "refresh-token",
		idToken: "id-token",
		tokenType: "Bearer",
		expiresInSeconds: 3600,
		scope: "openid profile email offline_access",
	});
	const upstreamBody = await upstreamRequests[1]?.text();
	assert.match(upstreamBody ?? "", /resource=https%3A%2F%2Fapi.talesofai/);
});

test("refresh token exchange is proxied without exposing provider errors", async () => {
	const upstreamRequests: Request[] = [];
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			throw new Error("refresh must not require a non-expired access token");
		},
		fetchExternal: async (request) => {
			upstreamRequests.push(request);
			return Response.json({
				access_token: "next-access-token",
				refresh_token: "next-refresh-token",
				id_token: "next-id-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "openid profile email offline_access",
			});
		},
	});
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/auth/refresh", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://dev-cohub.atou.cc",
			},
			body: JSON.stringify({ refreshToken: "refresh-token" }),
		}),
		environment(async () => new Response()),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "complete",
		accessToken: "next-access-token",
		refreshToken: "next-refresh-token",
		idToken: "next-id-token",
		tokenType: "Bearer",
		expiresInSeconds: 3600,
		scope: "openid profile email offline_access",
	});
	const upstream = upstreamRequests[0];
	assert.ok(upstream);
	assert.equal(upstream.headers.get("origin"), null);
	const upstreamBody = await upstream.text();
	assert.match(upstreamBody, /grant_type=refresh_token/);
	assert.match(upstreamBody, /refresh_token=refresh-token/);
});

test("account discovery returns the authenticated opaque account ID", async () => {
	const handler = createAlphaHandler({ authorizeUser: async () => identity });
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/account", {
			headers: { origin: "https://dev-cohub.atou.cc" },
		}),
		environment(async () => new Response()),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		accountId: identity.accountId,
		userUuid: identity.userUuid,
	});
});

test("a registered device credential opens only its per-device node channel", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	const token = "device-secret";
	const expectedNodeId = await alphaNodeId({
		accountId: identity.accountId,
		deviceId,
	});
	const accountRequests: Request[] = [];
	const nodeRequests: Request[] = [];
	let routedNodeId: string | null = null;
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			throw new Error("node connections must not use a browser token");
		},
	});
	const env = environment(
		async (request) => {
			accountRequests.push(request);
			return Response.json({ ok: true });
		},
		async (request) => {
			nodeRequests.push(request);
			return Response.json({ connected: true });
		},
	) as {
		NODES: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
	};
	const originalGetByName = env.NODES.getByName;
	env.NODES.getByName = (name: string) => {
		routedNodeId = name;
		return originalGetByName(name);
	};
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${identity.accountId}/${deviceId}/connect`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					upgrade: "websocket",
				},
			},
		),
		env as never,
	);
	assert.equal(response.status, 200);
	assert.equal(routedNodeId, expectedNodeId);
	const accountRequest = accountRequests[0];
	assert.ok(accountRequest);
	assert.equal(accountRequest.headers.get("authorization"), null);
	assert.equal(accountRequest.headers.get("x-cohub-alpha-device-auth"), "1");
	assert.deepEqual(await accountRequest.json(), {
		credentialHash: await sha256Hex(token),
	});
	const nodeRequest = nodeRequests[0];
	assert.ok(nodeRequest);
	assert.equal(nodeRequest.headers.get("authorization"), null);
	assert.equal(nodeRequest.headers.get(RELAY_NODE_IDENTITY_HEADER), expectedNodeId);
	assert.equal(new URL(nodeRequest.url).pathname, "/internal/node");
});

test("a registered Connector reports local runtime health without a browser token", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	const token = "device-secret";
	const accountRequests: Request[] = [];
	const nodeRequests: Request[] = [];
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			throw new Error("Connector health must not require a browser token");
		},
	});
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${identity.accountId}/${deviceId}/status`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					state: "recovering",
					message: "postgres stopped unexpectedly",
					attempt: 2,
					maxAttempts: 5,
					appVersion: "0.2.0-alpha.1",
				}),
			},
		),
		environment(
			async (request) => {
				accountRequests.push(request);
				return Response.json({ ok: true });
			},
			async (request) => {
				nodeRequests.push(request);
				return Response.json({ ok: true });
			},
		),
	);
	assert.equal(response.status, 200);
	assert.equal(accountRequests.length, 1);
	const accountRequest = accountRequests[0];
	assert.ok(accountRequest);
	assert.deepEqual(await accountRequest.json(), {
		credentialHash: await sha256Hex(token),
	});
	assert.equal(nodeRequests.length, 1);
	const nodeRequest = nodeRequests[0];
	assert.ok(nodeRequest);
	assert.equal(new URL(nodeRequest.url).pathname, "/internal/connector-status");
	assert.equal(nodeRequest.headers.get("authorization"), null);
	assert.deepEqual(await nodeRequest.json(), {
		state: "recovering",
		message: "postgres stopped unexpectedly",
		attempt: 2,
		maxAttempts: 5,
		appVersion: "0.2.0-alpha.1",
	});
});

test("Connector health reports reject oversized bodies before node storage", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	let nodeCalls = 0;
	const handler = createAlphaHandler();
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${identity.accountId}/${deviceId}/status`,
			{
				method: "POST",
				headers: {
					authorization: "Bearer device-secret",
					"content-type": "application/json",
				},
				body: "x".repeat(4_097),
			},
		),
		environment(
			async () => Response.json({ ok: true }),
			async () => {
				nodeCalls += 1;
				return new Response();
			},
		),
	);
	assert.equal(response.status, 413);
	assert.equal(nodeCalls, 0);
	assert.deepEqual(await response.json(), {
		code: "connector_status_too_large",
		message: "Connector status exceeds 4096 bytes",
	});
});

test("a rejected or revoked device never reaches a node Durable Object", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	let routed = false;
	const handler = createAlphaHandler();
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${identity.accountId}/${deviceId}/connect`,
			{
				headers: {
					authorization: "Bearer revoked",
					upgrade: "websocket",
				},
			},
		),
		environment(
			async () =>
				Response.json(
					{
						code: "alpha_device_unauthorized",
						message: "Personal Node device credential is invalid or revoked",
					},
					{ status: 403 },
				),
			async () => {
				routed = true;
				return new Response();
			},
		),
	);
	assert.equal(response.status, 403);
	assert.equal(routed, false);
	assert.deepEqual(await response.json(), {
		code: "alpha_device_unauthorized",
		message: "Personal Node device credential is invalid or revoked",
	});
});

test("an authenticated owner can route status and commands only to a registered device", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	const accountRequests: Request[] = [];
	const nodeRequests: Request[] = [];
	const handler = createAlphaHandler({ authorizeUser: async () => identity });
	const env = environment(
		async (request) => {
			accountRequests.push(request);
			return Response.json({ ok: true });
		},
		async (request) => {
			nodeRequests.push(request);
			return Response.json({ ok: true }, { status: 202 });
		},
	);
	const commandBody = {
		idempotencyKey: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
		request: {
			method: "POST",
			path: "/api/spaces/2f4cb274-7f80-4a4b-b326-22d4af6a9873/prompt",
			headers: {},
			body: "{}",
		},
	};
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${deviceId}/commands`,
			{
				method: "POST",
				headers: {
					authorization: "Bearer browser-token",
					"content-type": "application/json",
					origin: "https://dev-cohub.atou.cc",
				},
				body: JSON.stringify(commandBody),
			},
		),
		env,
	);
	assert.equal(response.status, 202);
	const accountRequest = accountRequests[0];
	assert.ok(accountRequest);
	assert.equal(
		new URL(accountRequest.url).pathname,
		`/internal/devices/${deviceId}/owner-authorize`,
	);
	assert.equal(accountRequest.headers.get("authorization"), null);
	const nodeRequest = nodeRequests[0];
	assert.ok(nodeRequest);
	assert.equal(new URL(nodeRequest.url).pathname, "/internal/commands");
	assert.equal(nodeRequest.headers.get("authorization"), null);
	assert.deepEqual(await nodeRequest.json(), commandBody);
});

test("browser event sockets authenticate through a constrained subprotocol", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	let observedAuthorization: string | null = null;
	let forwardedProtocols: string | null = null;
	const handler = createAlphaHandler({
		authorizeUser: async (request) => {
			observedAuthorization = request.headers.get("authorization");
			return identity;
		},
	});
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${deviceId}/events`,
			{
				headers: {
					origin: "https://dev-cohub.atou.cc",
					upgrade: "websocket",
					"sec-websocket-protocol":
						"cohub-alpha-v1, cohub-alpha-bearer.header.payload.signature",
				},
			},
		),
		environment(
			async () => Response.json({ ok: true }),
			async (request) => {
				forwardedProtocols = request.headers.get("sec-websocket-protocol");
				return Response.json({ ok: true });
			},
		),
	);
	assert.equal(response.status, 200);
	assert.equal(observedAuthorization, "Bearer header.payload.signature");
	assert.equal(forwardedProtocols, "cohub-alpha-v1");
});

test("browser attachment plans stay on the owner-scoped Alpha route", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	const attachmentId = "e3548945-9376-41ad-b337-a2b3904fcc59";
	const handler = createAlphaHandler({ authorizeUser: async () => identity });
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${deviceId}/attachments`,
			{
				method: "POST",
				headers: {
					authorization: "Bearer browser-token",
					"content-type": "application/json",
					origin: "https://dev-cohub.atou.cc",
				},
				body: JSON.stringify({
					name: "note.txt",
					size: 4,
					contentType: "text/plain",
					sha256: "b".repeat(64),
				}),
			},
		),
		environment(
			async () => Response.json({ ok: true }),
			async (request) => {
				assert.equal(new URL(request.url).pathname, "/internal/attachments");
				assert.equal(request.headers.get("authorization"), null);
				return Response.json(
					{
						attachment: {
							id: attachmentId,
							nodeId: await alphaNodeId({ accountId: identity.accountId, deviceId }),
							name: "note.txt",
							size: 4,
							contentType: "text/plain",
							sha256: "b".repeat(64),
							state: "pending",
							expiresAt: "2026-09-09T00:00:00.000Z",
						},
						uploadToken: "upload-secret",
					},
					{ status: 201 },
				);
			},
		),
	);
	assert.equal(response.status, 201);
	const payload = (await response.json()) as { upload: { url: string } };
	assert.equal(
		payload.upload.url,
		`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${deviceId}/attachments/${attachmentId}/content?uploadToken=upload-secret`,
	);
});

test("a browser cannot create a channel for a missing or revoked device", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	let nodeRouted = false;
	const handler = createAlphaHandler({ authorizeUser: async () => identity });
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/nodes/${deviceId}/status`,
			{
				headers: {
					authorization: "Bearer browser-token",
					origin: "https://dev-cohub.atou.cc",
				},
			},
		),
		environment(
			async () =>
				Response.json(
					{ code: "alpha_device_revoked", message: "Personal Node device is revoked" },
					{ status: 403 },
				),
			async () => {
				nodeRouted = true;
				return new Response();
			},
		),
	);
	assert.equal(response.status, 403);
	assert.equal(nodeRouted, false);
	assert.deepEqual(await response.json(), {
		code: "alpha_device_revoked",
		message: "Personal Node device is revoked",
	});
});

test("revocation closes the device Durable Object connections", async () => {
	const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
	const nodeRequests: Request[] = [];
	const handler = createAlphaHandler({ authorizeUser: async () => identity });
	const response = await handler.fetch(
		new Request(
			`https://dev-cohub.atou.cc/api/alpha/v1/devices/${deviceId}/revoke`,
			{
				method: "POST",
				headers: {
					authorization: "Bearer browser-token",
					origin: "https://dev-cohub.atou.cc",
				},
			},
		),
		environment(
			async () => Response.json({ device: { id: deviceId, status: "revoked" } }),
			async (request) => {
				nodeRequests.push(request);
				return Response.json({ ok: true });
			},
		),
	);
	assert.equal(response.status, 200);
	assert.equal(nodeRequests.length, 1);
	const revokeRequest = nodeRequests[0];
	assert.ok(revokeRequest);
	assert.equal(new URL(revokeRequest.url).pathname, "/internal/revoke");
});

test("authenticated device routes strip the user token and bind account identity", async () => {
	const forwarded: Request[] = [];
	const handler = createAlphaHandler({ authorizeUser: async () => identity });
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/devices", {
			headers: {
				authorization: "Bearer user-token",
				origin: "https://dev-cohub.atou.cc",
			},
		}),
		environment(async (request) => {
			forwarded.push(request);
			return Response.json({ devices: [] });
		}),
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("access-control-allow-origin"), "https://dev-cohub.atou.cc");
	const routed = forwarded[0];
	assert.ok(routed);
	assert.equal(routed.headers.get("authorization"), null);
	assert.equal(routed.headers.get("x-cohub-alpha-account-id"), identity.accountId);
	assert.equal(routed.headers.get("x-cohub-alpha-subject"), identity.subject);
	assert.equal(routed.headers.get("x-cohub-alpha-user-uuid"), identity.userUuid);
	assert.equal(new URL(routed.url).pathname, "/internal/devices");
});

test("alpha rejects foreign origins before account routing", async () => {
	let authorizeCalls = 0;
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			authorizeCalls += 1;
			return identity;
		},
	});
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/devices", {
			headers: { origin: "https://attacker.example" },
		}),
		environment(async () => new Response()),
	);
	assert.equal(response.status, 403);
	assert.equal(authorizeCalls, 0);
	assert.deepEqual(await response.json(), {
		code: "alpha_origin_forbidden",
		message: "Request origin is not allowed",
	});
});

test("alpha exposes authentication failures without routing to an account", async () => {
	let routed = false;
	const handler = createAlphaHandler({
		authorizeUser: async () => {
			throw new RelayProtocolError(
				"alpha_token_missing",
				"Logto bearer token is required",
				401,
			);
		},
	});
	const response = await handler.fetch(
		new Request("https://dev-cohub.atou.cc/api/alpha/v1/devices"),
		environment(async () => {
			routed = true;
			return new Response();
		}),
	);
	assert.equal(response.status, 401);
	assert.equal(routed, false);
	assert.deepEqual(await response.json(), {
		code: "alpha_token_missing",
		message: "Logto bearer token is required",
	});
});
