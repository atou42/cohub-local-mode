export const RELAY_PROTOCOL_VERSION = 2 as const;

export function assertRelayAttachmentFresh(
	expiresAt: string,
	nowMs = Date.now(),
) {
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		throw new RelayProtocolError(
			"attachment_state_invalid",
			"Attachment expiry is invalid",
			500,
		);
	}
	if (expiresAtMs <= nowMs) {
		throw new RelayProtocolError("attachment_expired", "Attachment expired", 410);
	}
}

export type RelayCommandStatus =
	| "accepted"
	| "queued"
	| "claimed"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export type RelayHttpRequest = {
	method: "POST";
	path: string;
	headers: Record<string, string>;
	body: string;
};

export type RelayHttpResult = {
	status: number;
	headers: Record<string, string>;
	body: string;
};

export type RelayAttachmentState = "pending" | "ready" | "failed";

export type RelayAttachment = {
	id: string;
	nodeId: string;
	objectKey: string;
	name: string;
	size: number;
	contentType: string;
	sha256: string;
	state: RelayAttachmentState;
	createdAt: string;
	expiresAt: string;
	uploadedAt: string | null;
	errorCode: string | null;
	errorMessage: string | null;
};

export type RelayAttachmentCreateInput = {
	name: string;
	size: number;
	contentType: string;
	sha256: string;
};

export type RelayCommand = {
	id: string;
	nodeId: string;
	sequence: number;
	idempotencyKey: string;
	request: RelayHttpRequest;
	attachments: RelayAttachment[];
	status: RelayCommandStatus;
	attempt: number;
	acceptedAt: string;
	updatedAt: string;
	claimedAt: string | null;
	leaseExpiresAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	result: RelayHttpResult | null;
	errorCode: string | null;
	errorMessage: string | null;
};

export type RelayCommandAccepted = {
	protocolVersion: typeof RELAY_PROTOCOL_VERSION;
	command: RelayCommand;
	deduplicated: boolean;
};

export type RelayWakeupMessage = {
	protocolVersion: typeof RELAY_PROTOCOL_VERSION;
	nodeId: string;
	commandId: string;
};

export type RelayTurnEvent = {
	id: string;
	kind: "turn.completed";
	spaceId: string;
	sessionId: string;
	turnId: string;
	completedAt: string;
	turn: Record<string, unknown> | null;
	truncated: boolean;
};

export type NodeToRelayMessage =
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "claim";
			commandId: string;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "started";
			commandId: string;
			attempt: number;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "result";
			commandId: string;
			attempt: number;
			result: RelayHttpResult;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "failed";
			commandId: string;
			attempt: number;
			code: string;
			message: string;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "heartbeat";
			commandId?: string;
			attempt?: number;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "turn-event";
			event: RelayTurnEvent;
		};

export type RelayToNodeMessage =
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "ready";
			nodeId: string;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "command";
			command: RelayCommand;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "claimed";
			commandId: string;
			attempt: number;
			leaseExpiresAt: string;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "ack";
			commandId: string;
			status: RelayCommandStatus;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "error";
			code: string;
			message: string;
			commandId?: string;
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "turn-event-ack";
			eventId: string;
		};

export type RelayBrowserEvent =
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "command.updated";
			command: RelayCommand;
	  }
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "turn.event";
			event: RelayTurnEvent;
	  }
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "snapshot";
			commands: RelayCommand[];
			events: RelayTurnEvent[];
	  };

export class RelayProtocolError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(
		code: string,
		message: string,
		status = 400,
	) {
		super(message);
		this.name = "RelayProtocolError";
		this.code = code;
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(
	value: unknown,
	label: string,
	options: { maxLength?: number } = {},
) {
	if (typeof value !== "string" || value.length === 0) {
		throw new RelayProtocolError("invalid_request", `${label} is required`);
	}
	if (options.maxLength && value.length > options.maxLength) {
		throw new RelayProtocolError(
			"invalid_request",
			`${label} exceeds ${options.maxLength} characters`,
		);
	}
	return value;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROMPT_PATH_PATTERN = /^\/api\/spaces\/([0-9a-f-]{36})\/prompt$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function validateRelayAttachmentCreateInput(
	value: unknown,
	options: { maxBytes: number },
): RelayAttachmentCreateInput {
	if (!isRecord(value)) {
		throw new RelayProtocolError("invalid_attachment", "attachment body must be an object");
	}
	const name = requireString(value.name, "attachment name", { maxLength: 255 });
	if (
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		/[\0\r\n]/.test(name)
	) {
		throw new RelayProtocolError(
			"invalid_attachment_name",
			"attachment name must be a plain filename",
		);
	}
	const size = value.size;
	if (!Number.isSafeInteger(size) || Number(size) <= 0) {
		throw new RelayProtocolError("invalid_attachment_size", "attachment size must be positive");
	}
	if (Number(size) > options.maxBytes) {
		throw new RelayProtocolError(
			"attachment_too_large",
			"attachment exceeds the relay limit",
			413,
		);
	}
	const contentType = requireString(value.contentType, "attachment contentType", {
		maxLength: 127,
	}).toLowerCase();
	if (!CONTENT_TYPE_PATTERN.test(contentType)) {
		throw new RelayProtocolError(
			"invalid_attachment_type",
			"attachment contentType is invalid",
		);
	}
	const sha256 = requireString(value.sha256, "attachment sha256", {
		maxLength: 64,
	}).toLowerCase();
	if (!SHA256_PATTERN.test(sha256)) {
		throw new RelayProtocolError(
			"invalid_attachment_checksum",
			"attachment sha256 must be a 64-character hex digest",
		);
	}
	return { name, size: Number(size), contentType, sha256 };
}

export function validateRelayCommandInput(
	value: unknown,
	options: { maxBodyBytes: number },
): {
	idempotencyKey: string;
	request: RelayHttpRequest;
	attachmentIds: string[];
} {
	if (!isRecord(value)) {
		throw new RelayProtocolError("invalid_request", "command body must be an object");
	}
	const idempotencyKey = requireString(value.idempotencyKey, "idempotencyKey", {
		maxLength: 128,
	});
	if (!UUID_PATTERN.test(idempotencyKey)) {
		throw new RelayProtocolError(
			"invalid_request",
			"idempotencyKey must be a UUID",
		);
	}
	if (!isRecord(value.request)) {
		throw new RelayProtocolError("invalid_request", "request is required");
	}
	if (value.request.method !== "POST") {
		throw new RelayProtocolError(
			"method_not_allowed",
			"only POST commands are accepted",
			405,
		);
	}
	const path = requireString(value.request.path, "request.path", {
		maxLength: 512,
	});
	const promptMatch = path.match(PROMPT_PATH_PATTERN);
	if (!promptMatch || !UUID_PATTERN.test(promptMatch[1] ?? "")) {
		throw new RelayProtocolError(
			"path_not_allowed",
			"only Local Space prompt commands are accepted",
			403,
		);
	}
	const body = requireString(value.request.body, "request.body");
	if (new TextEncoder().encode(body).byteLength > options.maxBodyBytes) {
		throw new RelayProtocolError(
			"body_too_large",
			"command body exceeds the relay limit",
			413,
		);
	}
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(body);
	} catch {
		throw new RelayProtocolError("invalid_request", "request.body must be JSON");
	}
	if (!isRecord(parsedBody)) {
		throw new RelayProtocolError("invalid_request", "prompt body must be an object");
	}
	if (parsedBody.clientMessageId !== idempotencyKey) {
		throw new RelayProtocolError(
			"idempotency_mismatch",
			"clientMessageId must match idempotencyKey",
		);
	}
	const sessionId = requireString(parsedBody.sessionId, "prompt sessionId", {
		maxLength: 36,
	});
	if (!UUID_PATTERN.test(sessionId)) {
		throw new RelayProtocolError(
			"invalid_request",
			"prompt sessionId must be a UUID",
		);
	}
	if (parsedBody.createSession !== true && parsedBody.createSession !== false) {
		throw new RelayProtocolError(
			"invalid_request",
			"prompt createSession must be explicit",
		);
	}
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-cohub-source-via": "web",
		"x-cohub-relay-command-id": idempotencyKey,
	};
	const rawAttachmentIds = value.attachmentIds ?? [];
	if (
		!Array.isArray(rawAttachmentIds) ||
		rawAttachmentIds.length > 20 ||
		rawAttachmentIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
	) {
		throw new RelayProtocolError(
			"invalid_attachment_refs",
			"attachmentIds must contain at most 20 UUIDs",
		);
	}
	const attachmentIds = [...new Set(rawAttachmentIds as string[])];
	if (attachmentIds.length !== rawAttachmentIds.length) {
		throw new RelayProtocolError(
			"invalid_attachment_refs",
			"attachmentIds must not contain duplicates",
		);
	}
	return {
		idempotencyKey,
		request: { method: "POST", path, headers, body },
		attachmentIds,
	};
}

function parseTurnEvent(value: unknown): RelayTurnEvent {
	if (!isRecord(value)) {
		throw new RelayProtocolError("invalid_request", "event is required");
	}
	const id = requireString(value.id, "event.id", { maxLength: 36 });
	if (!UUID_PATTERN.test(id)) {
		throw new RelayProtocolError("invalid_request", "event.id must be a UUID");
	}
	if (value.kind !== "turn.completed") {
		throw new RelayProtocolError(
			"invalid_request",
			"unsupported turn event kind",
		);
	}
	const spaceId = requireString(value.spaceId, "event.spaceId", { maxLength: 36 });
	const sessionId = requireString(value.sessionId, "event.sessionId", {
		maxLength: 36,
	});
	const turnId = requireString(value.turnId, "event.turnId", { maxLength: 36 });
	const completedAt = requireString(value.completedAt, "event.completedAt", {
		maxLength: 64,
	});
	if (!Number.isFinite(Date.parse(completedAt))) {
		throw new RelayProtocolError(
			"invalid_request",
			"event.completedAt must be an ISO timestamp",
		);
	}
	if (typeof value.truncated !== "boolean") {
		throw new RelayProtocolError(
			"invalid_request",
			"event.truncated must be boolean",
		);
	}
	if (value.turn !== null && !isRecord(value.turn)) {
		throw new RelayProtocolError(
			"invalid_request",
			"event.turn must be an object or null",
		);
	}
	return {
		id,
		kind: "turn.completed",
		spaceId,
		sessionId,
		turnId,
		completedAt,
		turn: value.turn,
		truncated: value.truncated,
	};
}

export function parseNodeMessage(value: unknown): NodeToRelayMessage {
	if (!isRecord(value) || value.protocolVersion !== RELAY_PROTOCOL_VERSION) {
		throw new RelayProtocolError(
			"protocol_mismatch",
			"unsupported relay protocol version",
		);
	}
	const type = requireString(value.type, "message type");
	if (type === "heartbeat") {
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			...(typeof value.commandId === "string"
				? { commandId: value.commandId }
				: {}),
			...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}),
		};
	}
	if (type === "turn-event") {
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			event: parseTurnEvent(value.event),
		};
	}
	const commandId = requireString(value.commandId, "commandId", {
		maxLength: 128,
	});
	if (type === "claim") {
		return { protocolVersion: RELAY_PROTOCOL_VERSION, type, commandId };
	}
	const attempt = value.attempt;
	if (!Number.isInteger(attempt) || Number(attempt) < 1) {
		throw new RelayProtocolError("invalid_request", "attempt must be positive");
	}
	if (type === "started") {
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			commandId,
			attempt: Number(attempt),
		};
	}
	if (type === "failed") {
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			commandId,
			attempt: Number(attempt),
			code: requireString(value.code, "failure code", { maxLength: 100 }),
			message: requireString(value.message, "failure message", {
				maxLength: 2_000,
			}),
		};
	}
	if (type === "result") {
		if (!isRecord(value.result)) {
			throw new RelayProtocolError("invalid_request", "result is required");
		}
		const status = value.result.status;
		if (!Number.isInteger(status) || Number(status) < 100 || Number(status) > 599) {
			throw new RelayProtocolError("invalid_request", "result status is invalid");
		}
		const body = typeof value.result.body === "string" ? value.result.body : "";
		const headers = isRecord(value.result.headers)
			? Object.fromEntries(
					Object.entries(value.result.headers).flatMap(([key, item]) =>
						typeof item === "string" ? [[key.toLowerCase(), item]] : [],
					),
				)
			: {};
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			commandId,
			attempt: Number(attempt),
			result: { status: Number(status), headers, body },
		};
	}
	throw new RelayProtocolError("invalid_request", `unsupported node message: ${type}`);
}
