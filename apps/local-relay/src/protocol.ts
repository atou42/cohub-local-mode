import {
	TURN_LIFECYCLE_STATUSES,
	type RelayTurnLifecycleEvent,
} from "./activity.ts";

export const RELAY_PROTOCOL_VERSION = 2 as const;

export const ACTIVITY_SPACE_ORIGINS = ["local", "cloud"] as const;
export type ActivitySpaceOrigin = (typeof ACTIVITY_SPACE_ORIGINS)[number];

export type ActivitySpaceReference = {
	spaceId: string;
	origin: ActivitySpaceOrigin;
};

export type ActivityWatchFocus = ActivitySpaceReference & {
	sessionId: string | null;
	explicit: boolean;
};

export type ActivityWatchPreferences = {
	watchedSpaces: ActivitySpaceReference[];
	focus: ActivityWatchFocus | null;
};

export type ActivityWatchReplaceMessage = {
	protocolVersion: typeof RELAY_PROTOCOL_VERSION;
	type: "activity-watch.replace";
	revision: number;
	digest: string;
	ownerUserId: string;
	expiresAt: string;
	leaseExpiresAt: string;
	watchedSpaces: ActivitySpaceReference[];
	focus: ActivityWatchFocus | null;
};

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

export type RelayTurnCompletedEvent = {
	id: string;
	kind: "turn.completed";
	spaceId: string;
	sessionId: string;
	turnId: string;
	completedAt: string;
	turn: Record<string, unknown> | null;
	truncated: boolean;
};

export type RelayTurnEvent = RelayTurnCompletedEvent | RelayTurnLifecycleEvent;

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
		}
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "activity-watch.ack";
			revision: number;
			digest: string;
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
		}
	| ActivityWatchReplaceMessage;

export type RelayBrowserEvent =
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "command.updated";
			command: RelayCommand;
	  }
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "turn.event";
			event: RelayTurnCompletedEvent;
	  }
	| {
			protocolVersion: typeof RELAY_PROTOCOL_VERSION;
			type: "snapshot";
			commands: RelayCommand[];
			events: RelayTurnCompletedEvent[];
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

export function assertRelayOwnerOrigin(input: {
	method: string;
	suffix: string;
	origin: string | null;
	allowedOrigin: string;
}) {
	if (
		(input.method !== "GET" || input.suffix === "/events") &&
		input.origin !== input.allowedOrigin
	) {
		throw new RelayProtocolError(
			"origin_not_allowed",
			"Request origin is not allowed for this relay",
			403,
		);
	}
}

export function browserTurnEvents(
	events: RelayTurnEvent[],
): RelayTurnCompletedEvent[] {
	return events.filter(
		(event): event is RelayTurnCompletedEvent => event.kind === "turn.completed",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expectedKeys: readonly string[],
) {
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	return (
		actualKeys.length === sortedExpectedKeys.length &&
		actualKeys.every((key, index) => key === sortedExpectedKeys[index])
	);
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

export function parseActivityDisplayName(
	value: unknown,
	label: string,
	maxUtf8Bytes: number,
) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new RelayProtocolError("invalid_request", `${label} must be text or null`);
	}
	const normalized = value.trim();
	const hasUnsupportedCharacter = [...normalized].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			(codePoint >= 0xd800 && codePoint <= 0xdfff) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		);
	});
	if (
		!normalized ||
		[...normalized].length > 255 ||
		new TextEncoder().encode(normalized).byteLength > maxUtf8Bytes ||
		hasUnsupportedCharacter
	) {
		throw new RelayProtocolError(
			"invalid_request",
			`${label} contains unsupported characters or exceeds its limit`,
		);
	}
	return normalized;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPACT_OWNER_ID_PATTERN = /^[0-9a-f]{32}$/i;
const PROMPT_PATH_PATTERN = /^\/api\/spaces\/([0-9a-f-]{36})\/prompt$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function parseActivitySpaceOrigin(value: unknown, label: string): ActivitySpaceOrigin {
	if (
		typeof value !== "string" ||
		!ACTIVITY_SPACE_ORIGINS.includes(value as ActivitySpaceOrigin)
	) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			`${label} must be local or cloud`,
		);
	}
	return value as ActivitySpaceOrigin;
}

function parseActivityUuid(value: unknown, label: string) {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			`${label} must be a UUID`,
		);
	}
	return value.toLowerCase();
}

export function parseActivityOwnerUserId(value: unknown) {
	if (
		typeof value !== "string" ||
		(!UUID_PATTERN.test(value) && !COMPACT_OWNER_ID_PATTERN.test(value))
	) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"ownerUserId must be a UUID or a 32-character hex Cohub user ID",
		);
	}
	return value.toLowerCase();
}

function parseActivitySpaceReference(
	value: unknown,
	label: string,
): ActivitySpaceReference {
	if (!isRecord(value) || !hasExactKeys(value, ["spaceId", "origin"])) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			`${label} requires only spaceId and origin`,
		);
	}
	return {
		spaceId: parseActivityUuid(value.spaceId, `${label}.spaceId`),
		origin: parseActivitySpaceOrigin(value.origin, `${label}.origin`),
	};
}

function assertUniqueActivityReferences(
	values: readonly ActivitySpaceReference[],
	label: string,
	key: (value: ActivitySpaceReference) => string = (value) =>
		`${value.origin}:${value.spaceId}`,
) {
	if (new Set(values.map(key)).size !== values.length) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			`${label} must not contain duplicates`,
		);
	}
}

function parseActivityWatchFocus(
	value: unknown,
	label = "focus",
): ActivityWatchFocus | null {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["spaceId", "origin", "sessionId", "explicit"])
	) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			`${label} requires only spaceId, origin, sessionId, and explicit`,
		);
	}
	if (typeof value.explicit !== "boolean") {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			`${label}.explicit must be boolean`,
		);
	}
	return {
		spaceId: parseActivityUuid(value.spaceId, `${label}.spaceId`),
		origin: parseActivitySpaceOrigin(value.origin, `${label}.origin`),
		sessionId:
			value.sessionId === null
				? null
				: parseActivityUuid(value.sessionId, `${label}.sessionId`),
		explicit: value.explicit,
	};
}

export function parseActivityWatchPreferences(
	value: unknown,
): ActivityWatchPreferences {
	if (!isRecord(value) || !hasExactKeys(value, ["watchedSpaces", "focus"])) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"activity watch preferences require only watchedSpaces and focus",
		);
	}
	if (!Array.isArray(value.watchedSpaces) || value.watchedSpaces.length > 3) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"watchedSpaces must contain at most three Spaces",
		);
	}
	const watchedSpaces = value.watchedSpaces.map((item, index) =>
		parseActivitySpaceReference(item, `watchedSpaces[${index}]`),
	);
	assertUniqueActivityReferences(watchedSpaces, "watchedSpaces");

	const focus = parseActivityWatchFocus(value.focus);

	return { watchedSpaces, focus };
}

export function parseActivityWatchReplaceMessage(
	value: unknown,
): ActivityWatchReplaceMessage {
	if (!isRecord(value) || value.protocolVersion !== RELAY_PROTOCOL_VERSION) {
		throw new RelayProtocolError(
			"protocol_mismatch",
			"unsupported relay protocol version",
		);
	}
	if (
		!hasExactKeys(value, [
			"protocolVersion",
			"type",
			"revision",
			"digest",
			"ownerUserId",
			"expiresAt",
			"leaseExpiresAt",
			"watchedSpaces",
			"focus",
		]) ||
		value.type !== "activity-watch.replace"
	) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"activity watch replacement has an invalid shape",
		);
	}
	if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"activity watch revision must be a positive integer",
		);
	}
	const digest =
		typeof value.digest === "string" && SHA256_PATTERN.test(value.digest)
			? value.digest.toLowerCase()
			: null;
	if (!digest) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"activity watch digest must be a SHA-256 hex digest",
		);
	}
	const ownerUserId = parseActivityOwnerUserId(value.ownerUserId);
	const expiresAt = requireString(value.expiresAt, "expiresAt", { maxLength: 64 });
	const leaseExpiresAt = requireString(value.leaseExpiresAt, "leaseExpiresAt", {
		maxLength: 64,
	});
	const expiresAtMs = Date.parse(expiresAt);
	const leaseExpiresAtMs = Date.parse(leaseExpiresAt);
	if (
		!Number.isFinite(expiresAtMs) ||
		!Number.isFinite(leaseExpiresAtMs) ||
		new Date(expiresAtMs).toISOString() !== expiresAt ||
		new Date(leaseExpiresAtMs).toISOString() !== leaseExpiresAt
	) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"activity watch expiry fields must be ISO timestamps",
		);
	}
	if (leaseExpiresAtMs > expiresAtMs) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"activity watch lease cannot outlive its preferences",
		);
	}
	if (!Array.isArray(value.watchedSpaces) || value.watchedSpaces.length > 3) {
		throw new RelayProtocolError(
			"invalid_activity_watch",
			"watchedSpaces must contain at most three Spaces",
		);
	}
	const watchedSpaces = value.watchedSpaces.map((item, index) =>
		parseActivitySpaceReference(item, `watchedSpaces[${index}]`),
	);
	assertUniqueActivityReferences(watchedSpaces, "watchedSpaces");
	const focus = parseActivityWatchFocus(value.focus);
	return {
		protocolVersion: RELAY_PROTOCOL_VERSION,
		type: "activity-watch.replace",
		revision: Number(value.revision),
		digest,
		ownerUserId,
		expiresAt,
		leaseExpiresAt,
		watchedSpaces,
		focus,
	};
}

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
	if (value.kind === "turn.lifecycle") {
		if (
			!hasExactKeys(value, [
				"id",
				"kind",
				"nodeId",
				"origin",
				"spaceId",
				"sessionId",
				"turnId",
				"status",
				"observedAt",
				"spaceName",
				"sessionTitle",
			])
		) {
			throw new RelayProtocolError(
				"invalid_request",
				"turn lifecycle event has an invalid shape",
			);
		}
	} else if (value.kind === "turn.completed") {
		if (
			!hasExactKeys(value, [
				"id",
				"kind",
				"spaceId",
				"sessionId",
				"turnId",
				"completedAt",
				"turn",
				"truncated",
			])
		) {
			throw new RelayProtocolError(
				"invalid_request",
				"turn completion event has an invalid shape",
			);
		}
	}
	const id = requireString(value.id, "event.id", { maxLength: 36 });
	if (!UUID_PATTERN.test(id)) {
		throw new RelayProtocolError("invalid_request", "event.id must be a UUID");
	}
	if (value.kind !== "turn.completed" && value.kind !== "turn.lifecycle") {
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
	for (const [label, identifier] of [
		["event.spaceId", spaceId],
		["event.sessionId", sessionId],
		["event.turnId", turnId],
	] as const) {
		if (!UUID_PATTERN.test(identifier)) {
			throw new RelayProtocolError("invalid_request", `${label} must be a UUID`);
		}
	}
	if (value.kind === "turn.lifecycle") {
		const nodeId = requireString(value.nodeId, "event.nodeId", { maxLength: 100 });
		const origin = parseActivitySpaceOrigin(value.origin, "event.origin");
		const observedAt = requireString(value.observedAt, "event.observedAt", {
			maxLength: 64,
		});
		if (!Number.isFinite(Date.parse(observedAt))) {
			throw new RelayProtocolError(
				"invalid_request",
				"event.observedAt must be an ISO timestamp",
			);
		}
		if (
			typeof value.status !== "string" ||
			!TURN_LIFECYCLE_STATUSES.includes(
				value.status as (typeof TURN_LIFECYCLE_STATUSES)[number],
			)
		) {
			throw new RelayProtocolError(
				"invalid_request",
				"event.status is not an authoritative turn lifecycle status",
			);
		}
		return {
			id,
			kind: "turn.lifecycle",
			nodeId,
			origin,
			spaceId,
			sessionId,
			turnId,
			status: value.status as RelayTurnLifecycleEvent["status"],
			observedAt,
			spaceName: parseActivityDisplayName(value.spaceName, "event.spaceName", 1_020),
			sessionTitle: parseActivityDisplayName(
				value.sessionTitle,
				"event.sessionTitle",
				1_020,
			),
		};
	}
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
		const hasCommandLease =
			typeof value.commandId === "string" || value.attempt !== undefined;
		const expectedKeys = hasCommandLease
			? ["protocolVersion", "type", "commandId", "attempt"]
			: ["protocolVersion", "type"];
		if (!hasExactKeys(value, expectedKeys)) {
			throw new RelayProtocolError(
				"invalid_request",
				"heartbeat has an invalid shape",
			);
		}
		if (hasCommandLease) {
			requireString(value.commandId, "commandId", { maxLength: 128 });
			if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1) {
				throw new RelayProtocolError("invalid_request", "attempt must be positive");
			}
		}
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			...(hasCommandLease
				? { commandId: value.commandId as string, attempt: Number(value.attempt) }
				: {}),
		};
	}
	if (type === "turn-event") {
		if (!hasExactKeys(value, ["protocolVersion", "type", "event"])) {
			throw new RelayProtocolError(
				"invalid_request",
				"turn event message has an invalid shape",
			);
		}
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			event: parseTurnEvent(value.event),
		};
	}
	if (type === "activity-watch.ack") {
		if (
			!hasExactKeys(value, ["protocolVersion", "type", "revision", "digest"])
		) {
			throw new RelayProtocolError(
				"invalid_activity_watch",
				"activity watch acknowledgement has an invalid shape",
			);
		}
		if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
			throw new RelayProtocolError(
				"invalid_activity_watch",
				"activity watch acknowledgement revision must be positive",
			);
		}
		if (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) {
			throw new RelayProtocolError(
				"invalid_activity_watch",
				"activity watch acknowledgement digest must be SHA-256",
			);
		}
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			revision: Number(value.revision),
			digest: value.digest.toLowerCase(),
		};
	}
	const commandId = requireString(value.commandId, "commandId", {
		maxLength: 128,
	});
	if (type === "claim") {
		if (!hasExactKeys(value, ["protocolVersion", "type", "commandId"])) {
			throw new RelayProtocolError("invalid_request", "claim has an invalid shape");
		}
		return { protocolVersion: RELAY_PROTOCOL_VERSION, type, commandId };
	}
	const attempt = value.attempt;
	if (!Number.isInteger(attempt) || Number(attempt) < 1) {
		throw new RelayProtocolError("invalid_request", "attempt must be positive");
	}
	if (type === "started") {
		if (
			!hasExactKeys(value, ["protocolVersion", "type", "commandId", "attempt"])
		) {
			throw new RelayProtocolError("invalid_request", "started has an invalid shape");
		}
		return {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type,
			commandId,
			attempt: Number(attempt),
		};
	}
	if (type === "failed") {
		if (
			!hasExactKeys(value, [
				"protocolVersion",
				"type",
				"commandId",
				"attempt",
				"code",
				"message",
			])
		) {
			throw new RelayProtocolError("invalid_request", "failed has an invalid shape");
		}
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
		if (
			!hasExactKeys(value, [
				"protocolVersion",
				"type",
				"commandId",
				"attempt",
				"result",
			])
		) {
			throw new RelayProtocolError("invalid_request", "result has an invalid shape");
		}
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
