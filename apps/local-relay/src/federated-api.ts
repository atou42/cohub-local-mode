import {
	RelayProtocolError,
	type RelayHttpRequest,
} from "./protocol.ts";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_TURN_STATUSES = new Set(["running", "abort_requested"]);
const FEDERATED_FS_PATH =
	/^\/api\/spaces\/([0-9a-f-]{36})\/fs\/(tree|file|dir|node|move)$/i;

type FederatedDependencies = {
	cloudApiOrigin: string;
	ownerUserId: string;
	fetch: typeof fetch;
	maxBodyBytes?: number;
};

type FederatedAuthorization = {
	actorUserId: string;
	targetSpaceId: string;
	sourceSpaceId: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	idempotencyKey: string;
	request: RelayHttpRequest;
};

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function bearerToken(request: Request) {
	const authorization = request.headers.get("authorization")?.trim() ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) {
		throw new RelayProtocolError(
			"cloud_execution_token_missing",
			"Cloud execution authentication is required",
			401,
		);
	}
	return match[1];
}

function uuidHeader(request: Request, name: string, label: string) {
	const value = request.headers.get(name)?.trim() ?? "";
	if (!UUID_PATTERN.test(value)) {
		throw new RelayProtocolError(
			"federated_source_invalid",
			`${label} is required for federated Local Space access`,
			403,
		);
	}
	return value;
}

async function cloudJson(
	path: string,
	token: string,
	deps: FederatedDependencies,
) {
	let response: Response;
	try {
		response = await Reflect.apply(deps.fetch, globalThis, [
			new URL(path, deps.cloudApiOrigin),
			{
				headers: { authorization: `Bearer ${token}` },
				cache: "no-store",
			},
		]);
	} catch (error) {
		throw new RelayProtocolError(
			"cloud_authorization_unavailable",
			`Cloud authorization is unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
			502,
		);
	}
	if (!response.ok) {
		throw new RelayProtocolError(
			response.status === 401
				? "cloud_execution_token_invalid"
				: "cloud_authorization_failed",
			`Cloud authorization returned HTTP ${response.status}`,
			response.status === 401 ? 401 : 502,
		);
	}
	const payload = await response.json().catch(() => null);
	if (!payload || typeof payload !== "object") {
		throw new RelayProtocolError(
			"cloud_authorization_response_invalid",
			"Cloud authorization returned an invalid response",
			502,
		);
	}
	return payload as Record<string, unknown>;
}

function actorIdFromMe(payload: Record<string, unknown>) {
	if (typeof payload.uuid === "string" && payload.uuid.trim()) {
		return payload.uuid.trim();
	}
	const user = record(payload.user);
	return typeof user?.uuid === "string" && user.uuid.trim()
		? user.uuid.trim()
		: null;
}

function hasExplicitLocalMention(
	content: unknown,
	targetSpaceId: string,
) {
	if (!Array.isArray(content)) return false;
	for (const rawBlock of content) {
		const block = record(rawBlock);
		const meta = record(block?._meta);
		if (!meta || meta.mentions === undefined) continue;
		if (!Array.isArray(meta.mentions)) {
			throw new RelayProtocolError(
				"space_mention_metadata_invalid",
				"Space mention metadata is invalid",
				409,
			);
		}
		for (const rawMention of meta.mentions) {
			const mention = record(rawMention);
			if (
				mention?.type === "space" &&
				mention.spaceId === targetSpaceId &&
				mention.origin === "local"
			) {
				return true;
			}
		}
	}
	return false;
}

async function stableUuid(value: string) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	).slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertMethod(method: string, endpoint: string) {
	const expected =
		endpoint === "tree" ? "GET"
			: endpoint === "file" ? new Set(["GET", "PUT"])
				: endpoint === "node" ? "DELETE"
					: "POST";
	const valid = typeof expected === "string"
		? method === expected
		: expected.has(method);
	if (!valid) {
		throw new RelayProtocolError(
			"method_not_allowed",
			"This filesystem method is not available through the Local relay",
			405,
		);
	}
}

async function normalizeFileRequest(
	request: Request,
	toolCallId: string,
	maxBodyBytes: number,
): Promise<{ idempotencyKey: string; request: RelayHttpRequest; targetSpaceId: string }> {
	const url = new URL(request.url);
	const match = url.pathname.match(FEDERATED_FS_PATH);
	const targetSpaceId = match?.[1] ?? "";
	const endpoint = match?.[2] ?? "";
	if (!UUID_PATTERN.test(targetSpaceId) || !endpoint) {
		throw new RelayProtocolError(
			"path_not_allowed",
			"Only Local Space filesystem routes are available through this relay",
			403,
		);
	}
	assertMethod(request.method, endpoint);

	let body = "";
	let fingerprintBody = "";
	let path = `${url.pathname}${url.search}`;
	if (request.method === "PUT" || request.method === "POST") {
		const rawBody = await request.text();
		if (new TextEncoder().encode(rawBody).byteLength > maxBodyBytes) {
			throw new RelayProtocolError(
				"body_too_large",
				"Federated filesystem request exceeds the relay limit",
				413,
			);
		}
		let parsed: Record<string, unknown> | null;
		try {
			parsed = record(JSON.parse(rawBody));
		} catch {
			parsed = null;
		}
		if (!parsed) {
			throw new RelayProtocolError(
				"invalid_request",
				"Federated filesystem request body must be a JSON object",
			);
		}
		const { mutationId: _ignored, ...withoutMutationId } = parsed;
		fingerprintBody = JSON.stringify(withoutMutationId);
		const idempotencyKey = await stableUuid(
			`${toolCallId}\n${request.method}\n${url.pathname}\n${url.search}\n${fingerprintBody}`,
		);
		body = JSON.stringify({ ...withoutMutationId, mutationId: idempotencyKey });
		return {
			idempotencyKey,
			targetSpaceId,
			request: {
				method: request.method as RelayHttpRequest["method"],
				path,
				headers: { "content-type": "application/json" },
				body,
			},
		};
	}

	const query = new URLSearchParams(url.search);
	query.delete("mutationId");
	fingerprintBody = query.toString();
	const idempotencyKey = await stableUuid(
		`${toolCallId}\n${request.method}\n${url.pathname}\n${fingerprintBody}`,
	);
	if (request.method === "DELETE") query.set("mutationId", idempotencyKey);
	path = `${url.pathname}${query.size > 0 ? `?${query}` : ""}`;
	return {
		idempotencyKey,
		targetSpaceId,
		request: {
			method: request.method as RelayHttpRequest["method"],
			path,
			headers: {},
			body: "",
		},
	};
}

export async function authorizeFederatedFileRequest(
	request: Request,
	deps: FederatedDependencies,
): Promise<FederatedAuthorization> {
	const token = bearerToken(request);
	const sourceSpaceId = uuidHeader(
		request,
		"x-cohub-source-space",
		"Source Space",
	);
	const sessionId = uuidHeader(
		request,
		"x-cohub-source-session",
		"Source Session",
	);
	const turnId = uuidHeader(request, "x-cohub-source-turn", "Source Turn");
	const toolCallId = uuidHeader(
		request,
		"x-cohub-source-tool-call",
		"Source tool call",
	);
	const normalized = await normalizeFileRequest(
		request,
		toolCallId,
		deps.maxBodyBytes ?? 1024 * 1024,
	);

	const me = await cloudJson("/api/me", token, deps);
	const actorUserId = actorIdFromMe(me);
	if (!actorUserId) {
		throw new RelayProtocolError(
			"cloud_authorization_response_invalid",
			"Cloud authorization returned no user identity",
			502,
		);
	}
	if (actorUserId !== deps.ownerUserId.trim()) {
		throw new RelayProtocolError(
			"federated_actor_mismatch",
			"The Cloud execution actor is not authorized for this Local node",
			403,
		);
	}

	const payload = await cloudJson(
		`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
		token,
		deps,
	);
	const session = record(payload.session);
	const turn = record(payload.turn) ?? payload;
	if (
		session?.spaceId !== sourceSpaceId ||
		turn.id !== turnId ||
		turn.userUuid !== actorUserId ||
		typeof turn.status !== "string" ||
		!ACTIVE_TURN_STATUSES.has(turn.status)
	) {
		throw new RelayProtocolError(
			"federated_execution_context_invalid",
			"Federated Local Space access is not bound to the active Cloud turn",
			403,
		);
	}
	if (!hasExplicitLocalMention(turn.userContent, normalized.targetSpaceId)) {
		throw new RelayProtocolError(
			"local_space_not_mentioned",
			"The target Local Space was not explicitly mentioned by this Cloud turn",
			403,
		);
	}

	return {
		actorUserId,
		targetSpaceId: normalized.targetSpaceId,
		sourceSpaceId,
		sessionId,
		turnId,
		toolCallId,
		idempotencyKey: normalized.idempotencyKey,
		request: normalized.request,
	};
}
