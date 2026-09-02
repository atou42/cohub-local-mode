import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { RelayProtocolError } from "./protocol.ts";

export type AlphaUserIdentity = {
	accountId: string;
	subject: string;
	userUuid: string;
	clientId: string;
};

export type AlphaAuthConfig = {
	logtoEndpoint: string;
	audience: string;
	appId: string;
};

const jwksByEndpoint = new Map<
	string,
	ReturnType<typeof createRemoteJWKSet>
>();

function normalizeHttpsEndpoint(value: string) {
	const url = new URL(value.trim());
	if (url.protocol !== "https:") {
		throw new Error("LOGTO_ENDPOINT must use HTTPS");
	}
	return url.origin;
}

function jwksFor(endpoint: string) {
	const url = `${endpoint}/oidc/jwks`;
	let jwks = jwksByEndpoint.get(url);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(url));
		jwksByEndpoint.set(url, jwks);
	}
	return jwks;
}

function requiredClaim(payload: JWTPayload, key: string) {
	const value = payload[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new RelayProtocolError(
			"alpha_token_invalid",
			`Logto token is missing ${key}`,
			401,
		);
	}
	return value.trim();
}

export function requireAlphaUserClaims(payload: JWTPayload, appId: string) {
	const subject = requiredClaim(payload, "sub");
	const userUuid = requiredClaim(payload, "talesofai_uuid");
	const clientId = requiredClaim(payload, "client_id");
	if (payload.is_third_party === true) {
		throw new RelayProtocolError(
			"alpha_third_party_token",
			"Third-party tokens cannot manage Personal Nodes",
			403,
		);
	}
	if (!appId.trim() || clientId !== appId.trim()) {
		throw new RelayProtocolError(
			"alpha_client_mismatch",
			"Logto token was not issued to the Personal Node Alpha client",
			403,
		);
	}
	return { subject, userUuid, clientId };
}

export async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function alphaNodeId(input: {
	accountId: string;
	deviceId: string;
}) {
	return sha256Hex(`node\0${input.accountId}\0${input.deviceId}`);
}

export async function alphaAccountId(input: {
	issuer: string;
	subject: string;
}) {
	return sha256Hex(`${input.issuer}\0${input.subject}`);
}

function bearerToken(request: Request) {
	const authorization = request.headers.get("authorization")?.trim() ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) {
		throw new RelayProtocolError(
			"alpha_token_missing",
			"Logto bearer token is required",
			401,
		);
	}
	return match[1].trim();
}

export async function authorizeAlphaUserRequest(
	request: Request,
	config: AlphaAuthConfig,
): Promise<AlphaUserIdentity> {
	const endpoint = normalizeHttpsEndpoint(config.logtoEndpoint);
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(bearerToken(request), jwksFor(endpoint), {
			issuer: `${endpoint}/oidc`,
			audience: config.audience.trim(),
		}));
	} catch (error) {
		if (error instanceof RelayProtocolError) throw error;
		throw new RelayProtocolError(
			"alpha_token_invalid",
			"Logto bearer token is invalid",
			401,
		);
	}
	const claims = requireAlphaUserClaims(payload, config.appId);
	return {
		...claims,
		accountId: await alphaAccountId({
			issuer: `${endpoint}/oidc`,
			subject: claims.subject,
		}),
	};
}
