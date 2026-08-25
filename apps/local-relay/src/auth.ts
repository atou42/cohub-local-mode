import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { RelayProtocolError } from "./protocol.ts";

export type AccessAuthConfig = {
	teamDomain: string;
	policyAudience: string;
	ownerEmail: string;
};

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeTeamDomain(value: string) {
	const url = new URL(value.trim());
	if (url.protocol !== "https:") {
		throw new Error("TEAM_DOMAIN must use HTTPS");
	}
	return url.origin;
}

function jwksFor(teamDomain: string) {
	const url = `${teamDomain}/cdn-cgi/access/certs`;
	let jwks = jwksByUrl.get(url);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(url));
		jwksByUrl.set(url, jwks);
	}
	return jwks;
}

export async function authorizeOwnerRequest(
	request: Request,
	config: AccessAuthConfig,
): Promise<JWTPayload> {
	const teamDomain = normalizeTeamDomain(config.teamDomain);
	const token = request.headers.get("cf-access-jwt-assertion")?.trim();
	if (!token) {
		throw new RelayProtocolError(
			"access_token_missing",
			"Cloudflare Access authentication is required",
			401,
		);
	}
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, jwksFor(teamDomain), {
			issuer: teamDomain,
			audience: config.policyAudience,
			algorithms: ["RS256"],
		}));
	} catch (error) {
		throw new RelayProtocolError(
			"access_token_invalid",
			`Cloudflare Access token is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`,
			403,
		);
	}
	const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
	if (!email || email !== config.ownerEmail.trim().toLowerCase()) {
		throw new RelayProtocolError(
			"owner_mismatch",
			"Cloudflare Access identity is not authorized for this node",
			403,
		);
	}
	return payload;
}

async function tokenDigest(value: string) {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

export async function authorizeNodeRequest(
	request: Request,
	expectedToken: string,
) {
	const authorization = request.headers.get("authorization")?.trim() ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1] || !expectedToken.trim()) {
		throw new RelayProtocolError(
			"node_token_missing",
			"node bearer token is required",
			401,
		);
	}
	const [providedDigest, expectedDigest] = await Promise.all([
		tokenDigest(match[1]),
		tokenDigest(expectedToken.trim()),
	]);
	if (!equalBytes(providedDigest, expectedDigest)) {
		throw new RelayProtocolError(
			"node_token_invalid",
			"node bearer token is invalid",
			403,
		);
	}
}
