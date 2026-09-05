import {
	alphaNodeId,
	authorizeAlphaUserRequest,
	sha256Hex,
	type AlphaUserIdentity,
} from "./alpha-auth.ts";
import type { PersonalAccount } from "./alpha-account.ts";
import {
	createAttachmentPlan,
	handleAttachmentDownload,
	handleAttachmentUpload,
} from "./attachment-operations.ts";
import type { LocalNodeRelay } from "./index.ts";
import {
	bindRelayNodeRequest,
	RELAY_NODE_IDENTITY_HEADER,
} from "./node-identity.ts";
import { RelayProtocolError } from "./protocol.ts";

export type AlphaEnv = {
	ACCOUNTS: DurableObjectNamespace<PersonalAccount>;
	NODES: DurableObjectNamespace<LocalNodeRelay>;
	COMMAND_WAKEUPS: Queue;
	ATTACHMENTS: R2Bucket;
	ALLOWED_ORIGIN: string;
	LOGTO_ENDPOINT: string;
	LOGTO_API_RESOURCE: string;
	LOGTO_APP_ID: string;
	COMMAND_LEASE_MS: string;
	COMMAND_MAX_BODY_BYTES: string;
	ATTACHMENT_MAX_BYTES: string;
	ATTACHMENT_TTL_MS: string;
	ACTIVITY_STALE_SECONDS: string;
	ACTIVITY_REGISTRATION_TTL_SECONDS: string;
};

type AlphaHandlerDependencies = {
	authorizeUser?: (
		request: Request,
		env: AlphaEnv,
	) => Promise<AlphaUserIdentity>;
	fetchExternal?: (request: Request) => Promise<Response>;
};

function json(value: unknown, status = 200, origin?: string) {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			...(origin
				? {
						"access-control-allow-origin": origin,
						vary: "Origin",
					}
				: {}),
		},
	});
}

function errorResponse(error: unknown, origin?: string) {
	if (
		error instanceof RelayProtocolError ||
		(error !== null &&
			typeof error === "object" &&
			typeof Reflect.get(error, "code") === "string" &&
			typeof Reflect.get(error, "message") === "string" &&
			Number.isInteger(Reflect.get(error, "status")))
	) {
		return json(
			{
				code: Reflect.get(error, "code"),
				message: Reflect.get(error, "message"),
			},
			Number(Reflect.get(error, "status")),
			origin,
		);
	}
	console.error("[alpha] unhandled request error", error);
	return json(
		{
			code: "internal_error",
			message:
				error instanceof Error
					? `Personal Node Alpha request failed: ${error.message}`
					: "Personal Node Alpha request failed",
		},
		500,
		origin,
	);
}

function configuredOrigin(env: AlphaEnv) {
	const url = new URL(env.ALLOWED_ORIGIN.trim());
	if (url.protocol !== "https:") {
		throw new Error("ALLOWED_ORIGIN must use HTTPS");
	}
	return url.origin;
}

function requireAlphaConfig(env: AlphaEnv) {
	for (const name of [
		"ALLOWED_ORIGIN",
		"LOGTO_ENDPOINT",
		"LOGTO_API_RESOURCE",
		"LOGTO_APP_ID",
	] as const) {
		if (!env[name]?.trim()) {
			throw new Error(`Missing Personal Node Alpha setting: ${name}`);
		}
	}
}

function assertRequestOrigin(request: Request, allowedOrigin: string) {
	const origin = request.headers.get("origin");
	if (origin && origin !== allowedOrigin) {
		throw new RelayProtocolError(
			"alpha_origin_forbidden",
			"Request origin is not allowed",
			403,
		);
	}
}

const DEVICE_GRANT_TYPE =
	"urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_SCOPE = "openid profile email offline_access";

function requiredString(
	value: unknown,
	field: string,
	options: { maxLength?: number } = {},
) {
	if (typeof value !== "string" || !value.trim()) {
		throw new RelayProtocolError(
			"alpha_auth_response_invalid",
			`Identity provider response is missing ${field}`,
			502,
		);
	}
	const result = value.trim();
	if (result.length > (options.maxLength ?? 4_096)) {
		throw new RelayProtocolError(
			"alpha_auth_response_invalid",
			`Identity provider response has an invalid ${field}`,
			502,
		);
	}
	return result;
}

function requiredPositiveNumber(value: unknown, field: string) {
	const result = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(result) || result <= 0) {
		throw new RelayProtocolError(
			"alpha_auth_response_invalid",
			`Identity provider response has an invalid ${field}`,
			502,
		);
	}
	return result;
}

function optionalString(value: unknown, field: string) {
	return value === undefined
		? undefined
		: requiredString(value, field, { maxLength: 16_384 });
}

function authEndpoint(env: AlphaEnv, path: string) {
	const endpoint = new URL(env.LOGTO_ENDPOINT.trim());
	if (endpoint.protocol !== "https:") {
		throw new Error("LOGTO_ENDPOINT must use HTTPS");
	}
	return new URL(path, `${endpoint.origin}/`).toString();
}

async function readProviderJson(response: Response) {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		throw new RelayProtocolError(
			"alpha_auth_provider_invalid",
			"Identity provider returned a non-JSON response",
			502,
		);
	}
	const value = await response.json().catch(() => null);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RelayProtocolError(
			"alpha_auth_provider_invalid",
			"Identity provider returned invalid JSON",
			502,
		);
	}
	return value as Record<string, unknown>;
}

function providerFormRequest(url: string, body: URLSearchParams) {
	return new Request(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
}

async function beginDeviceAuthorization(input: {
	env: AlphaEnv;
	fetchExternal: (request: Request) => Promise<Response>;
	origin: string;
}) {
	const response = await input.fetchExternal(
		providerFormRequest(
			authEndpoint(input.env, "/oidc/device/auth"),
			new URLSearchParams({
				client_id: input.env.LOGTO_APP_ID.trim(),
				scope: DEVICE_SCOPE,
				resource: input.env.LOGTO_API_RESOURCE.trim(),
			}),
		),
	);
	const payload = await readProviderJson(response);
	if (!response.ok) {
		throw new RelayProtocolError(
			"alpha_auth_provider_rejected",
			"Identity provider rejected device authorization",
			502,
		);
	}
	return json(
		{
			deviceCode: requiredString(payload.device_code, "device_code"),
			userCode: requiredString(payload.user_code, "user_code", {
				maxLength: 64,
			}),
			verificationUri: requiredString(
				payload.verification_uri,
				"verification_uri",
			),
			verificationUriComplete: requiredString(
				payload.verification_uri_complete,
				"verification_uri_complete",
			),
			expiresInSeconds: requiredPositiveNumber(
				payload.expires_in,
				"expires_in",
			),
			intervalSeconds:
				payload.interval === undefined
					? 5
					: requiredPositiveNumber(payload.interval, "interval"),
		},
		200,
		input.origin,
	);
}

function successfulTokenResponse(
	payload: Record<string, unknown>,
	origin: string,
	options: { requireRefreshToken: boolean },
) {
	const tokenType = requiredString(payload.token_type, "token_type", {
		maxLength: 32,
	});
	if (tokenType.toLowerCase() !== "bearer") {
		throw new RelayProtocolError(
			"alpha_auth_response_invalid",
			"Identity provider returned an unsupported token type",
			502,
		);
	}
	const refreshToken =
		payload.refresh_token === undefined && !options.requireRefreshToken
			? undefined
			: requiredString(payload.refresh_token, "refresh_token", {
					maxLength: 16_384,
				});
	return json(
		{
			status: "complete",
			accessToken: requiredString(payload.access_token, "access_token", {
				maxLength: 16_384,
			}),
			...(refreshToken === undefined ? {} : { refreshToken }),
			...(payload.id_token === undefined
				? {}
				: { idToken: optionalString(payload.id_token, "id_token") }),
			tokenType: "Bearer",
			expiresInSeconds: requiredPositiveNumber(
				payload.expires_in,
				"expires_in",
			),
			scope:
				typeof payload.scope === "string" && payload.scope.trim()
					? payload.scope.trim()
					: DEVICE_SCOPE,
		},
		200,
		origin,
	);
}

async function deviceToken(input: {
	request: Request;
	env: AlphaEnv;
	fetchExternal: (request: Request) => Promise<Response>;
	origin: string;
}) {
	const body = await input.request.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new RelayProtocolError(
			"invalid_json",
			"request body must be valid JSON",
		);
	}
	const deviceCode = Reflect.get(body, "deviceCode");
	if (
		typeof deviceCode !== "string" ||
		!deviceCode.trim() ||
		deviceCode.length > 4_096 ||
		/[\r\n\0]/.test(deviceCode)
	) {
		throw new RelayProtocolError(
			"alpha_device_code_invalid",
			"deviceCode must be a valid non-empty string",
		);
	}
	const response = await input.fetchExternal(
		providerFormRequest(
			authEndpoint(input.env, "/oidc/token"),
			new URLSearchParams({
				client_id: input.env.LOGTO_APP_ID.trim(),
				grant_type: DEVICE_GRANT_TYPE,
				device_code: deviceCode.trim(),
				resource: input.env.LOGTO_API_RESOURCE.trim(),
			}),
		),
	);
	const payload = await readProviderJson(response);
	if (!response.ok) {
		const providerCode =
			typeof payload.error === "string" ? payload.error : "unknown";
		if (providerCode === "authorization_pending") {
			return json({ status: "pending" }, 202, input.origin);
		}
		if (providerCode === "slow_down") {
			return json({ status: "slow_down" }, 429, input.origin);
		}
		if (providerCode === "access_denied") {
			return json(
				{ code: "alpha_auth_denied", message: "Device authorization was denied" },
				403,
				input.origin,
			);
		}
		if (providerCode === "expired_token") {
			return json(
				{ code: "alpha_auth_expired", message: "Device authorization expired" },
				410,
				input.origin,
			);
		}
		throw new RelayProtocolError(
			"alpha_auth_provider_rejected",
			"Identity provider rejected the device token exchange",
			502,
		);
	}
	return successfulTokenResponse(payload, input.origin, {
		requireRefreshToken: true,
	});
}

async function refreshDeviceToken(input: {
	request: Request;
	env: AlphaEnv;
	fetchExternal: (request: Request) => Promise<Response>;
	origin: string;
}) {
	const body = await input.request.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new RelayProtocolError(
			"invalid_json",
			"request body must be valid JSON",
		);
	}
	const refreshToken = Reflect.get(body, "refreshToken");
	if (
		typeof refreshToken !== "string" ||
		!refreshToken.trim() ||
		refreshToken.length > 16_384 ||
		/[\r\n\0]/.test(refreshToken)
	) {
		throw new RelayProtocolError(
			"alpha_refresh_token_invalid",
			"refreshToken must be a valid non-empty string",
		);
	}
	const response = await input.fetchExternal(
		providerFormRequest(
			authEndpoint(input.env, "/oidc/token"),
			new URLSearchParams({
				client_id: input.env.LOGTO_APP_ID.trim(),
				grant_type: "refresh_token",
				refresh_token: refreshToken.trim(),
				scope: DEVICE_SCOPE,
				resource: input.env.LOGTO_API_RESOURCE.trim(),
			}),
		),
	);
	const payload = await readProviderJson(response);
	if (!response.ok) {
		const providerCode =
			typeof payload.error === "string" ? payload.error : "unknown";
		if (providerCode === "invalid_grant" || providerCode === "invalid_token") {
			return json(
				{ code: "alpha_auth_expired", message: "Sign-in session expired" },
				401,
				input.origin,
			);
		}
		throw new RelayProtocolError(
			"alpha_auth_provider_rejected",
			"Identity provider rejected the token refresh",
			502,
		);
	}
	return successfulTokenResponse(payload, input.origin, {
		requireRefreshToken: false,
	});
}

const ALPHA_WEBSOCKET_PROTOCOL = "cohub-alpha-v1";
const ALPHA_WEBSOCKET_BEARER_PREFIX = "cohub-alpha-bearer.";

function authorizeWebSocketRequest(request: Request) {
	if (request.headers.has("authorization")) return request;
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return request;
	const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((value) => value.trim());
	const bearer = protocols.find((value) =>
		value.startsWith(ALPHA_WEBSOCKET_BEARER_PREFIX),
	);
	if (!bearer) return request;
	const token = bearer.slice(ALPHA_WEBSOCKET_BEARER_PREFIX.length);
	if (!token || /[\s,]/.test(token)) return request;
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${token}`);
	return new Request(request, { headers });
}

function accountStub(env: AlphaEnv, identity: AlphaUserIdentity) {
	return env.ACCOUNTS.getByName(identity.accountId);
}

function deviceBearerToken(request: Request) {
	const authorization = request.headers.get("authorization")?.trim() ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) {
		throw new RelayProtocolError(
			"alpha_device_token_missing",
			"Personal Node device bearer token is required",
			401,
		);
	}
	return match[1].trim();
}

async function authorizeDeviceConnection(input: {
	request: Request;
	env: AlphaEnv;
	accountId: string;
	deviceId: string;
}) {
	const credentialHash = await sha256Hex(deviceBearerToken(input.request));
	const request = new Request(
		`https://alpha.internal/internal/devices/${input.deviceId}/authorize`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-cohub-alpha-account-id": input.accountId,
				"x-cohub-alpha-device-auth": "1",
			},
			body: JSON.stringify({ credentialHash }),
		},
	);
	return input.env.ACCOUNTS.getByName(input.accountId).fetch(request);
}

async function authorizeUserDevice(input: {
	request: Request;
	env: AlphaEnv;
	identity: AlphaUserIdentity;
	deviceId: string;
}) {
	const response = await accountStub(input.env, input.identity).fetch(
		await trustedAccountRequest({
			request: new Request(input.request.url, { method: "POST" }),
			identity: input.identity,
			path: `/internal/devices/${input.deviceId}/owner-authorize`,
		}),
	);
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as {
			code?: unknown;
			message?: unknown;
		} | null;
		throw new RelayProtocolError(
			typeof payload?.code === "string"
				? payload.code
				: "alpha_device_forbidden",
			typeof payload?.message === "string"
				? payload.message
				: "Personal Node device is unavailable",
			response.status,
		);
	}
	return response;
}

async function personalNodeStub(input: {
	env: AlphaEnv;
	identity: AlphaUserIdentity;
	deviceId: string;
}) {
	const nodeId = await alphaNodeId({
		accountId: input.identity.accountId,
		deviceId: input.deviceId,
	});
	const raw = input.env.NODES.getByName(nodeId);
	return {
		nodeId,
		fetch(request: Request) {
			return raw.fetch(bindRelayNodeRequest(request, undefined, nodeId));
		},
	};
}

async function routeUserNodeRequest(input: {
	request: Request;
	env: AlphaEnv;
	identity: AlphaUserIdentity;
	deviceId: string;
	internalPath: string;
}) {
	const authorization = await authorizeUserDevice(input);
	if (!authorization.ok) return authorization;
	const node = await personalNodeStub(input);
	const headers = new Headers(input.request.headers);
	headers.delete("authorization");
	headers.delete("cookie");
	headers.delete("cf-access-jwt-assertion");
	if (headers.get("upgrade")?.toLowerCase() === "websocket") {
		headers.set("sec-websocket-protocol", ALPHA_WEBSOCKET_PROTOCOL);
	}
	const forwarded = new Request(`https://alpha.internal${input.internalPath}`, {
		method: input.request.method,
		headers,
		body: await requestBody(input.request),
	});
	return node.fetch(forwarded);
}

async function connectPersonalNode(input: {
	request: Request;
	env: AlphaEnv;
	accountId: string;
	deviceId: string;
}) {
	if (input.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		throw new RelayProtocolError(
			"upgrade_required",
			"Personal Node connection requires WebSocket",
			426,
		);
	}
	const authorization = await authorizeDeviceConnection(input);
	if (!authorization.ok) {
		return new Response(authorization.body, {
			status: authorization.status,
			headers: authorization.headers,
		});
	}
	const nodeId = await alphaNodeId({
		accountId: input.accountId,
		deviceId: input.deviceId,
	});
	const forwarded = bindRelayNodeRequest(
		new Request("https://alpha.internal/internal/node", input.request),
		undefined,
		nodeId,
	);
	forwarded.headers.delete("authorization");
	forwarded.headers.delete("cookie");
	forwarded.headers.delete("cf-access-jwt-assertion");
	forwarded.headers.set(RELAY_NODE_IDENTITY_HEADER, nodeId);
	return input.env.NODES.getByName(nodeId).fetch(forwarded);
}

async function reportPersonalNodeStatus(input: {
	request: Request;
	env: AlphaEnv;
	accountId: string;
	deviceId: string;
}) {
	const authorization = await authorizeDeviceConnection(input);
	if (!authorization.ok) return authorization;
	const nodeId = await alphaNodeId({
		accountId: input.accountId,
		deviceId: input.deviceId,
	});
	const forwarded = bindRelayNodeRequest(
		new Request("https://alpha.internal/internal/connector-status", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: await connectorStatusBody(input.request),
		}),
		undefined,
		nodeId,
	);
	return input.env.NODES.getByName(nodeId).fetch(forwarded);
}

async function connectorStatusBody(request: Request) {
	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > 4_096) {
		throw new RelayProtocolError(
			"connector_status_too_large",
			"Connector status exceeds 4096 bytes",
			413,
		);
	}
	const body = await request.clone().arrayBuffer();
	if (body.byteLength > 4_096) {
		throw new RelayProtocolError(
			"connector_status_too_large",
			"Connector status exceeds 4096 bytes",
			413,
		);
	}
	return body;
}

async function routeDeviceAttachmentRequest(input: {
	request: Request;
	env: AlphaEnv;
	accountId: string;
	deviceId: string;
	attachmentId?: string;
}) {
	if (input.request.headers.get("x-cohub-relay-node") !== "1") {
		throw new RelayProtocolError(
			"alpha_device_route_forbidden",
			"Personal Node attachment route requires node identity",
			403,
		);
	}
	const authorization = await authorizeDeviceConnection(input);
	if (!authorization.ok) return authorization;
	const identity: AlphaUserIdentity = {
		accountId: input.accountId,
		subject: "device",
		userUuid: "device",
		clientId: "device",
	};
	const node = await personalNodeStub({
		env: input.env,
		identity,
		deviceId: input.deviceId,
	});
	const publicBasePath = `/api/alpha/v1/nodes/${input.accountId}/${input.deviceId}`;
	if (input.request.method === "POST" && !input.attachmentId) {
		return createAttachmentPlan({
			request: await attachmentPlanRequest(input.request),
			url: new URL(input.request.url),
			stub: node,
			nodeId: node.nodeId,
			publicBasePath,
		});
	}
	if (input.request.method === "PUT" && input.attachmentId) {
		return handleAttachmentUpload({
			request: input.request,
			env: input.env,
			stub: node,
			nodeId: node.nodeId,
			attachmentId: input.attachmentId,
		});
	}
	if (input.request.method === "GET" && input.attachmentId) {
		return handleAttachmentDownload({
			env: input.env,
			stub: node,
			attachmentId: input.attachmentId,
		});
	}
	throw new RelayProtocolError("not_found", "Alpha attachment route not found", 404);
}

async function routeUserAttachmentRequest(input: {
	request: Request;
	env: AlphaEnv;
	identity: AlphaUserIdentity;
	deviceId: string;
	attachmentId?: string;
}) {
	const authorization = await authorizeUserDevice(input);
	if (!authorization.ok) return authorization;
	const node = await personalNodeStub(input);
	const publicBasePath = `/api/alpha/v1/nodes/${input.deviceId}`;
	if (input.request.method === "POST" && !input.attachmentId) {
		return createAttachmentPlan({
			request: await attachmentPlanRequest(input.request),
			url: new URL(input.request.url),
			stub: node,
			nodeId: node.nodeId,
			publicBasePath,
		});
	}
	if (input.request.method === "PUT" && input.attachmentId) {
		return handleAttachmentUpload({
			request: input.request,
			env: input.env,
			stub: node,
			nodeId: node.nodeId,
			attachmentId: input.attachmentId,
		});
	}
	if (input.request.method === "GET" && input.attachmentId) {
		return handleAttachmentDownload({
			env: input.env,
			stub: node,
			attachmentId: input.attachmentId,
		});
	}
	throw new RelayProtocolError("not_found", "Alpha attachment route not found", 404);
}

async function requestBody(request: Request) {
	return request.method === "GET" || request.method === "HEAD"
		? undefined
		: await request.clone().arrayBuffer();
}

async function attachmentPlanRequest(request: Request) {
	const headers = new Headers(request.headers);
	headers.delete("authorization");
	headers.delete("cookie");
	headers.delete("cf-access-jwt-assertion");
	return new Request(request.url, {
		method: request.method,
		headers,
		body: await requestBody(request),
	});
}

async function trustedAccountRequest(input: {
	request: Request;
	identity: AlphaUserIdentity;
	path: string;
}) {
	const headers = new Headers(input.request.headers);
	headers.delete("authorization");
	headers.delete("cookie");
	headers.delete("cf-access-jwt-assertion");
	headers.set("x-cohub-alpha-account-id", input.identity.accountId);
	headers.set("x-cohub-alpha-subject", input.identity.subject);
	headers.set("x-cohub-alpha-user-uuid", input.identity.userUuid);
	return new Request(`https://alpha.internal${input.path}`, {
		method: input.request.method,
		headers,
		body: await requestBody(input.request),
	});
}

function withPublicCors(response: Response, origin: string) {
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("cache-control", "no-store");
	headers.append("vary", "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function defaultAuthorizeUser(request: Request, env: AlphaEnv) {
	return authorizeAlphaUserRequest(request, {
		logtoEndpoint: env.LOGTO_ENDPOINT,
		audience: env.LOGTO_API_RESOURCE,
		appId: env.LOGTO_APP_ID,
	});
}

export function createAlphaHandler(dependencies: AlphaHandlerDependencies = {}) {
	const authorizeUser = dependencies.authorizeUser ?? defaultAuthorizeUser;
	const fetchExternal = dependencies.fetchExternal ?? ((request) => fetch(request));
	return {
		async fetch(request: Request, env: AlphaEnv) {
			let allowedOrigin: string | undefined;
			try {
				requireAlphaConfig(env);
				allowedOrigin = configuredOrigin(env);
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/healthz") {
					return json(
						{
							status: "ready",
							service: "cohub-personal-node-alpha",
							schemaVersion: 1,
						},
						200,
						allowedOrigin,
					);
				}
				const nodeConnectMatch = url.pathname.match(
					/^\/api\/alpha\/v1\/nodes\/([0-9a-f]{64})\/([0-9a-f-]{36})\/connect$/,
				);
				if (
					request.method === "GET" &&
					nodeConnectMatch?.[1] &&
					nodeConnectMatch[2]
				) {
					return connectPersonalNode({
						request,
						env,
						accountId: nodeConnectMatch[1],
						deviceId: nodeConnectMatch[2].toLowerCase(),
					});
				}
				const nodeStatusReportMatch = url.pathname.match(
					/^\/api\/alpha\/v1\/nodes\/([0-9a-f]{64})\/([0-9a-f-]{36})\/status$/,
				);
				if (
					request.method === "POST" &&
					nodeStatusReportMatch?.[1] &&
					nodeStatusReportMatch[2]
				) {
					return await reportPersonalNodeStatus({
						request,
						env,
						accountId: nodeStatusReportMatch[1],
						deviceId: nodeStatusReportMatch[2].toLowerCase(),
					});
				}
				const nodeAttachmentMatch = url.pathname.match(
					/^\/api\/alpha\/v1\/nodes\/([0-9a-f]{64})\/([0-9a-f-]{36})\/attachments(?:\/([0-9a-f-]{36})\/content)?$/,
				);
				if (nodeAttachmentMatch?.[1] && nodeAttachmentMatch[2]) {
					return routeDeviceAttachmentRequest({
						request,
						env,
						accountId: nodeAttachmentMatch[1],
						deviceId: nodeAttachmentMatch[2].toLowerCase(),
						...(nodeAttachmentMatch[3]
							? { attachmentId: nodeAttachmentMatch[3].toLowerCase() }
							: {}),
					});
				}
				assertRequestOrigin(request, allowedOrigin);
				if (request.method === "OPTIONS") {
					return new Response(null, {
						status: 204,
						headers: {
							"access-control-allow-origin": allowedOrigin,
							"access-control-allow-headers": "authorization, content-type",
							"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
							"access-control-max-age": "600",
							vary: "Origin",
						},
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === "/api/alpha/v1/auth/device"
				) {
					return beginDeviceAuthorization({
						env,
						fetchExternal,
						origin: allowedOrigin,
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === "/api/alpha/v1/auth/token"
				) {
					return deviceToken({
						request,
						env,
						fetchExternal,
						origin: allowedOrigin,
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === "/api/alpha/v1/auth/refresh"
				) {
					return refreshDeviceToken({
						request,
						env,
						fetchExternal,
						origin: allowedOrigin,
					});
				}
				const identity = await authorizeUser(authorizeWebSocketRequest(request), env);
				if (request.method === "GET" && url.pathname === "/api/alpha/v1/account") {
					return json(
						{
							accountId: identity.accountId,
							userUuid: identity.userUuid,
						},
						200,
						allowedOrigin,
					);
				}
				const userAttachmentMatch = url.pathname.match(
					/^\/api\/alpha\/v1\/nodes\/([0-9a-f-]{36})\/attachments(?:\/([0-9a-f-]{36})\/content)?$/,
				);
				if (userAttachmentMatch?.[1]) {
					const response = await routeUserAttachmentRequest({
						request,
						env,
						identity,
						deviceId: userAttachmentMatch[1].toLowerCase(),
						...(userAttachmentMatch[2]
							? { attachmentId: userAttachmentMatch[2].toLowerCase() }
							: {}),
					});
					return withPublicCors(response, allowedOrigin);
				}
				const userNodeMatch = url.pathname.match(
					/^\/api\/alpha\/v1\/nodes\/([0-9a-f-]{36})\/(status|events|commands|read)(\/[^/]+)?(\/cancel)?$/,
				);
				if (userNodeMatch?.[1] && userNodeMatch[2]) {
					const deviceId = userNodeMatch[1].toLowerCase();
					const resource = userNodeMatch[2];
					const resourceId = userNodeMatch[3] ?? "";
					const cancel = userNodeMatch[4] ?? "";
					const allowed =
						(resource === "status" && request.method === "GET" && !resourceId) ||
						(resource === "events" && request.method === "GET" && !resourceId) ||
						(resource === "read" && request.method === "GET" && !resourceId) ||
						(resource === "commands" && request.method === "POST" && !resourceId) ||
						(resource === "commands" && request.method === "GET" && !!resourceId && !cancel) ||
						(resource === "commands" && request.method === "POST" && !!resourceId && cancel === "/cancel");
					if (allowed) {
						const internalPath =
							resource === "status"
								? "/internal/status"
								: resource === "events"
									? "/internal/events"
									: resource === "read"
										? `/internal/projection${url.search}`
									: `/internal/commands${resourceId}${cancel}`;
						const response = await routeUserNodeRequest({
							request,
							env,
							identity,
							deviceId,
							internalPath,
						});
						return resource === "events"
							? response
							: withPublicCors(response, allowedOrigin);
					}
				}
				const stub = accountStub(env, identity);
				if (
					url.pathname === "/api/alpha/v1/devices" &&
					(request.method === "GET" || request.method === "POST")
				) {
					const response = await stub.fetch(
						await trustedAccountRequest({
							request,
							identity,
							path: "/internal/devices",
						}),
					);
					return withPublicCors(response, allowedOrigin);
				}
				const deviceMatch = url.pathname.match(
					/^\/api\/alpha\/v1\/devices\/([0-9a-f-]+)\/(rotate|revoke)$/,
				);
				if (request.method === "POST" && deviceMatch?.[1] && deviceMatch[2]) {
					const response = await stub.fetch(
						await trustedAccountRequest({
							request,
							identity,
							path: `/internal/devices/${deviceMatch[1]}/${deviceMatch[2]}`,
						}),
					);
					if (response.ok) {
						const node = await personalNodeStub({
							env,
							identity,
							deviceId: deviceMatch[1].toLowerCase(),
						});
						await node.fetch(
							new Request("https://alpha.internal/internal/revoke", {
								method: "POST",
							}),
						);
					}
					return withPublicCors(response, allowedOrigin);
				}
				return json(
					{ code: "not_found", message: "Alpha route not found" },
					404,
					allowedOrigin,
				);
			} catch (error) {
				return errorResponse(error, allowedOrigin);
			}
		},
	} satisfies ExportedHandler<AlphaEnv>;
}
