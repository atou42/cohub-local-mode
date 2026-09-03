import { DurableObject } from "cloudflare:workers";
import { authorizeNodeRequest, authorizeOwnerRequest } from "./auth";
import { handleFederatedApi } from "./federated-handler.ts";
import {
	ACTIVITY_WATCH_LEASE_MS,
	evolveActivityWatchSnapshot,
	isActivityWatchPreferenceExpired,
	publicActivityWatchPreference,
	selectEffectiveActivityWatchPreference,
	upsertActivityWatchPreference,
	type StoredActivityWatchAck,
	type StoredActivityWatchPreference,
	type StoredActivityWatchSnapshot,
} from "./activity-preferences.ts";
import {
	buildActivityStartPushPayload,
	buildActivityPushPayload,
	composeRelayHealth,
	ACTIVITY_LIFECYCLE_TERMINAL_TTL_MS,
	ACTIVITY_OUTBOX_MAX_AGE_MS,
	ACTIVITY_OUTBOX_SENDING_LEASE_MS,
	activityRevocationEpochAfterRemoval,
	currentActivityRevocationEpoch,
	decideActivityOutboxRetry,
	recoverActivitySendingLease,
	isActivityDeliveryRevoked,
	isActivityRegistrationExpired,
	isDeliverableLifecycleProjection,
	parseActivityTokenBody,
	publicActivityRegistration,
	revokedActivityOutboxPatch,
	selectActivityProjection,
	shouldDeleteActivityStartMarker,
	shouldEnqueueActivityStart,
	shouldAcceptLifecycleEvent,
	upsertActivityRegistration,
	validateActivityIdentifier,
	type ActivityRegistrationKind,
	type ActivityPushPayload,
	type RelayTurnLifecycleEvent,
	type StoredActivityRegistration,
} from "./activity.ts";
import {
	ApnsConfigurationError,
	createApnsProviderToken,
	sendActivityPush,
	validateApnsConfig,
	type ApnsConfig,
} from "./apns.ts";
import {
	GC_ALARM_MS,
	TURN_EVENT_MAX_STORED,
	decideCancel,
	decideExpiredCommand,
	guardResultSize,
	isTerminalCommandStatus,
	selectOldestKeysForGc,
	selectSnapshotCommands,
	selectSnapshotEvents,
	selectTerminalCommandsForGc,
} from "./lifecycle";
import {
	assertRelayAttachmentFresh,
	assertRelayOwnerOrigin,
	browserTurnEvents,
	isAlphaLocalApiRequest,
	parseNodeMessage,
	parseActivityWatchPreferences,
	parseActivityOwnerUserId,
	RELAY_EVENT_SCHEMA_VERSION,
	RELAY_PROTOCOL_VERSION,
	RelayProtocolError,
	type RelayBrowserEvent,
	type ActivityWatchPreferences,
	type ActivityWatchReplaceMessage,
	type RelayAttachment,
	type RelayCommand,
	type RelayCommandAccepted,
	type RelayCommandStatus,
	type RelayHttpResult,
	type NodeToRelayMessage,
	type RelayToNodeMessage,
	type RelayTurnEvent,
	type RelayWakeupMessage,
	validateRelayAttachmentCreateInput,
	validateRelayCommandInput,
} from "./protocol";
import {
	bindRelayNodeRequest,
	decideRelayNodeIdentity,
	RELAY_NODE_IDENTITY_HEADER,
	RELAY_NODE_IDENTITY_STORAGE_KEY,
} from "./node-identity.ts";
import {
	alphaProjectionStorageKey,
	createAlphaReadProjection,
	type AlphaReadProjection,
} from "./alpha-projection.ts";
export type RelayAttachmentEnv = {
	ATTACHMENTS: R2Bucket;
	ATTACHMENT_MAX_BYTES: string;
	ATTACHMENT_TTL_MS: string;
};

type RelayEnv = RelayAttachmentEnv & {
	NODES: DurableObjectNamespace<LocalNodeRelay>;
	COMMAND_WAKEUPS: Queue<RelayWakeupMessage>;
	ACTIVITY_PUSHES: Queue<ActivityPushQueueMessage>;
	ALLOWED_ORIGIN: string;
	NODE_ID: string;
	NODE_TOKEN: string;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
	OWNER_EMAIL: string;
	OWNER_USER_ID: string;
	CLOUD_API_ORIGIN: string;
	COMMAND_LEASE_MS: string;
	COMMAND_MAX_BODY_BYTES: string;
	ACTIVITY_STALE_SECONDS: string;
	ACTIVITY_REGISTRATION_TTL_SECONDS: string;
	APNS_TEAM_ID?: string;
	APNS_KEY_ID?: string;
	APNS_PRIVATE_KEY?: string;
	APNS_LIVE_ACTIVITY_TOPIC?: string;
	APNS_LIVE_ACTIVITY_ATTRIBUTES_TYPE?: string;
};

const COMMAND_KEY_PREFIX = "command:";
const COMMAND_ID_PREFIX = "command-id:";
const IDEMPOTENCY_PREFIX = "idempotency:";
const NEXT_SEQUENCE_KEY = "meta:next-sequence";
const NEXT_EVENT_SEQUENCE_KEY = "meta:next-event-sequence";
const ATTACHMENT_KEY_PREFIX = "attachment:";
const TURN_EVENT_KEY_PREFIX = "turnevent:";
const TURN_EVENT_ID_PREFIX = "turnevent-id:";
const ACTIVITY_REGISTRATION_PREFIX = "activity-registration:";
const ACTIVITY_REVOCATION_EPOCH_PREFIX = "activity-revocation-epoch:";
const ACTIVITY_OUTBOX_PREFIX = "activity-outbox:";
const ACTIVITY_REVISION_PREFIX = "activity-revision:";
const TURN_LIFECYCLE_LATEST_PREFIX = "turn-lifecycle-latest:";
const ACTIVITY_DEPLOYMENT_FAILURE_KEY = "meta:activity-deployment-failure";
const ACTIVITY_START_PREFIX = "activity-start:";
const ACTIVITY_PREFERENCE_PREFIX = "activity-preference:";
const ACTIVITY_WATCH_SNAPSHOT_KEY = "meta:activity-watch-snapshot";
const ACTIVITY_WATCH_ACK_KEY = "meta:activity-watch-ack";
const TURN_EVENT_SEEN_PREFIX = "turnevent-seen:";
const CONNECTOR_STATUS_KEY = "meta:connector-status";
const ACTIVITY_OUTBOX_TERMINAL_TTL_MS = 24 * 60 * 60 * 1_000;

type StoredConnectorStatus = {
	state:
		| "signed-out"
		| "initializing"
		| "local-runtime-unavailable"
		| "connecting"
		| "connected"
		| "recovering"
		| "error"
		| "stopped";
	message: string | null;
	attempt: number | null;
	maxAttempts: number | null;
	appVersion: string;
	updatedAt: string;
};

type ActivityPushQueueMessage = {
	kind: "activity-push";
	nodeId: string;
	outboxId: string;
};

type StoredActivityOutbox = {
	// Start pushes are at-most-once after entering sending; update/end pushes
	// recover expired sends and retry with the stable APNs request ID.
	id: string;
	eventId: string;
	registrationId: string;
	registrationEpoch: number;
	payload: ActivityPushPayload;
	revision: number;
	state:
		| "pending"
		| "sending"
		| "delivered"
		| "failed"
		| "invalidated"
		| "cancelled"
		| "dead_letter";
	apnsRequestId: string;
	attempts: number;
	createdAt: string;
	updatedAt: string;
	deliveredAt: string | null;
	lastStatus: number | null;
	lastReason: string | null;
	apnsId: string | null;
	queuedAt: string | null;
	nextAttemptAt: string;
	sendingStartedAt: string | null;
	sendingLeaseExpiresAt: string | null;
	deadLetterCode: string | null;
	enqueueAttempts: number;
};

type ActivityOwnerIdentity = {
	subject: string;
	email: string;
};

type StoredActivityStart = {
	installationId: string;
	activityId: string;
	origin: RelayTurnLifecycleEvent["origin"];
	turnId: string;
	createdAt: string;
};

type StoredRelayAttachment = RelayAttachment & {
	uploadTokenHash: string;
};

function json(value: unknown, status = 200, headers?: HeadersInit) {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			...Object.fromEntries(new Headers(headers)),
		},
	});
}

function errorResponse(error: unknown) {
	if (error instanceof RelayProtocolError) {
		return json({ code: error.code, message: error.message }, error.status);
	}
	console.error("[relay] unhandled request error", error);
	return json(
		{ code: "internal_error", message: "Relay request failed" },
		500,
	);
}

function commandStorageKey(sequence: number, commandId: string) {
	return `${COMMAND_KEY_PREFIX}${String(sequence).padStart(20, "0")}:${commandId}`;
}

function turnEventStorageKey(sequence: number) {
	return `${TURN_EVENT_KEY_PREFIX}${String(sequence).padStart(20, "0")}`;
}

function attachmentStorageKey(attachmentId: string) {
	return `${ATTACHMENT_KEY_PREFIX}${attachmentId}`;
}

function bytesToHex(value: ArrayBuffer | ArrayBufferView) {
	const bytes = value instanceof ArrayBuffer
		? new Uint8Array(value)
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function sha256Text(value: string) {
	return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function publicAttachment(value: StoredRelayAttachment): RelayAttachment {
	const { uploadTokenHash: _uploadTokenHash, ...attachment } = value;
	return attachment;
}

function parseJsonBody<T = unknown>(request: Request): Promise<T> {
	return request.json().catch(() => {
		throw new RelayProtocolError("invalid_json", "request body must be valid JSON");
	}) as Promise<T>;
}

function isTerminal(status: RelayCommandStatus) {
	return isTerminalCommandStatus(status);
}

function parsePositiveInteger(value: string, label: string) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
}

function apnsConfig(
	env: RelayEnv,
	environment: ApnsConfig["environment"],
) {
	return validateApnsConfig({
		teamId: env.APNS_TEAM_ID,
		keyId: env.APNS_KEY_ID,
		privateKey: env.APNS_PRIVATE_KEY,
		environment,
		topic: env.APNS_LIVE_ACTIVITY_TOPIC,
		attributesType: env.APNS_LIVE_ACTIVITY_ATTRIBUTES_TYPE,
	});
}

function activityOutboxStorageKey(outboxId: string) {
	return `${ACTIVITY_OUTBOX_PREFIX}${outboxId}`;
}

function activityRevocationEpochStorageKey(installationId: string) {
	return `${ACTIVITY_REVOCATION_EPOCH_PREFIX}${installationId}`;
}

function activityRegistrationStorageKey(
	ownerDigest: string,
	kind: ActivityRegistrationKind,
	installationId: string,
	activityId: string | null,
) {
	return `${ACTIVITY_REGISTRATION_PREFIX}${ownerDigest}:${kind}:${installationId}:${activityId ?? "device"}`;
}

function activityPreferenceStorageKey(
	ownerDigest: string,
	installationId: string,
) {
	return `${ACTIVITY_PREFERENCE_PREFIX}${ownerDigest}:${installationId}`;
}

function activityWatchMessage(
	snapshot: StoredActivityWatchSnapshot,
): ActivityWatchReplaceMessage {
	return {
		protocolVersion: snapshot.protocolVersion,
		type: snapshot.type,
		revision: snapshot.revision,
		digest: snapshot.digest,
		ownerUserId: snapshot.ownerUserId,
		expiresAt: snapshot.expiresAt,
		leaseExpiresAt: snapshot.leaseExpiresAt,
		watchedSpaces: snapshot.watchedSpaces,
		focus: snapshot.focus,
	};
}

function relayOwnerIdentity(payload: { sub?: unknown; email?: unknown }) {
	const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
	const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
	if (!subject || !email) {
		throw new RelayProtocolError(
			"access_identity_invalid",
			"Cloudflare Access subject and email are required",
			403,
		);
	}
	return { subject, email } satisfies ActivityOwnerIdentity;
}

function websocketPair() {
	const pair = new WebSocketPair();
	return {
		client: pair[0],
		server: pair[1],
	};
}

function websocketResponse(client: WebSocket, protocol?: string | null) {
	return new Response(null, {
		status: 101,
		webSocket: client,
		...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}),
	});
}

function parseJsonMessage(message: string | ArrayBuffer) {
	const text = typeof message === "string" ? message : new TextDecoder().decode(message);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new RelayProtocolError("invalid_json", "node message must be valid JSON");
	}
}

function sendSocket(socket: WebSocket, message: RelayToNodeMessage | RelayBrowserEvent) {
	try {
		socket.send(JSON.stringify(message));
		return true;
	} catch {
		return false;
	}
}

export class LocalNodeRelay extends DurableObject<RelayEnv> {
	private readonly leaseMs: number;
	private boundNodeId: string | null = null;
	private apnsProviderToken: { value: string; issuedAtMs: number } | null = null;

	constructor(state: DurableObjectState, env: RelayEnv) {
		super(state, env);
		this.leaseMs = parsePositiveInteger(env.COMMAND_LEASE_MS, "COMMAND_LEASE_MS");
	}

	async fetch(request: Request) {
		try {
			await this.resolveNodeId(request);
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/internal/node") {
				return this.connectNode(request);
			}
			if (request.method === "GET" && url.pathname === "/internal/events") {
				return await this.connectBrowser(request);
			}
			if (request.method === "POST" && url.pathname === "/internal/commands") {
				return await this.createCommand(request);
			}
			if (request.method === "GET" && url.pathname === "/internal/status") {
				return this.getStatus();
			}
			if (request.method === "POST" && url.pathname === "/internal/connector-status") {
				return await this.putConnectorStatus(request);
			}
			if (request.method === "GET" && url.pathname === "/internal/projection") {
				return this.getAlphaProjection(url.searchParams.get("path") ?? "");
			}
			if (request.method === "POST" && url.pathname === "/internal/attachments") {
				return await this.createAttachment(request);
			}
			if (request.method === "POST" && url.pathname === "/internal/wake") {
				await this.dispatchNext();
				return json({ ok: true });
			}
			if (request.method === "POST" && url.pathname === "/internal/revoke") {
				for (const socket of this.ctx.getWebSockets()) {
					socket.close(1008, "Personal Node credential revoked");
				}
				return json({ ok: true });
			}
			if (request.method === "GET" && url.pathname === "/internal/activity-health") {
				return this.getActivityHealth();
			}
			if (request.method === "PUT" && url.pathname === "/internal/activity-registration") {
				return await this.putActivityRegistration(request);
			}
			if (request.method === "DELETE" && url.pathname === "/internal/activity-registration") {
				return await this.deleteActivityRegistration(request);
			}
			if (request.method === "PUT" && url.pathname === "/internal/activity-preference") {
				return await this.putActivityPreference(request);
			}
			if (request.method === "DELETE" && url.pathname === "/internal/activity-preference") {
				return await this.deleteActivityPreference(request);
			}
			const activityPushMatch = url.pathname.match(
				/^\/internal\/activity-push\/([^/]+)$/,
			);
			if (request.method === "POST" && activityPushMatch?.[1]) {
				return await this.deliverActivityOutbox(
					decodeURIComponent(activityPushMatch[1]),
				);
			}
			const commandCancelMatch = url.pathname.match(
				/^\/internal\/commands\/([^/]+)\/cancel$/,
			);
			if (request.method === "POST" && commandCancelMatch?.[1]) {
				return this.cancelCommand(decodeURIComponent(commandCancelMatch[1]));
			}
			const commandMatch = url.pathname.match(/^\/internal\/commands\/([^/]+)$/);
			if (request.method === "GET" && commandMatch?.[1]) {
				const command = await this.getCommandById(decodeURIComponent(commandMatch[1]));
				return command
					? json({ command })
					: json({ code: "command_not_found", message: "Command not found" }, 404);
			}
			const attachmentMatch = url.pathname.match(
				/^\/internal\/attachments\/([^/]+)(\/(authorize-upload|complete))?$/,
			);
			if (attachmentMatch?.[1]) {
				const attachmentId = decodeURIComponent(attachmentMatch[1]);
				if (request.method === "GET" && !attachmentMatch[2]) {
					return this.getAttachmentResponse(attachmentId);
				}
				if (request.method === "POST" && attachmentMatch[3] === "authorize-upload") {
					return this.authorizeAttachmentUpload(attachmentId, request);
				}
				if (request.method === "POST" && attachmentMatch[3] === "complete") {
					return this.completeAttachment(attachmentId, request);
				}
			}
			return json({ code: "not_found", message: "Relay route not found" }, 404);
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async resolveNodeId(request?: Request) {
		const requested = request?.headers.get(RELAY_NODE_IDENTITY_HEADER) ?? null;
		if (this.boundNodeId) {
			return decideRelayNodeIdentity({
				stored: this.boundNodeId,
				requested,
				configured: this.env.NODE_ID,
			}).nodeId;
		}
		const stored =
			(await this.ctx.storage.get<string>(RELAY_NODE_IDENTITY_STORAGE_KEY)) ?? null;
		const decision = decideRelayNodeIdentity({
			stored,
			requested,
			configured: this.env.NODE_ID,
		});
		if (decision.shouldPersist) {
			await this.ctx.storage.put(RELAY_NODE_IDENTITY_STORAGE_KEY, decision.nodeId);
		}
		this.boundNodeId = decision.nodeId;
		return decision.nodeId;
	}

	private async getStatus() {
		const nodeId = await this.resolveNodeId();
		const connector =
			(await this.ctx.storage.get<StoredConnectorStatus>(CONNECTOR_STATUS_KEY)) ?? null;
		const active = (await this.listCommands()).find(
			(command) => command.status === "claimed" || command.status === "running",
		);
		return json({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			nodeId,
			connected: this.ctx.getWebSockets("node").length > 0,
			activeCommandId: active?.id ?? null,
			activeCommandStatus: active?.status ?? null,
			connector,
		});
	}

	private async putConnectorStatus(request: Request) {
		const payload = await request.json().catch(() => null);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new RelayProtocolError(
				"connector_status_invalid",
				"Connector status must be a JSON object",
			);
		}
		const state = Reflect.get(payload, "state");
		if (
			typeof state !== "string" ||
			![
				"signed-out",
				"initializing",
				"local-runtime-unavailable",
				"connecting",
				"connected",
				"recovering",
				"error",
				"stopped",
			].includes(state)
		) {
			throw new RelayProtocolError(
				"connector_status_invalid",
				"Connector status has an invalid state",
			);
		}
		const rawMessage = Reflect.get(payload, "message");
		if (
			rawMessage !== null &&
			(typeof rawMessage !== "string" || rawMessage.length > 2_048)
		) {
			throw new RelayProtocolError(
				"connector_status_invalid",
				"Connector status has an invalid message",
			);
		}
		const optionalInteger = (field: string) => {
			const value = Reflect.get(payload, field);
			if (value === undefined || value === null) return null;
			if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) {
				throw new RelayProtocolError(
					"connector_status_invalid",
					`Connector status has an invalid ${field}`,
				);
			}
			return Number(value);
		};
		const appVersion = Reflect.get(payload, "appVersion");
		if (
			typeof appVersion !== "string" ||
			!appVersion.trim() ||
			appVersion.length > 64 ||
			/[\r\n\0]/.test(appVersion)
		) {
			throw new RelayProtocolError(
				"connector_status_invalid",
				"Connector status has an invalid appVersion",
			);
		}
		const connector: StoredConnectorStatus = {
			state: state as StoredConnectorStatus["state"],
			message: rawMessage as string | null,
			attempt: optionalInteger("attempt"),
			maxAttempts: optionalInteger("maxAttempts"),
			appVersion: appVersion.trim(),
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(CONNECTOR_STATUS_KEY, connector);
		return json({ ok: true, connector });
	}

	private async getAlphaProjection(path: string) {
		if (!isAlphaLocalApiRequest("GET", path)) {
			throw new RelayProtocolError(
				"path_not_allowed",
				"Local API route is not available through Personal Node Alpha",
				403,
			);
		}
		const projection = await this.ctx.storage.get<AlphaReadProjection>(
			alphaProjectionStorageKey(path),
		);
		return projection
			? json({ projection })
			: json(
					{ code: "alpha_projection_not_found", message: "Cached Local API response not found" },
					404,
				);
	}

	private async createAttachment(request: Request) {
		const nodeId = await this.resolveNodeId(request);
		const input = validateRelayAttachmentCreateInput(await parseJsonBody(request), {
			maxBytes: parsePositiveInteger(
				this.env.ATTACHMENT_MAX_BYTES,
				"ATTACHMENT_MAX_BYTES",
			),
		});
		const id = crypto.randomUUID();
		const uploadToken = randomToken();
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		const attachment: StoredRelayAttachment = {
			id,
			nodeId,
			objectKey: `nodes/${nodeId}/attachments/${id}`,
			...input,
			state: "pending",
			createdAt: now,
			expiresAt: new Date(
				nowMs + parsePositiveInteger(this.env.ATTACHMENT_TTL_MS, "ATTACHMENT_TTL_MS"),
			).toISOString(),
			uploadedAt: null,
			errorCode: null,
			errorMessage: null,
			uploadTokenHash: await sha256Text(uploadToken),
		};
		await this.ctx.storage.put(attachmentStorageKey(id), attachment);
		return json({ attachment: publicAttachment(attachment), uploadToken }, 201);
	}

	private async getAttachment(attachmentId: string) {
		return (
			(await this.ctx.storage.get<StoredRelayAttachment>(
				attachmentStorageKey(attachmentId),
			)) ?? null
		);
	}

	private async getAttachmentResponse(attachmentId: string) {
		const attachment = await this.getAttachment(attachmentId);
		if (!attachment) {
			return json({ code: "attachment_not_found", message: "Attachment not found" }, 404);
		}
		return json({ attachment: publicAttachment(attachment) });
	}

	private async authorizeAttachmentUpload(attachmentId: string, request: Request) {
		const body = await parseJsonBody<{
			token?: unknown;
			size?: unknown;
			contentType?: unknown;
			sha256?: unknown;
		}>(request);
		const attachment = await this.getAttachment(attachmentId);
		if (!attachment) {
			return json({ code: "attachment_not_found", message: "Attachment not found" }, 404);
		}
		assertRelayAttachmentFresh(attachment.expiresAt);
		if (attachment.state === "ready") {
			return json({ attachment: publicAttachment(attachment), alreadyUploaded: true });
		}
		if (
			typeof body.token !== "string" ||
			(await sha256Text(body.token)) !== attachment.uploadTokenHash
		) {
			throw new RelayProtocolError("attachment_token_invalid", "Attachment upload token is invalid", 403);
		}
		if (
			body.size !== attachment.size ||
			body.contentType !== attachment.contentType ||
			body.sha256 !== attachment.sha256
		) {
			throw new RelayProtocolError(
				"attachment_identity_mismatch",
				"Attachment upload does not match its declared identity",
				409,
			);
		}
		return json({ attachment: publicAttachment(attachment), alreadyUploaded: false });
	}

	private async completeAttachment(attachmentId: string, request: Request) {
		const body = await parseJsonBody<{
			size?: unknown;
			contentType?: unknown;
			sha256?: unknown;
			objectKey?: unknown;
		}>(request);
		const attachment = await this.getAttachment(attachmentId);
		if (!attachment) {
			return json({ code: "attachment_not_found", message: "Attachment not found" }, 404);
		}
		if (
			body.objectKey !== attachment.objectKey ||
			body.size !== attachment.size ||
			body.contentType !== attachment.contentType ||
			body.sha256 !== attachment.sha256
		) {
			throw new RelayProtocolError(
				"attachment_verification_failed",
				"Stored attachment failed identity verification",
				409,
			);
		}
		const now = new Date().toISOString();
		const ready: StoredRelayAttachment = {
			...attachment,
			state: "ready",
			uploadedAt: attachment.uploadedAt ?? now,
			errorCode: null,
			errorMessage: null,
		};
		await this.ctx.storage.put(attachmentStorageKey(attachment.id), ready);
		return json({ attachment: publicAttachment(ready) });
	}

	private async activityRegistrationKey(input: {
		identity: ActivityOwnerIdentity;
		kind: ActivityRegistrationKind;
		installationId: string;
		activityId: string | null;
	}) {
		return activityRegistrationStorageKey(
			await sha256Text(input.identity.subject),
			input.kind,
			input.installationId,
			input.activityId,
		);
	}

	private async activityPreferenceKey(input: {
		identity: ActivityOwnerIdentity;
		installationId: string;
	}) {
		return activityPreferenceStorageKey(
			await sha256Text(input.identity.subject),
			input.installationId,
		);
	}

	private async putActivityPreference(request: Request) {
		const nodeId = await this.resolveNodeId(request);
		const body = await parseJsonBody<{
			identity?: ActivityOwnerIdentity;
			ownerUserId?: string;
			installationId?: string;
			preferences?: ActivityWatchPreferences;
		}>(request);
		if (
			!body.identity?.subject ||
			!body.identity.email ||
			!body.ownerUserId ||
			!body.installationId ||
			!body.preferences
		) {
			throw new RelayProtocolError(
				"invalid_activity_watch",
				"internal activity watch preference is invalid",
			);
		}
		const identity = body.identity;
		const rawOwnerUserId = body.ownerUserId;
		const rawInstallationId = body.installationId;
		const preferences = body.preferences;
		const ownerUserId = parseActivityOwnerUserId(rawOwnerUserId);
		if (ownerUserId !== parseActivityOwnerUserId(this.env.OWNER_USER_ID)) {
			throw new RelayProtocolError(
				"activity_watch_owner_mismatch",
				"Activity watch owner does not match the configured owner",
				403,
			);
		}
		const installationId = validateActivityIdentifier(
			rawInstallationId,
			"installation ID",
		);
		const key = await this.activityPreferenceKey({
			identity,
			installationId,
		});
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		const expiresAt = new Date(
			nowMs +
				parsePositiveInteger(
					this.env.ACTIVITY_REGISTRATION_TTL_SECONDS,
					"ACTIVITY_REGISTRATION_TTL_SECONDS",
				) *
					1_000,
		).toISOString();
		const result = await this.ctx.storage.transaction(async (storage) => {
			const existing =
				(await storage.get<StoredActivityWatchPreference>(key)) ?? null;
			const preference = await upsertActivityWatchPreference({
				existing,
				nodeId,
				installationId,
				ownerSubject: identity.subject,
				ownerEmail: identity.email,
				ownerUserId,
				preferences,
				now,
				expiresAt,
			});
			await storage.put(key, preference);
			return { preference, created: existing === null };
		});
		await this.reconcileActivityWatch({ forceSend: true, nowMs });
		await this.scheduleNextAlarm(nowMs);
		return json(
			{ preference: publicActivityWatchPreference(result.preference) },
			result.created ? 201 : 200,
		);
	}

	private async deleteActivityPreference(request: Request) {
		const body = await parseJsonBody<{
			identity?: ActivityOwnerIdentity;
			installationId?: string;
		}>(request);
		if (!body.identity?.subject || !body.identity.email || !body.installationId) {
			throw new RelayProtocolError(
				"invalid_activity_watch",
				"internal activity watch preference deletion is invalid",
			);
		}
		const identity = body.identity;
		const installationId = validateActivityIdentifier(
			body.installationId,
			"installation ID",
		);
		const key = await this.activityPreferenceKey({
			identity,
			installationId,
		});
		await this.ctx.storage.delete(key);
		const nowMs = Date.now();
		await this.reconcileActivityWatch({ forceSend: true, nowMs });
		await this.scheduleNextAlarm(nowMs);
		return new Response(null, { status: 204 });
	}

	private async listActivityPreferences() {
		return this.ctx.storage.list<StoredActivityWatchPreference>({
			prefix: ACTIVITY_PREFERENCE_PREFIX,
		});
	}

	private async effectiveActivityPreference(nowMs = Date.now()) {
		return selectEffectiveActivityWatchPreference(
			(await this.listActivityPreferences()).values(),
			nowMs,
		);
	}

	private async reconcileActivityWatch(input: {
		forceSend?: boolean;
		socket?: WebSocket;
		nowMs?: number;
	} = {}) {
		const nowMs = input.nowMs ?? Date.now();
		const result = await this.ctx.storage.transaction(async (storage) => {
			const records = await storage.list<StoredActivityWatchPreference>({
				prefix: ACTIVITY_PREFERENCE_PREFIX,
			});
			for (const [key, preference] of records) {
				if (isActivityWatchPreferenceExpired(preference, nowMs)) {
					await storage.delete(key);
				}
			}
			const effective = selectEffectiveActivityWatchPreference(
				records.values(),
				nowMs,
			);
			const current =
				(await storage.get<StoredActivityWatchSnapshot>(
					ACTIVITY_WATCH_SNAPSHOT_KEY,
				)) ?? null;
			const next = await evolveActivityWatchSnapshot({
				current,
				effective,
				ownerUserId: parseActivityOwnerUserId(this.env.OWNER_USER_ID),
				nowMs,
			});
			const changed =
				!current ||
				current.revision !== next.revision ||
				current.digest !== next.digest;
			await storage.put(ACTIVITY_WATCH_SNAPSHOT_KEY, next);
			if (changed) await storage.delete(ACTIVITY_WATCH_ACK_KEY);
			return { next, changed };
		});
		if (input.forceSend || result.changed || input.socket) {
			const sockets = input.socket
				? [input.socket]
				: this.ctx.getWebSockets("node");
			for (const socket of sockets) {
				sendSocket(socket, activityWatchMessage(result.next));
			}
		}
		return result.next;
	}

	private async acceptActivityWatchAck(
		socket: WebSocket,
		ack: Extract<NodeToRelayMessage, { type: "activity-watch.ack" }>,
	) {
		const current = await this.ctx.storage.get<StoredActivityWatchSnapshot>(
			ACTIVITY_WATCH_SNAPSHOT_KEY,
		);
		if (
			!current ||
			current.revision !== ack.revision ||
			current.digest !== ack.digest
		) {
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "error",
				code: "activity_watch_ack_mismatch",
				message: "Activity watch acknowledgement does not match the current snapshot",
			});
			await this.reconcileActivityWatch({ forceSend: true, socket });
			return;
		}
		await this.ctx.storage.put(ACTIVITY_WATCH_ACK_KEY, {
			revision: ack.revision,
			digest: ack.digest,
			ackedAt: new Date().toISOString(),
		} satisfies StoredActivityWatchAck);
	}

	private async putActivityRegistration(request: Request) {
		const nodeId = await this.resolveNodeId(request);
		const body = await parseJsonBody<{
			identity?: ActivityOwnerIdentity;
			kind?: ActivityRegistrationKind;
			installationId?: string;
			activityId?: string | null;
			registration?: ReturnType<typeof parseActivityTokenBody>;
		}>(request);
		if (
			!body.identity?.subject ||
			!body.identity.email ||
			(body.kind !== "device" && body.kind !== "activity") ||
			!body.installationId ||
			!body.registration?.token
		) {
			throw new RelayProtocolError(
				"invalid_activity_registration",
				"internal activity registration is invalid",
			);
		}
		const identity = body.identity;
		const kind = body.kind;
		const registrationInput = body.registration;
		const installationId = validateActivityIdentifier(
			body.installationId,
			"installation ID",
		);
		const activityId = kind === "activity"
			? validateActivityIdentifier(body.activityId ?? "", "activity ID")
			: null;
		const key = await this.activityRegistrationKey({
			identity,
			kind,
			installationId,
			activityId,
		});
		const now = new Date().toISOString();
		const expiresAt = new Date(
			Date.now() +
				parsePositiveInteger(
					this.env.ACTIVITY_REGISTRATION_TTL_SECONDS,
					"ACTIVITY_REGISTRATION_TTL_SECONDS",
				) * 1_000,
		).toISOString();
		const result = await this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<StoredActivityRegistration>(key);
			const epochKey = activityRevocationEpochStorageKey(installationId);
			const revocationEpoch = currentActivityRevocationEpoch(
				await storage.get<unknown>(epochKey),
			);
			const registration = await upsertActivityRegistration({
				existing: existing ?? null,
				id: crypto.randomUUID(),
				revocationEpoch,
				kind,
				nodeId,
				ownerSubject: identity.subject,
				ownerEmail: identity.email,
				installationId,
				activityId,
				environment: registrationInput.environment,
				token: registrationInput.token,
				now,
				expiresAt,
			});
			await storage.put({
				[key]: registration,
				[epochKey]: revocationEpoch,
			});
			return { existing: existing ?? null, registration };
		});
		const { existing, registration } = result;
		const changed =
			!existing ||
			existing.token !== registration.token ||
			existing.environment !== registration.environment ||
			existing.revocationEpoch !== registration.revocationEpoch;
		if (registration.kind === "activity" && changed) {
			await this.enqueueRegistrationRefresh(registration);
		}
		return json(
			{ registration: publicActivityRegistration(registration) },
			existing ? 200 : 201,
		);
	}

	private async enqueueRegistrationRefresh(
		registration: StoredActivityRegistration,
	) {
		const preference = await this.effectiveActivityPreference();
		if (!preference) return;
		const lifecycleRecords = await this.ctx.storage.list<RelayTurnLifecycleEvent>({
			prefix: TURN_LIFECYCLE_LATEST_PREFIX,
		});
		const events = [...lifecycleRecords.values()];
		const triggeringEvent = events.sort(
			(left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt),
		)[0];
		if (!triggeringEvent) return;
		const projection = selectActivityProjection(
			preference.preferences,
			events,
			triggeringEvent,
		);
		if (!projection) return;
		if (!isDeliverableLifecycleProjection(projection.event)) {
			await this.ctx.storage.put(ACTIVITY_DEPLOYMENT_FAILURE_KEY, {
				code: "activity_projection_incomplete",
				observedAt: new Date().toISOString(),
			});
			return;
		}
		const eventId = crypto.randomUUID();
		const enqueued = await this.ctx.storage.transaction(async (storage) => {
			const currentEpoch = currentActivityRevocationEpoch(
				await storage.get<unknown>(
					activityRevocationEpochStorageKey(registration.installationId),
				),
			);
			if (
				isActivityDeliveryRevoked({
					registrationEpoch: registration.revocationEpoch,
					outboxEpoch: registration.revocationEpoch,
					currentEpoch,
				})
			) {
				return false;
			}
			const revisionKey = `${ACTIVITY_REVISION_PREFIX}${registration.installationId}`;
			const revision = ((await storage.get<number>(revisionKey)) ?? 0) + 1;
			const now = new Date().toISOString();
			const outboxId = crypto.randomUUID();
			await storage.put({
				[revisionKey]: revision,
				[activityOutboxStorageKey(outboxId)]: {
					id: outboxId,
					eventId,
					registrationId: registration.id,
					registrationEpoch: registration.revocationEpoch,
					payload: buildActivityPushPayload(
						projection.event,
						revision,
						parsePositiveInteger(
							this.env.ACTIVITY_STALE_SECONDS,
							"ACTIVITY_STALE_SECONDS",
						),
						projection.otherActiveCount,
					),
					revision,
					state: "pending",
					apnsRequestId: crypto.randomUUID(),
					attempts: 0,
					createdAt: now,
					updatedAt: now,
					deliveredAt: null,
					lastStatus: null,
					lastReason: null,
					apnsId: null,
					queuedAt: null,
					nextAttemptAt: now,
					sendingStartedAt: null,
					sendingLeaseExpiresAt: null,
					deadLetterCode: null,
					enqueueAttempts: 0,
				} satisfies StoredActivityOutbox,
			});
			return true;
		});
		if (enqueued) await this.enqueuePendingActivityOutboxes(eventId);
	}

	private async deleteActivityRegistration(request: Request) {
		const body = await parseJsonBody<{
			identity?: ActivityOwnerIdentity;
			kind?: ActivityRegistrationKind;
			installationId?: string;
			activityId?: string | null;
		}>(request);
		if (
			!body.identity?.subject ||
			!body.identity.email ||
			(body.kind !== "device" && body.kind !== "activity") ||
			!body.installationId
		) {
			throw new RelayProtocolError(
				"invalid_activity_registration",
				"internal activity registration deletion is invalid",
			);
		}
		const installationId = validateActivityIdentifier(
			body.installationId,
			"installation ID",
		);
		const activityId = body.kind === "activity"
			? validateActivityIdentifier(body.activityId ?? "", "activity ID")
			: null;
		const key = await this.activityRegistrationKey({
			identity: body.identity,
			kind: body.kind,
			installationId,
			activityId,
		});
		await this.revokeActivityRegistration({
			key,
			kind: body.kind,
			installationId,
			activityId,
			nowMs: Date.now(),
			reason: "Activity registration revoked",
		});
		return new Response(null, { status: 204 });
	}

	private async revokeActivityRegistration(input: {
		key: string;
		kind: ActivityRegistrationKind;
		installationId: string;
		activityId: string | null;
		nowMs: number;
		reason: string;
		expectedRegistrationId?: string;
		expectedToken?: string;
	}) {
		await this.ctx.storage.transaction(async (storage) => {
			const existing = await storage.get<StoredActivityRegistration>(input.key);
			if (
				existing &&
				(existing.kind !== input.kind ||
					existing.installationId !== input.installationId ||
					existing.activityId !== input.activityId)
			) {
				throw new Error("activity registration storage key does not match its value");
			}
			if (
				input.expectedRegistrationId !== undefined &&
				(!existing ||
					existing.id !== input.expectedRegistrationId ||
					existing.token !== input.expectedToken)
			) {
				return;
			}
			const startKey = `${ACTIVITY_START_PREFIX}${input.installationId}`;
			const [registrations, outboxes, activeStart] = await Promise.all([
				storage.list<StoredActivityRegistration>({
					prefix: ACTIVITY_REGISTRATION_PREFIX,
				}),
				storage.list<StoredActivityOutbox>({ prefix: ACTIVITY_OUTBOX_PREFIX }),
				storage.get<StoredActivityStart>(startKey),
			]);
			const revokedRegistrationIds = new Set<string>();
			if (input.kind === "device") {
				for (const registration of registrations.values()) {
					if (registration.installationId === input.installationId) {
						revokedRegistrationIds.add(registration.id);
					}
				}
			}
			if (existing) revokedRegistrationIds.add(existing.id);
			const now = new Date(input.nowMs).toISOString();
			const writes: Record<string, unknown> = {};
			if (input.kind === "device") {
				const epochKey = activityRevocationEpochStorageKey(input.installationId);
				writes[epochKey] = activityRevocationEpochAfterRemoval(
					input.kind,
					await storage.get<unknown>(epochKey),
				);
			}
			for (const [outboxKey, outbox] of outboxes) {
				const patch = revokedActivityOutboxPatch(
					outbox,
					revokedRegistrationIds,
					now,
					input.reason,
				);
				if (patch) writes[outboxKey] = { ...outbox, ...patch };
			}
			if (Object.keys(writes).length > 0) await storage.put(writes);
			const revokedActivityIds = new Set<string>();
			if (input.activityId) revokedActivityIds.add(input.activityId);
			const deletes = [input.key];
			if (
				shouldDeleteActivityStartMarker({
					deviceRevoked: input.kind === "device",
					storedActivityId: activeStart?.activityId,
					revokedActivityIds,
				})
			) {
				deletes.push(startKey);
			}
			await storage.delete(deletes);
		});
	}

	private async getActivityHealth() {
		await this.gcExpiredActivityRegistrations(Date.now());
		const deploymentFailure = await this.ctx.storage.get<{
			code?: string;
			observedAt: string;
		}>(ACTIVITY_DEPLOYMENT_FAILURE_KEY);
		return deploymentFailure
			? json({
					status: "error",
					code: deploymentFailure.code ?? "apns_deployment_failure",
					observedAt: deploymentFailure.observedAt,
				})
			: json({ status: "ready" });
	}

	private async currentApnsProviderToken(config: ApnsConfig) {
		const nowMs = Date.now();
		if (
			this.apnsProviderToken &&
			nowMs - this.apnsProviderToken.issuedAtMs < 50 * 60 * 1_000
		) {
			return this.apnsProviderToken.value;
		}
		const value = await createApnsProviderToken(config, nowMs);
		this.apnsProviderToken = { value, issuedAtMs: nowMs };
		return value;
	}

	private async findActivityRegistrationForOutbox(
		outbox: StoredActivityOutbox,
		nowMs = Date.now(),
	) {
		const registrations = await this.ctx.storage.list<StoredActivityRegistration>({
			prefix: ACTIVITY_REGISTRATION_PREFIX,
		});
		const entry = [...registrations.entries()].find(
			([, registration]) => registration.id === outbox.registrationId,
		) ?? null;
		if (!entry) return null;
		if (isActivityRegistrationExpired(entry[1], nowMs)) {
			await this.gcExpiredActivityRegistrations(nowMs);
			return null;
		}
		const currentEpoch = currentActivityRevocationEpoch(
			await this.ctx.storage.get<unknown>(
				activityRevocationEpochStorageKey(entry[1].installationId),
			),
		);
		if (
			isActivityDeliveryRevoked({
				registrationEpoch: entry[1].revocationEpoch,
				outboxEpoch: outbox.registrationEpoch,
				currentEpoch,
			})
		) {
			return null;
		}
		return entry;
	}

	private async cancelRevokedActivityOutbox(
		key: string,
		outbox: StoredActivityOutbox,
		nowMs: number,
	) {
		const stored = await this.ctx.storage.get<StoredActivityOutbox>(key);
		if (!stored) {
			throw new Error(`activity outbox disappeared during revocation: ${outbox.id}`);
		}
		if (stored.state === "cancelled") return stored;
		const patch = revokedActivityOutboxPatch(
			stored,
			new Set([stored.registrationId]),
			new Date(nowMs).toISOString(),
			"Activity registration is missing or revoked",
		);
		if (!patch) return stored;
		const cancelled: StoredActivityOutbox = { ...stored, ...patch };
		await this.ctx.storage.put(key, cancelled);
		return cancelled;
	}

	private async deliverActivityOutbox(outboxId: string) {
		const key = activityOutboxStorageKey(outboxId);
		let outbox = await this.ctx.storage.get<StoredActivityOutbox>(key);
		if (!outbox) {
			return json({ code: "activity_outbox_not_found", message: "Activity outbox not found" }, 404);
		}
		const nowMs = Date.now();
		if (
			(outbox.state === "pending" || outbox.state === "sending") &&
			!(await this.findActivityRegistrationForOutbox(outbox, nowMs))
		) {
			await this.cancelRevokedActivityOutbox(key, outbox, nowMs);
			return json({ outboxId, state: "cancelled" });
		}
		if (outbox.state === "sending") {
			const leaseExpiresAtMs = Date.parse(outbox.sendingLeaseExpiresAt ?? "");
			if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs) {
				return json({ outboxId, state: "sending" }, 202);
			}
			if (recoverActivitySendingLease(outbox.payload.aps.event) === "dead_letter") {
				outbox = await this.deadLetterActivityOutbox(
					key,
					outbox,
					"apns_start_delivery_unknown",
				);
				return json({ outboxId, state: outbox.state });
			}
			const recovered = await this.retryActivityOutbox(
				key,
				outbox,
				nowMs,
				null,
				"apns_sending_lease_expired",
			);
			return json({ outboxId, state: recovered.state });
		}
		if (outbox.state !== "pending") return json({ outboxId, state: outbox.state });
		if (Date.parse(outbox.nextAttemptAt) > nowMs) {
			return json({ outboxId, state: "pending", nextAttemptAt: outbox.nextAttemptAt }, 202);
		}
		const registrationEntry = await this.findActivityRegistrationForOutbox(
			outbox,
			nowMs,
		);
		if (!registrationEntry) {
			await this.cancelRevokedActivityOutbox(key, outbox, nowMs);
			return json({ outboxId, state: "cancelled" });
		}
		const [, registration] = registrationEntry;
		let config: ApnsConfig;
		try {
			config = apnsConfig(this.env, registration.environment);
		} catch (error) {
			if (error instanceof ApnsConfigurationError) {
				const nextAttemptAt = new Date(nowMs + 5 * 60 * 1_000).toISOString();
				await this.ctx.storage.put({
					[key]: {
						...outbox,
						queuedAt: null,
						nextAttemptAt,
						updatedAt: new Date(nowMs).toISOString(),
						lastReason: "APNs configuration is unavailable",
					},
					[ACTIVITY_DEPLOYMENT_FAILURE_KEY]: {
						code: "apns_configuration_error",
						observedAt: new Date(nowMs).toISOString(),
					},
				});
				await this.scheduleNextAlarm(nowMs);
				return json({
					code: "apns_configuration_error",
					message: error.message,
					nextAttemptAt,
				}, 503);
			}
			throw error;
		}
		const sending: StoredActivityOutbox = {
			...outbox,
			state: "sending",
			attempts: outbox.attempts + 1,
			queuedAt: null,
			sendingStartedAt: new Date(nowMs).toISOString(),
			sendingLeaseExpiresAt: new Date(
				nowMs + ACTIVITY_OUTBOX_SENDING_LEASE_MS,
			).toISOString(),
			updatedAt: new Date(nowMs).toISOString(),
		};
		await this.ctx.storage.put(key, sending);
		await this.scheduleNextAlarm(nowMs);
		const providerToken = await this.currentApnsProviderToken(config);
		const deliveryRegistrationEntry = await this.findActivityRegistrationForOutbox(
			sending,
			Date.now(),
		);
		if (!deliveryRegistrationEntry) {
			await this.cancelRevokedActivityOutbox(key, sending, Date.now());
			return json({ outboxId, state: "cancelled" });
		}
		const [, deliveryRegistration] = deliveryRegistrationEntry;
		config = apnsConfig(this.env, deliveryRegistration.environment);
		let result: Awaited<ReturnType<typeof sendActivityPush>>;
		try {
			result = await sendActivityPush({
				config,
				deviceToken: deliveryRegistration.token,
				payload: sending.payload,
				providerToken,
				apnsRequestId: sending.apnsRequestId,
			});
		} catch {
			if (!(await this.findActivityRegistrationForOutbox(sending, Date.now()))) {
				await this.cancelRevokedActivityOutbox(key, sending, Date.now());
				return json({ outboxId, state: "cancelled" });
			}
			if (sending.payload.aps.event === "start") {
				const dead = await this.deadLetterActivityOutbox(
					key,
					sending,
					"apns_start_delivery_unknown",
				);
				return json({ outboxId, state: dead.state });
			}
			const retry = await this.retryActivityOutbox(
				key,
				sending,
				nowMs,
				null,
				"apns_delivery_unknown",
			);
			return json({ outboxId, state: retry.state, nextAttemptAt: retry.nextAttemptAt });
		}
		if (!(await this.findActivityRegistrationForOutbox(sending, Date.now()))) {
			await this.cancelRevokedActivityOutbox(key, sending, Date.now());
			return json({ outboxId, state: "cancelled" });
		}
		const now = new Date(nowMs).toISOString();
		if (result.disposition === "retry") {
			if (sending.payload.aps.event === "start" && result.status >= 500) {
				const dead = await this.deadLetterActivityOutbox(
					key,
					sending,
					"apns_start_delivery_unknown",
				);
				return json({ outboxId, state: dead.state });
			}
			const retry = await this.retryActivityOutbox(
				key,
				{ ...sending, lastStatus: result.status, apnsId: result.apnsId },
				nowMs,
				result.retryAfterMs,
				result.reason ?? "apns_retryable",
			);
			return json({ outboxId, state: retry.state, nextAttemptAt: retry.nextAttemptAt });
		}
		let state: StoredActivityOutbox["state"] = "failed";
		if (result.disposition === "delivered") state = "delivered";
		if (result.disposition === "invalidate_registration") state = "invalidated";
		await this.ctx.storage.put(key, {
			...sending,
			state,
			updatedAt: now,
			deliveredAt: state === "delivered" ? now : null,
			lastStatus: result.status,
			lastReason: result.reason,
			apnsId: result.apnsId,
			sendingStartedAt: null,
			sendingLeaseExpiresAt: null,
		});
		if (result.disposition === "invalidate_registration") {
			await this.revokeActivityRegistration({
				key: deliveryRegistrationEntry[0],
				kind: deliveryRegistration.kind,
				installationId: deliveryRegistration.installationId,
				activityId: deliveryRegistration.activityId,
				nowMs: Date.now(),
				reason: "APNs invalidated the activity registration",
				expectedRegistrationId: deliveryRegistration.id,
				expectedToken: deliveryRegistration.token,
			});
		}
		if (result.disposition === "deployment_failure") {
			await this.ctx.storage.put(ACTIVITY_DEPLOYMENT_FAILURE_KEY, {
				code: "apns_deployment_failure",
				status: result.status,
				reason: result.reason,
				observedAt: now,
			});
			console.error("[relay] APNs deployment authorization failed", {
				status: result.status,
				reason: result.reason,
				outboxId,
			});
		}
		if (result.disposition === "permanent_failure") {
			await this.ctx.storage.put(ACTIVITY_DEPLOYMENT_FAILURE_KEY, {
				code: "apns_permanent_failure",
				status: result.status,
				reason: result.reason,
				observedAt: now,
			});
		}
		if (result.disposition === "delivered") {
			const failure = await this.ctx.storage.get<{ code?: string }>(
				ACTIVITY_DEPLOYMENT_FAILURE_KEY,
			);
			if (
				failure?.code === "apns_deployment_failure" ||
				failure?.code === "apns_configuration_error" ||
				failure?.code === "activity_projection_incomplete"
			) {
				await this.ctx.storage.delete(ACTIVITY_DEPLOYMENT_FAILURE_KEY);
			}
		}
		return json({ outboxId, state, status: result.status });
	}

	private async retryActivityOutbox(
		key: string,
		outbox: StoredActivityOutbox,
		nowMs: number,
		retryAfterMs: number | null,
		reason: string,
	) {
		const decision = decideActivityOutboxRetry({
			attempts: outbox.attempts,
			createdAtMs: Date.parse(outbox.createdAt),
			nowMs,
			retryAfterMs,
		});
		if (decision.action === "dead_letter") {
			return this.deadLetterActivityOutbox(
				key,
				outbox,
				"apns_retry_exhausted",
			);
		}
		const retry: StoredActivityOutbox = {
			...outbox,
			state: "pending",
			queuedAt: null,
			nextAttemptAt: decision.nextAttemptAt,
			updatedAt: new Date(nowMs).toISOString(),
			lastReason: reason,
			sendingStartedAt: null,
			sendingLeaseExpiresAt: null,
		};
		await this.ctx.storage.put(key, retry);
		await this.scheduleNextAlarm(nowMs);
		return retry;
	}

	private async deadLetterActivityOutbox(
		key: string,
		outbox: StoredActivityOutbox,
		code: string,
	) {
		const now = new Date().toISOString();
		const dead: StoredActivityOutbox = {
			...outbox,
			state: "dead_letter",
			updatedAt: now,
			queuedAt: null,
			sendingStartedAt: null,
			sendingLeaseExpiresAt: null,
			deadLetterCode: code,
		};
		await this.ctx.storage.put({
			[key]: dead,
			[ACTIVITY_DEPLOYMENT_FAILURE_KEY]: {
				code,
				observedAt: now,
			},
		});
		console.error("[relay] activity push moved to dead letter", {
			outboxId: outbox.id,
			code,
		});
		return dead;
	}

	private async connectNode(request: Request) {
		const nodeId = await this.resolveNodeId(request);
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new RelayProtocolError(
				"upgrade_required",
				"node connection requires WebSocket",
				426,
			);
		}
		for (const existing of this.ctx.getWebSockets("node")) {
			existing.close(1012, "replaced by a newer node connection");
		}
		const { client, server } = websocketPair();
		this.ctx.acceptWebSocket(server, ["node"]);
		sendSocket(server, {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "ready",
			nodeId,
			eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
		});
		this.ctx.waitUntil(
			Promise.all([
				this.scheduleNextAlarm(),
				this.dispatchNext(),
				this.reconcileActivityWatch({ forceSend: true, socket: server }),
			]),
		);
		return websocketResponse(client);
	}

	private async connectBrowser(request: Request) {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new RelayProtocolError(
				"upgrade_required",
				"event connection requires WebSocket",
				426,
			);
		}
		const { client, server } = websocketPair();
		this.ctx.acceptWebSocket(server, ["browser"]);
		sendSocket(server, {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "snapshot",
			commands: selectSnapshotCommands(await this.listCommands()),
			events: selectSnapshotEvents(await this.listBrowserTurnEvents()),
		});
		const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.map((value) => value.trim());
		return websocketResponse(
			client,
			protocols.includes("cohub-alpha-v1") ? "cohub-alpha-v1" : null,
		);
	}

	private async createCommand(request: Request) {
		const nodeId = await this.resolveNodeId(request);
		const input = validateRelayCommandInput(await request.json(), {
			maxBodyBytes: parsePositiveInteger(
				this.env.COMMAND_MAX_BODY_BYTES,
				"COMMAND_MAX_BODY_BYTES",
			),
		});
		const attachments: RelayAttachment[] = [];
		for (const attachmentId of input.attachmentIds) {
			const stored = await this.getAttachment(attachmentId);
			if (!stored) {
				throw new RelayProtocolError(
					"attachment_not_found",
					`Attachment not found: ${attachmentId}`,
					404,
				);
			}
			if (stored.state !== "ready") {
				throw new RelayProtocolError(
					"attachment_not_ready",
					`Attachment is not ready: ${attachmentId}`,
					409,
				);
			}
			if (new Date(stored.expiresAt).getTime() <= Date.now()) {
				throw new RelayProtocolError(
					"attachment_expired",
					`Attachment expired: ${attachmentId}`,
					410,
				);
			}
			attachments.push(publicAttachment(stored));
		}
		const accepted = await this.ctx.storage.transaction(async (storage) => {
			const existingKey = await storage.get<string>(
				`${IDEMPOTENCY_PREFIX}${input.idempotencyKey}`,
			);
			if (existingKey) {
				const existing = await storage.get<RelayCommand>(existingKey);
				if (!existing) {
					throw new Error("relay idempotency index points to a missing command");
				}
				if (
					existing.request.method !== input.request.method ||
					existing.request.path !== input.request.path ||
					existing.request.body !== input.request.body ||
					(existing.attachments ?? []).map((item) => item.id).join(",") !==
						attachments.map((item) => item.id).join(",")
				) {
					throw new RelayProtocolError(
						"idempotency_conflict",
						"Idempotency key is already bound to a different command",
						409,
					);
				}
				return { command: existing, deduplicated: true };
			}
			const sequence = (await storage.get<number>(NEXT_SEQUENCE_KEY)) ?? 1;
			const id = crypto.randomUUID();
			const now = new Date().toISOString();
			const command: RelayCommand = {
				id,
				nodeId,
				sequence,
				idempotencyKey: input.idempotencyKey,
				request: input.request,
				attachments,
				status: "queued",
				attempt: 0,
				acceptedAt: now,
				updatedAt: now,
				claimedAt: null,
				leaseExpiresAt: null,
				startedAt: null,
				completedAt: null,
				result: null,
				errorCode: null,
				errorMessage: null,
			};
			const key = commandStorageKey(sequence, id);
			await storage.put({
				[NEXT_SEQUENCE_KEY]: sequence + 1,
				[key]: command,
				[`${COMMAND_ID_PREFIX}${id}`]: key,
				[`${IDEMPOTENCY_PREFIX}${input.idempotencyKey}`]: key,
			});
			return { command, deduplicated: false };
		});
		if (!accepted.deduplicated) {
			this.broadcast(accepted.command);
			this.ctx.waitUntil(
				Promise.all([
					this.env.COMMAND_WAKEUPS.send({
						protocolVersion: RELAY_PROTOCOL_VERSION,
						nodeId,
						commandId: accepted.command.id,
					}).catch((error) => {
						console.error("[relay] queue wakeup enqueue failed", error);
					}),
					this.dispatchNext(),
					this.ensurePeriodicAlarm(),
				]),
			);
		} else {
			this.ctx.waitUntil(
				Promise.all([this.dispatchNext(), this.ensurePeriodicAlarm()]),
			);
		}
		return json(
			{
				protocolVersion: RELAY_PROTOCOL_VERSION,
				...accepted,
			} satisfies RelayCommandAccepted,
			202,
		);
	}

	private async getCommandById(commandId: string) {
		const key = await this.ctx.storage.get<string>(`${COMMAND_ID_PREFIX}${commandId}`);
		return key ? (await this.ctx.storage.get<RelayCommand>(key)) ?? null : null;
	}

	private async putCommand(command: RelayCommand) {
		const key = await this.ctx.storage.get<string>(`${COMMAND_ID_PREFIX}${command.id}`);
		if (!key) throw new Error(`missing relay command index: ${command.id}`);
		await this.ctx.storage.put(key, command);
		this.broadcast(command);
	}

	private broadcast(command: RelayCommand) {
		const event: RelayBrowserEvent = {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "command.updated",
			command,
		};
		for (const socket of this.ctx.getWebSockets("browser")) {
			sendSocket(socket, event);
		}
	}

	private async listCommands() {
		const records = await this.ctx.storage.list<RelayCommand>({
			prefix: COMMAND_KEY_PREFIX,
		});
		return [...records.values()];
	}

	private async requeueExpired(nowMs = Date.now()) {
		for (const command of await this.listCommands()) {
			const decision = decideExpiredCommand(command, nowMs);
			if (decision.action === "keep") continue;
			const now = new Date(nowMs).toISOString();
			if (decision.action === "fail") {
				await this.putCommand({
					...command,
					status: "failed",
					updatedAt: now,
					completedAt: now,
					leaseExpiresAt: null,
					errorCode: decision.errorCode,
					errorMessage: decision.errorMessage,
				});
				this.ctx.waitUntil(this.collectGarbage(nowMs));
				continue;
			}
			await this.putCommand({
				...command,
				status: "queued",
				updatedAt: now,
				claimedAt: null,
				leaseExpiresAt: null,
				startedAt: null,
				errorCode: "lease_expired",
				errorMessage: "Node execution lease expired; command was requeued",
			});
		}
	}

	private async dispatchNext() {
		await this.requeueExpired();
		const sockets = this.ctx.getWebSockets("node");
		const socket = sockets[0];
		if (!socket) return;
		const commands = await this.listCommands();
		if (commands.some((command) => command.status === "claimed" || command.status === "running")) {
			return;
		}
		const next = commands.find((command) => command.status === "queued");
		if (!next) return;
		sendSocket(socket, {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "command",
			command: next,
		});
	}

	async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
		if (!this.ctx.getTags(socket).includes("node")) return;
		let parsed: NodeToRelayMessage;
		try {
			parsed = parseNodeMessage(parseJsonMessage(raw));
		} catch (error) {
			const protocolError =
				error instanceof RelayProtocolError
					? error
					: new RelayProtocolError("invalid_message", "node message is invalid");
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "error",
				code: protocolError.code,
				message: protocolError.message,
			});
			return;
		}
		if (parsed.type === "heartbeat") {
			if (parsed.commandId && parsed.attempt) {
				await this.extendLease(parsed.commandId, parsed.attempt);
			}
			return;
		}
		if (parsed.type === "turn-event") {
			await this.acceptTurnEvent(socket, parsed.event);
			return;
		}
		if (parsed.type === "activity-watch.ack") {
			await this.acceptActivityWatchAck(socket, parsed);
			return;
		}
		const command = await this.getCommandById(parsed.commandId);
		if (!command) {
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "error",
				code: "command_not_found",
				message: "Command not found",
				commandId: parsed.commandId,
			});
			return;
		}
		if (parsed.type === "claim") {
			if (isTerminal(command.status)) {
				sendSocket(socket, {
					protocolVersion: RELAY_PROTOCOL_VERSION,
					type: "ack",
					commandId: command.id,
					status: command.status,
				});
				return;
			}
			if (command.status !== "queued") {
				sendSocket(socket, {
					protocolVersion: RELAY_PROTOCOL_VERSION,
					type: "error",
					code: "command_already_claimed",
					message: "Command already has an active lease",
					commandId: command.id,
				});
				return;
			}
			const nowMs = Date.now();
			const claimed: RelayCommand = {
				...command,
				status: "claimed",
				attempt: command.attempt + 1,
				claimedAt: new Date(nowMs).toISOString(),
				leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
				updatedAt: new Date(nowMs).toISOString(),
				errorCode: null,
				errorMessage: null,
			};
			await this.putCommand(claimed);
			await this.ctx.storage.setAlarm(nowMs + this.leaseMs);
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "claimed",
				commandId: claimed.id,
				attempt: claimed.attempt,
				leaseExpiresAt: claimed.leaseExpiresAt ?? "",
			});
			return;
		}
		if (parsed.attempt !== command.attempt) {
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "error",
				code: "stale_attempt",
				message: "Command attempt is no longer active",
				commandId: command.id,
			});
			// The node drops its stale state on this error; redeliver whatever is
			// queued so a requeued command is not stranded until the next alarm.
			await this.dispatchNext();
			return;
		}
		if (parsed.type === "started") {
			if (isTerminal(command.status)) {
				sendSocket(socket, {
					protocolVersion: RELAY_PROTOCOL_VERSION,
					type: "ack",
					commandId: command.id,
					status: command.status,
				});
				return;
			}
			// A matching attempt on a "queued" command means the lease expired while
			// the node was disconnected but still executing; resume that lease
			// instead of rejecting, so the in-flight work is not lost.
			const nowMs = Date.now();
			const running: RelayCommand = {
				...command,
				status: "running",
				claimedAt: command.claimedAt ?? new Date(nowMs).toISOString(),
				startedAt: command.startedAt ?? new Date(nowMs).toISOString(),
				updatedAt: new Date(nowMs).toISOString(),
				leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
				errorCode: null,
				errorMessage: null,
			};
			await this.putCommand(running);
			await this.ctx.storage.setAlarm(nowMs + this.leaseMs);
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "ack",
				commandId: running.id,
				status: running.status,
			});
			return;
		}
		if (isTerminal(command.status)) {
			// Duplicate or post-cancellation outcome: acknowledge idempotently so
			// the node stops resending instead of failing with a silent throw.
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "ack",
				commandId: command.id,
				status: command.status,
			});
			return;
		}
		// "queued" with a matching attempt is the disconnect-requeue race: the
		// node finished the work it started under this attempt, so accept it.
		const now = new Date().toISOString();
		let result: RelayHttpResult | null = null;
		let status: RelayCommandStatus;
		let errorCode: string | null = null;
		let errorMessage: string | null = null;
		if (parsed.type === "result") {
			result = guardResultSize(parsed.result);
			status = parsed.result.status >= 200 && parsed.result.status < 300 ? "succeeded" : "failed";
			if (status === "failed") {
				errorCode = "local_api_rejected";
				errorMessage = `Local API returned HTTP ${parsed.result.status}`;
			}
		} else {
			status = "failed";
			errorCode = parsed.code;
			errorMessage = parsed.message;
		}
		const completed: RelayCommand = {
			...command,
			status,
			result,
			errorCode,
			errorMessage,
			completedAt: now,
			updatedAt: now,
			leaseExpiresAt: null,
		};
		await this.putCommand(completed);
		const projection = createAlphaReadProjection(completed, now);
		if (projection) {
			await this.ctx.storage.put(
				alphaProjectionStorageKey(projection.path),
				projection,
			);
		}
		sendSocket(socket, {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "ack",
			commandId: completed.id,
			status: completed.status,
		});
		this.ctx.waitUntil(this.collectGarbage(Date.now()));
		await this.dispatchNext();
		await this.scheduleNextAlarm();
	}

	private async extendLease(commandId: string, attempt: number) {
		const command = await this.getCommandById(commandId);
		if (
			!command ||
			command.attempt !== attempt ||
			(command.status !== "claimed" && command.status !== "running")
		) {
			return;
		}
		const nowMs = Date.now();
		await this.putCommand({
			...command,
			updatedAt: new Date(nowMs).toISOString(),
			leaseExpiresAt: new Date(nowMs + this.leaseMs).toISOString(),
		});
		await this.ctx.storage.setAlarm(nowMs + this.leaseMs);
	}

	async webSocketClose() {
		// Active work keeps its lease. Alarm-based recovery avoids executing the
		// same prompt twice merely because a WebSocket briefly disconnected.
	}

	async webSocketError(_socket: WebSocket, error: unknown) {
		console.error("[relay] node websocket error", error);
	}

	async alarm() {
		const nowMs = Date.now();
		await this.requeueExpired(nowMs);
		await this.dispatchNext();
		await this.recoverExpiredActivitySends(nowMs);
		await this.enqueuePendingActivityOutboxes();
		await this.collectGarbage(nowMs);
		await this.reconcileActivityWatch({ forceSend: true, nowMs });
		await this.scheduleNextAlarm(nowMs);
	}

	private async recoverExpiredActivitySends(nowMs: number) {
		const records = await this.ctx.storage.list<StoredActivityOutbox>({
			prefix: ACTIVITY_OUTBOX_PREFIX,
		});
		for (const outbox of records.values()) {
			if (
				outbox.state === "sending" &&
				Date.parse(outbox.sendingLeaseExpiresAt ?? "") <= nowMs
			) {
				await this.deliverActivityOutbox(outbox.id);
			}
		}
	}

	private async cancelCommand(commandId: string) {
		const command = await this.getCommandById(commandId);
		if (!command) {
			return json({ code: "command_not_found", message: "Command not found" }, 404);
		}
		const decision = decideCancel(command);
		if (decision.action === "conflict") {
			return json({ code: "command_active", message: "Command is actively leased" }, 409);
		}
		if (decision.action === "noop") {
			return json({ command });
		}
		const now = new Date().toISOString();
		const cancelled: RelayCommand = {
			...command,
			status: "cancelled",
			completedAt: now,
			updatedAt: now,
			errorCode: "cancelled_by_user",
			errorMessage: "Command cancelled by user",
			leaseExpiresAt: null,
		};
		await this.putCommand(cancelled);
		this.ctx.waitUntil(this.collectGarbage(Date.now()));
		return json({ command: cancelled });
	}

	private async acceptTurnEvent(socket: WebSocket, event: RelayTurnEvent) {
		const nodeId = await this.resolveNodeId();
		const [existingKey, seen] = await Promise.all([
			this.ctx.storage.get<string>(`${TURN_EVENT_ID_PREFIX}${event.id}`),
			this.ctx.storage.get<{ seenAt: string }>(`${TURN_EVENT_SEEN_PREFIX}${event.id}`),
		]);
		if (existingKey || seen) {
			if (event.kind === "turn.lifecycle") {
				await this.enqueuePendingActivityOutboxes(event.id);
			}
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "turn-event-ack",
				eventId: event.id,
			});
			return;
		}
		if (event.kind === "turn.lifecycle" && event.nodeId !== nodeId) {
			throw new RelayProtocolError(
				"node_identity_mismatch",
				"Turn lifecycle event node does not match the fixed relay node",
				403,
			);
		}
		const accepted = await this.ctx.storage.transaction(async (storage) => {
			const sequence = (await storage.get<number>(NEXT_EVENT_SEQUENCE_KEY)) ?? 1;
			const key = turnEventStorageKey(sequence);
			const seenAt = new Date().toISOString();
			const writes: Record<string, unknown> = {
				[NEXT_EVENT_SEQUENCE_KEY]: sequence + 1,
				[key]: event,
				[`${TURN_EVENT_ID_PREFIX}${event.id}`]: key,
				[`${TURN_EVENT_SEEN_PREFIX}${event.id}`]: { seenAt },
			};
			if (event.kind === "turn.lifecycle") {
				const latestLifecycleKey = `${TURN_LIFECYCLE_LATEST_PREFIX}${event.origin}:${event.turnId}`;
				const latestForTurn = await storage.get<RelayTurnLifecycleEvent>(
					latestLifecycleKey,
				);
				if (!shouldAcceptLifecycleEvent(latestForTurn ?? null, event)) {
					await storage.put(writes);
					return false;
				}
				writes[latestLifecycleKey] = event;
				if (!isDeliverableLifecycleProjection(event)) {
					writes[ACTIVITY_DEPLOYMENT_FAILURE_KEY] = {
						code: "activity_projection_incomplete",
						observedAt: seenAt,
					};
				}
				const [registrationRecords, lifecycleRecords, preferenceRecords] = await Promise.all([
					storage.list<StoredActivityRegistration>({
						prefix: ACTIVITY_REGISTRATION_PREFIX,
					}),
					storage.list<RelayTurnLifecycleEvent>({
						prefix: TURN_LIFECYCLE_LATEST_PREFIX,
					}),
					storage.list<StoredActivityWatchPreference>({
						prefix: ACTIVITY_PREFERENCE_PREFIX,
					}),
				]);
				const lifecycleEvents = [...lifecycleRecords.values()].filter(
					(item) =>
						item.origin !== event.origin || item.turnId !== event.turnId,
				);
				lifecycleEvents.push(event);
					const registrations: StoredActivityRegistration[] = [];
					for (const registration of registrationRecords.values()) {
						if (isActivityRegistrationExpired(registration)) continue;
						const currentEpoch = currentActivityRevocationEpoch(
							await storage.get<unknown>(
								activityRevocationEpochStorageKey(registration.installationId),
							),
						);
						if (
							isActivityDeliveryRevoked({
								registrationEpoch: registration.revocationEpoch,
								outboxEpoch: registration.revocationEpoch,
								currentEpoch,
							})
						) {
							continue;
						}
						registrations.push(registration);
					}
				const effectivePreference = selectEffectiveActivityWatchPreference(
					preferenceRecords.values(),
				);
				if (effectivePreference) {
					for (const registration of registrations) {
					const projection = selectActivityProjection(
						effectivePreference.preferences,
						lifecycleEvents,
						event,
					);
					if (!projection) continue;
					if (!isDeliverableLifecycleProjection(projection.event)) continue;
					const hasActivityRegistration = registrations.some(
						(item) =>
							item.kind === "activity" &&
							item.installationId === registration.installationId,
					);
					const startKey = `${ACTIVITY_START_PREFIX}${registration.installationId}`;
					const activeStart = await storage.get<StoredActivityStart>(startKey);
					if (
						registration.kind === "device" &&
						!shouldEnqueueActivityStart({
							hasActivityRegistration,
							hasActiveStart: Boolean(activeStart),
							status: projection.event.status,
						})
					) {
						continue;
					}
					if (registration.kind === "activity" && registration.activityId === null) {
						continue;
					}
					const revisionKey = `${ACTIVITY_REVISION_PREFIX}${registration.installationId}`;
					const revision = ((await storage.get<number>(revisionKey)) ?? 0) + 1;
					const outboxId = crypto.randomUUID();
					const now = new Date().toISOString();
					const startActivityId = crypto.randomUUID();
					const payload = registration.kind === "device"
						? buildActivityStartPushPayload({
								event: projection.event,
								revision,
								staleSeconds: parsePositiveInteger(
									this.env.ACTIVITY_STALE_SECONDS,
									"ACTIVITY_STALE_SECONDS",
								),
								otherActiveCount: projection.otherActiveCount,
								attributesType: this.env.APNS_LIVE_ACTIVITY_ATTRIBUTES_TYPE ?? "",
								installationId: registration.installationId,
								activityId: startActivityId,
							})
						: buildActivityPushPayload(
								projection.event,
								revision,
								parsePositiveInteger(
									this.env.ACTIVITY_STALE_SECONDS,
									"ACTIVITY_STALE_SECONDS",
								),
								projection.otherActiveCount,
							);
					const outbox: StoredActivityOutbox = {
							id: outboxId,
							eventId: event.id,
							registrationId: registration.id,
							registrationEpoch: registration.revocationEpoch,
						payload,
						revision,
						state: "pending",
						apnsRequestId: crypto.randomUUID(),
						attempts: 0,
						createdAt: now,
						updatedAt: now,
						deliveredAt: null,
						lastStatus: null,
						lastReason: null,
						apnsId: null,
						queuedAt: null,
						nextAttemptAt: now,
						sendingStartedAt: null,
						sendingLeaseExpiresAt: null,
						deadLetterCode: null,
						enqueueAttempts: 0,
					};
					writes[revisionKey] = revision;
					writes[activityOutboxStorageKey(outboxId)] = outbox;
						if (registration.kind === "device") {
							writes[startKey] = {
								installationId: registration.installationId,
								activityId: startActivityId,
								origin: projection.event.origin,
								turnId: projection.event.turnId,
								createdAt: now,
							} satisfies StoredActivityStart;
						}
					}
				}
				if (
					event.status === "completed" ||
					event.status === "failed" ||
					event.status === "interrupted" ||
					event.status === "merged" ||
					event.status === "cancelled"
				) {
					const starts = await storage.list<StoredActivityStart>({
						prefix: ACTIVITY_START_PREFIX,
					});
					for (const [startKey, start] of starts) {
						if (
							start.origin === event.origin &&
							start.turnId === event.turnId
						) {
							await storage.delete(startKey);
						}
					}
				}
			}
			await storage.put(writes);
			return true;
		});
		if (!accepted) {
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "turn-event-ack",
				eventId: event.id,
			});
			await this.gcTurnEvents();
			return;
		}
		if (event.kind === "turn.completed") {
			const browserEvent: RelayBrowserEvent = {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "turn.event",
				event,
			};
			for (const browserSocket of this.ctx.getWebSockets("browser")) {
				sendSocket(browserSocket, browserEvent);
			}
		}
		sendSocket(socket, {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event-ack",
			eventId: event.id,
		});
		if (event.kind === "turn.lifecycle") {
			await this.enqueuePendingActivityOutboxes(event.id);
		}
		await this.gcTurnEvents();
	}

	private async enqueuePendingActivityOutboxes(eventId?: string) {
		const nodeId = await this.resolveNodeId();
		const records = await this.ctx.storage.list<StoredActivityOutbox>({
			prefix: ACTIVITY_OUTBOX_PREFIX,
		});
		const nowMs = Date.now();
		for (const [key, outbox] of records) {
			if (
				outbox.state !== "pending" ||
				(eventId !== undefined && outbox.eventId !== eventId) ||
				Date.parse(outbox.nextAttemptAt) > nowMs ||
				(eventId === undefined && outbox.queuedAt !== null)
			) {
				continue;
			}
			try {
				await this.env.ACTIVITY_PUSHES.send({
					kind: "activity-push",
					nodeId,
					outboxId: outbox.id,
				});
				await this.ctx.storage.put(key, {
					...outbox,
					queuedAt: new Date(nowMs).toISOString(),
					updatedAt: new Date(nowMs).toISOString(),
				});
			} catch (error) {
				const enqueueAttempts = outbox.enqueueAttempts + 1;
				const decision = decideActivityOutboxRetry({
					attempts: enqueueAttempts,
					createdAtMs: Date.parse(outbox.createdAt),
					nowMs,
					retryAfterMs: null,
				});
				if (decision.action === "dead_letter") {
					await this.deadLetterActivityOutbox(
						key,
						{ ...outbox, enqueueAttempts },
						"activity_queue_enqueue_exhausted",
					);
					continue;
				}
				await this.ctx.storage.put(key, {
					...outbox,
					enqueueAttempts,
					queuedAt: null,
					nextAttemptAt: decision.nextAttemptAt,
					updatedAt: new Date(nowMs).toISOString(),
					lastReason: "Activity push queue enqueue failed",
				});
				console.error("[relay] activity push enqueue failed", {
					outboxId: outbox.id,
					error,
				});
			}
		}
		await this.scheduleNextAlarm(nowMs);
	}

	private async listTurnEvents() {
		const records = await this.ctx.storage.list<RelayTurnEvent>({
			prefix: TURN_EVENT_KEY_PREFIX,
		});
		return [...records.values()];
	}

	private async listBrowserTurnEvents() {
		return browserTurnEvents(await this.listTurnEvents());
	}

	private async ensurePeriodicAlarm() {
		if ((await this.ctx.storage.getAlarm()) == null) {
			await this.ctx.storage.setAlarm(Date.now() + GC_ALARM_MS);
		}
	}

	private async scheduleNextAlarm(nowMs = Date.now()) {
		let next = nowMs + GC_ALARM_MS;
		for (const command of await this.listCommands()) {
			if (
				(command.status !== "claimed" && command.status !== "running") ||
				!command.leaseExpiresAt
			) {
				continue;
			}
			const leaseMs = new Date(command.leaseExpiresAt).getTime();
			if (Number.isFinite(leaseMs)) next = Math.min(next, leaseMs);
		}
		const outboxes = await this.ctx.storage.list<StoredActivityOutbox>({
			prefix: ACTIVITY_OUTBOX_PREFIX,
		});
		for (const outbox of outboxes.values()) {
			if (outbox.state === "pending" && outbox.queuedAt === null) {
				const dueMs = Date.parse(outbox.nextAttemptAt);
				if (Number.isFinite(dueMs)) next = Math.min(next, Math.max(nowMs + 1_000, dueMs));
			}
			if (outbox.state === "sending" && outbox.sendingLeaseExpiresAt) {
				const leaseMs = Date.parse(outbox.sendingLeaseExpiresAt);
				if (Number.isFinite(leaseMs)) next = Math.min(next, Math.max(nowMs + 1_000, leaseMs));
			}
		}
		const preferences = await this.listActivityPreferences();
		let hasActivePreference = false;
		for (const preference of preferences.values()) {
			const expiresAtMs = Date.parse(preference.expiresAt);
			if (Number.isFinite(expiresAtMs)) {
				next = Math.min(next, Math.max(nowMs + 1_000, expiresAtMs));
			}
			if (!isActivityWatchPreferenceExpired(preference, nowMs)) {
				hasActivePreference = true;
			}
		}
		if (hasActivePreference) {
			next = Math.min(next, nowMs + Math.floor(ACTIVITY_WATCH_LEASE_MS / 2));
		}
		await this.ctx.storage.setAlarm(next);
	}

	private async collectGarbage(nowMs = Date.now()) {
		const doomed = selectTerminalCommandsForGc(await this.listCommands(), nowMs);
		for (const command of doomed) {
			const key = await this.ctx.storage.get<string>(`${COMMAND_ID_PREFIX}${command.id}`);
			const deletes = [
				`${COMMAND_ID_PREFIX}${command.id}`,
				`${IDEMPOTENCY_PREFIX}${command.idempotencyKey}`,
			];
			if (key) deletes.push(key);
			await this.ctx.storage.delete(deletes);
		}
		await this.gcTurnEvents();
		await this.gcActivityOutboxes(nowMs);
		await this.gcExpiredActivityRegistrations(nowMs);
		if (await this.gcExpiredActivityPreferences(nowMs)) {
			await this.reconcileActivityWatch({ nowMs });
		}
		await this.gcExpiredAttachments(nowMs);
	}

	private async gcTurnEvents() {
		const records = await this.ctx.storage.list<RelayTurnEvent>({
			prefix: TURN_EVENT_KEY_PREFIX,
		});
		const keys = [...records.keys()];
		for (const key of selectOldestKeysForGc(keys, TURN_EVENT_MAX_STORED)) {
			const event = records.get(key);
			const deletes = [key];
			if (event?.id) deletes.push(`${TURN_EVENT_ID_PREFIX}${event.id}`);
			await this.ctx.storage.delete(deletes);
		}
		const nowMs = Date.now();
		const lifecycle = await this.ctx.storage.list<RelayTurnLifecycleEvent>({
			prefix: TURN_LIFECYCLE_LATEST_PREFIX,
		});
		for (const [key, event] of lifecycle) {
			if (
				!(["completed", "failed", "interrupted", "merged", "cancelled"] as string[])
					.includes(event.status) ||
				nowMs - Date.parse(event.observedAt) <= ACTIVITY_LIFECYCLE_TERMINAL_TTL_MS
			) {
				continue;
			}
			await this.ctx.storage.delete(key);
		}
	}

	private async gcActivityOutboxes(nowMs: number) {
		const records = await this.ctx.storage.list<StoredActivityOutbox>({
			prefix: ACTIVITY_OUTBOX_PREFIX,
		});
		for (const [key, outbox] of records) {
			const ageMs = nowMs - Date.parse(outbox.createdAt);
			if (
				(outbox.state === "pending" || outbox.state === "sending") &&
				ageMs >= ACTIVITY_OUTBOX_MAX_AGE_MS
			) {
				await this.deadLetterActivityOutbox(key, outbox, "apns_outbox_expired");
				continue;
			}
			if (
				outbox.state !== "pending" &&
				outbox.state !== "sending" &&
				nowMs - Date.parse(outbox.updatedAt) >= ACTIVITY_OUTBOX_TERMINAL_TTL_MS
			) {
				await this.ctx.storage.delete(key);
			}
		}
	}

	private async gcExpiredActivityRegistrations(nowMs: number) {
		await this.ctx.storage.transaction(async (storage) => {
			const [registrations, outboxes, starts] = await Promise.all([
				storage.list<StoredActivityRegistration>({
					prefix: ACTIVITY_REGISTRATION_PREFIX,
				}),
				storage.list<StoredActivityOutbox>({
					prefix: ACTIVITY_OUTBOX_PREFIX,
				}),
				storage.list<StoredActivityStart>({ prefix: ACTIVITY_START_PREFIX }),
			]);
			const expiredInstallationIds = new Set<string>();
			const expiredDeviceInstallationIds = new Set<string>();
			const expiredActivityIdsByInstallation = new Map<string, Set<string>>();
			const expiredRegistrationIds = new Set<string>();
			const registrationKeysToDelete: string[] = [];
			for (const [key, registration] of registrations) {
				if (!isActivityRegistrationExpired(registration, nowMs)) continue;
				expiredInstallationIds.add(registration.installationId);
				expiredRegistrationIds.add(registration.id);
				if (registration.kind === "device") {
					expiredDeviceInstallationIds.add(registration.installationId);
				} else if (registration.activityId) {
					const activityIds =
						expiredActivityIdsByInstallation.get(registration.installationId) ??
						new Set<string>();
					activityIds.add(registration.activityId);
					expiredActivityIdsByInstallation.set(
						registration.installationId,
						activityIds,
					);
				}
				registrationKeysToDelete.push(key);
			}
			if (expiredInstallationIds.size === 0) return;
			const revokedRegistrationIds = new Set(expiredRegistrationIds);
			for (const registration of registrations.values()) {
				if (expiredDeviceInstallationIds.has(registration.installationId)) {
					revokedRegistrationIds.add(registration.id);
				}
			}
			const now = new Date(nowMs).toISOString();
			const writes: Record<string, unknown> = {};
			const startKeysToDelete: string[] = [];
			for (const installationId of expiredDeviceInstallationIds) {
				const epochKey = activityRevocationEpochStorageKey(installationId);
				writes[epochKey] = activityRevocationEpochAfterRemoval(
					"device",
					await storage.get<unknown>(epochKey),
				);
			}
			for (const [startKey, start] of starts) {
				if (!expiredInstallationIds.has(start.installationId)) continue;
				if (
					shouldDeleteActivityStartMarker({
						deviceRevoked: expiredDeviceInstallationIds.has(start.installationId),
						storedActivityId: start.activityId,
						revokedActivityIds:
							expiredActivityIdsByInstallation.get(start.installationId) ??
							new Set<string>(),
					})
				) {
					startKeysToDelete.push(startKey);
				}
			}
			for (const [key, outbox] of outboxes) {
				const patch = revokedActivityOutboxPatch(
					outbox,
					revokedRegistrationIds,
					now,
					"Activity registration expired",
				);
				if (patch) writes[key] = { ...outbox, ...patch };
			}
			if (Object.keys(writes).length > 0) await storage.put(writes);
			await storage.delete([...registrationKeysToDelete, ...startKeysToDelete]);
		});
	}

	private async gcExpiredActivityPreferences(nowMs: number) {
		const preferences = await this.listActivityPreferences();
		let deleted = false;
		for (const [key, preference] of preferences) {
			if (!isActivityWatchPreferenceExpired(preference, nowMs)) continue;
			await this.ctx.storage.delete(key);
			deleted = true;
		}
		return deleted;
	}

	private async gcExpiredAttachments(nowMs: number) {
		const records = await this.ctx.storage.list<StoredRelayAttachment>({
			prefix: ATTACHMENT_KEY_PREFIX,
		});
		for (const [key, attachment] of records) {
			if (new Date(attachment.expiresAt).getTime() > nowMs) continue;
			await this.ctx.storage.delete(key);
			try {
				await this.env.ATTACHMENTS.delete(attachment.objectKey);
			} catch (error) {
				console.error("[relay] failed to delete expired attachment object", {
					attachmentId: attachment.id,
					error,
				});
			}
		}
	}
}

function requireConfigured(env: RelayEnv) {
	for (const name of [
		"NODE_ID",
		"NODE_TOKEN",
		"TEAM_DOMAIN",
		"POLICY_AUD",
		"OWNER_EMAIL",
		"OWNER_USER_ID",
		"CLOUD_API_ORIGIN",
		"COMMAND_LEASE_MS",
		"COMMAND_MAX_BODY_BYTES",
		"ATTACHMENT_MAX_BYTES",
		"ATTACHMENT_TTL_MS",
		"ACTIVITY_STALE_SECONDS",
		"ACTIVITY_REGISTRATION_TTL_SECONDS",
		"APNS_LIVE_ACTIVITY_ATTRIBUTES_TYPE",
	] as const) {
		if (!env[name]?.trim()) throw new Error(`Missing relay setting: ${name}`);
	}
	parseActivityOwnerUserId(env.OWNER_USER_ID);
}

function nodeStub(env: RelayEnv, nodeId: string) {
	if (nodeId !== env.NODE_ID) {
		throw new RelayProtocolError("node_not_found", "Local node not found", 404);
	}
	const stub = env.NODES.getByName(nodeId);
	return new Proxy(stub, {
		get(target, property, receiver) {
			if (property === "fetch") {
				return (input: RequestInfo | URL, init?: RequestInit) =>
					target.fetch(bindRelayNodeRequest(input, init, nodeId));
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function readInternalAttachment(
	response: Response,
): Promise<{ attachment: RelayAttachment; alreadyUploaded?: boolean }> {
	const payload = await response.json<{
		attachment?: RelayAttachment;
		alreadyUploaded?: boolean;
	}>();
	if (!response.ok || !payload.attachment) {
		throw new RelayProtocolError(
			"attachment_state_unavailable",
			"Attachment state is unavailable",
			response.status >= 400 ? response.status : 500,
		);
	}
	return {
		attachment: payload.attachment,
		...(payload.alreadyUploaded === undefined
			? {}
			: { alreadyUploaded: payload.alreadyUploaded }),
	};
}

export async function createAttachmentPlan(input: {
	request: Request;
	url: URL;
	stub: Pick<DurableObjectStub<LocalNodeRelay>, "fetch">;
	nodeId: string;
	publicBasePath?: string;
}) {
	const created = await input.stub.fetch(
		new Request("https://relay.internal/internal/attachments", input.request),
	);
	const payload = await created.json<{
		attachment?: RelayAttachment;
		uploadToken?: string;
		code?: string;
		message?: string;
	}>();
	if (!created.ok || !payload.attachment || !payload.uploadToken) {
		return json(payload, created.status);
	}
	const publicBasePath =
		input.publicBasePath ??
		`${input.url.pathname.startsWith("/relay/") ? "/relay" : ""}/v1/nodes/${encodeURIComponent(input.nodeId)}`;
	const uploadUrl = new URL(
		`${publicBasePath}/attachments/${encodeURIComponent(payload.attachment.id)}/content`,
		input.url.origin,
	);
	uploadUrl.searchParams.set("uploadToken", payload.uploadToken);
	return json(
		{
			attachment: payload.attachment,
			upload: {
				method: "PUT",
				url: uploadUrl.toString(),
				headers: {
					"content-type": payload.attachment.contentType,
					"x-cohub-content-sha256": payload.attachment.sha256,
				},
				expiresAt: payload.attachment.expiresAt,
			},
		},
		201,
	);
}

function attachmentContentDisposition(name: string) {
	const fallback = name.replace(/[^a-z0-9._-]/gi, "_") || "attachment";
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function handleAttachmentUpload(input: {
	request: Request;
	env: RelayAttachmentEnv;
	stub: Pick<DurableObjectStub<LocalNodeRelay>, "fetch">;
	nodeId: string;
	attachmentId: string;
}) {
	const { request, env, stub, nodeId, attachmentId } = input;
	const url = new URL(request.url);
	const token = url.searchParams.get("uploadToken") ?? "";
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	const declaredSha256 = request.headers.get("x-cohub-content-sha256")?.toLowerCase() ?? "";
	const rawLength = request.headers.get("content-length");
	const size = rawLength === null ? Number.NaN : Number(rawLength);
	const authorization = await stub.fetch(
		`https://relay.internal/internal/attachments/${encodeURIComponent(attachmentId)}/authorize-upload`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, size, contentType, sha256: declaredSha256 }),
		},
	);
	const { attachment, alreadyUploaded } = await readInternalAttachment(authorization);
	if (alreadyUploaded) return json({ attachment, deduplicated: true });
	if (!request.body) {
		throw new RelayProtocolError("attachment_body_missing", "Attachment body is required");
	}
	let uploaded: R2Object;
	try {
		uploaded = await env.ATTACHMENTS.put(attachment.objectKey, request.body, {
			httpMetadata: { contentType: attachment.contentType },
			customMetadata: {
				nodeId,
				attachmentId,
				originalName: attachment.name,
			},
			sha256: attachment.sha256,
		});
	} catch (error) {
		console.error("[relay] R2 attachment upload failed", { attachmentId, error });
		throw new RelayProtocolError(
			"attachment_upload_failed",
			"Attachment upload failed checksum or storage validation",
			422,
		);
	}
	const storedSha256 = uploaded.checksums.sha256
		? bytesToHex(uploaded.checksums.sha256)
		: null;
	if (
		uploaded.size !== attachment.size ||
		uploaded.httpMetadata?.contentType !== attachment.contentType ||
		storedSha256 !== attachment.sha256 ||
		uploaded.customMetadata?.attachmentId !== attachment.id ||
		uploaded.customMetadata?.nodeId !== attachment.nodeId
	) {
		await env.ATTACHMENTS.delete(attachment.objectKey);
		throw new RelayProtocolError(
			"attachment_verification_failed",
			"Stored attachment failed identity verification",
			422,
		);
	}
	const completed = await stub.fetch(
		`https://relay.internal/internal/attachments/${encodeURIComponent(attachmentId)}/complete`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				objectKey: attachment.objectKey,
				size: uploaded.size,
				contentType: uploaded.httpMetadata?.contentType,
				sha256: storedSha256,
			}),
		},
	);
	const ready = await readInternalAttachment(completed);
	return json({ attachment: ready.attachment, deduplicated: false }, 201);
}

export async function handleAttachmentDownload(input: {
	env: RelayAttachmentEnv;
	stub: Pick<DurableObjectStub<LocalNodeRelay>, "fetch">;
	attachmentId: string;
}) {
	const response = await input.stub.fetch(
		`https://relay.internal/internal/attachments/${encodeURIComponent(input.attachmentId)}`,
	);
	const { attachment } = await readInternalAttachment(response);
	if (attachment.state !== "ready") {
		throw new RelayProtocolError("attachment_not_ready", "Attachment is not ready", 409);
	}
	assertRelayAttachmentFresh(attachment.expiresAt);
	const object = await input.env.ATTACHMENTS.get(attachment.objectKey);
	if (!object) {
		throw new RelayProtocolError(
			"attachment_object_missing",
			"Attachment object is missing",
			502,
		);
	}
	const storedSha256 = object.checksums.sha256
		? bytesToHex(object.checksums.sha256)
		: null;
	if (
		object.size !== attachment.size ||
		object.httpMetadata?.contentType !== attachment.contentType ||
		storedSha256 !== attachment.sha256 ||
		object.customMetadata?.attachmentId !== attachment.id
	) {
		throw new RelayProtocolError(
			"attachment_verification_failed",
			"Attachment object no longer matches its verified identity",
			502,
		);
	}
	return new Response(object.body, {
		headers: {
			"cache-control": "private, no-store",
			"content-disposition": attachmentContentDisposition(attachment.name),
			"content-length": String(attachment.size),
			"content-type": attachment.contentType,
			"x-cohub-attachment-id": attachment.id,
			"x-cohub-attachment-sha256": attachment.sha256,
			"x-cohub-attachment-size": String(attachment.size),
			"x-content-type-options": "nosniff",
		},
	});
}

async function handleActivityRegistration(input: {
	request: Request;
	stub: DurableObjectStub<LocalNodeRelay>;
	identity: ActivityOwnerIdentity;
	kind: ActivityRegistrationKind;
	installationId: string;
	activityId: string | null;
}) {
	const { request, stub, identity, kind, installationId, activityId } = input;
	if (request.method === "DELETE") {
		return stub.fetch("https://relay.internal/internal/activity-registration", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				identity,
				kind,
				installationId,
				activityId,
			}),
		});
	}
	const registration = parseActivityTokenBody(
		await parseJsonBody(request),
		kind,
	);
	return stub.fetch("https://relay.internal/internal/activity-registration", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			identity,
			kind,
			installationId,
			activityId,
			registration,
		}),
	});
}

async function handleActivityPreference(input: {
	request: Request;
	stub: DurableObjectStub<LocalNodeRelay>;
	identity: ActivityOwnerIdentity;
	ownerUserId: string;
	installationId: string;
}) {
	const { request, stub, identity, ownerUserId, installationId } = input;
	if (request.method === "DELETE") {
		return stub.fetch("https://relay.internal/internal/activity-preference", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identity, installationId }),
		});
	}
	const preferences = parseActivityWatchPreferences(await parseJsonBody(request));
	return stub.fetch("https://relay.internal/internal/activity-preference", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			identity,
			ownerUserId,
			installationId,
			preferences,
		}),
	});
}

async function handleRequest(request: Request, env: RelayEnv) {
	requireConfigured(env);
	const url = new URL(request.url);
	const pathname =
		url.pathname === "/relay"
			? "/"
			: url.pathname.startsWith("/relay/")
				? url.pathname.slice("/relay".length)
				: url.pathname;
	if (request.method === "GET" && pathname === "/healthz") {
		let activityPush: Record<string, unknown> = { status: "ready" };
		try {
			apnsConfig(env, "development");
			apnsConfig(env, "production");
		} catch (error) {
			if (error instanceof ApnsConfigurationError) {
				activityPush = {
					status: "error",
					code: "apns_configuration_error",
				};
			} else {
				throw error;
			}
		}
		const activityHealth = await nodeStub(env, env.NODE_ID).fetch(
			"https://relay.internal/internal/activity-health",
		);
		const storedActivityHealth = await activityHealth.json<Record<string, unknown>>();
		if (storedActivityHealth.status === "error") activityPush = storedActivityHealth;
		return json(
			composeRelayHealth(
				RELAY_PROTOCOL_VERSION,
				RELAY_EVENT_SCHEMA_VERSION,
				activityPush,
			),
		);
	}
	if (pathname.startsWith("/api/")) {
		return handleFederatedApi({
			request,
			stub: nodeStub(env, env.NODE_ID),
			cloudApiOrigin: env.CLOUD_API_ORIGIN,
			ownerUserId: env.OWNER_USER_ID,
			maxBodyBytes: parsePositiveInteger(
				env.COMMAND_MAX_BODY_BYTES,
				"COMMAND_MAX_BODY_BYTES",
			),
		});
	}
	const match = pathname.match(/^\/v1\/nodes\/([^/]+)(\/.*)?$/);
	if (!match?.[1]) {
		return json({ code: "not_found", message: "Relay route not found" }, 404);
	}
	const nodeId = decodeURIComponent(match[1]);
	const suffix = match[2] ?? "";
	const stub = nodeStub(env, nodeId);
	if (request.method === "GET" && suffix === "/connect") {
		await authorizeNodeRequest(request, env.NODE_TOKEN);
		const forwarded = new Request("https://relay.internal/internal/node", request);
		forwarded.headers.delete("authorization");
		return stub.fetch(forwarded);
	}
	const attachmentContentMatch = suffix.match(/^\/attachments\/([^/]+)\/content$/);
	const isNodeRequest = request.headers.get("x-cohub-relay-node") === "1";
	if (
		request.method === "GET" &&
		attachmentContentMatch?.[1] &&
		isNodeRequest
	) {
		await authorizeNodeRequest(request, env.NODE_TOKEN);
		return handleAttachmentDownload({
			env,
			stub,
			attachmentId: decodeURIComponent(attachmentContentMatch[1]),
		});
	}
	if (isNodeRequest && request.method === "POST" && suffix === "/attachments") {
		await authorizeNodeRequest(request, env.NODE_TOKEN);
		return createAttachmentPlan({ request, url, stub, nodeId });
	}
	if (isNodeRequest && request.method === "PUT" && attachmentContentMatch?.[1]) {
		await authorizeNodeRequest(request, env.NODE_TOKEN);
		return handleAttachmentUpload({
			request,
			env,
			stub,
			nodeId,
			attachmentId: decodeURIComponent(attachmentContentMatch[1]),
		});
	}
	const ownerPayload = await authorizeOwnerRequest(request, {
		teamDomain: env.TEAM_DOMAIN,
		policyAudience: env.POLICY_AUD,
		ownerEmail: env.OWNER_EMAIL,
	});
	const ownerIdentity = relayOwnerIdentity(ownerPayload);
	const ownerUserId = parseActivityOwnerUserId(env.OWNER_USER_ID);
	assertRelayOwnerOrigin({
		method: request.method,
		suffix,
		origin: request.headers.get("origin"),
		allowedOrigin: env.ALLOWED_ORIGIN,
	});
	if (request.method === "GET" && suffix === "/events") {
		return stub.fetch(new Request("https://relay.internal/internal/events", request));
	}
	if (request.method === "GET" && suffix === "/status") {
		return stub.fetch("https://relay.internal/internal/status");
	}
	const activityPreferenceMatch = suffix.match(
		/^\/activity\/preferences\/([^/]+)$/,
	);
	if (
		(request.method === "PUT" || request.method === "DELETE") &&
		activityPreferenceMatch?.[1]
	) {
		return handleActivityPreference({
			request,
			stub,
			identity: ownerIdentity,
			ownerUserId,
			installationId: decodeURIComponent(activityPreferenceMatch[1]),
		});
	}
	const deviceRegistrationMatch = suffix.match(
		/^\/activity\/devices\/([^/]+)$/,
	);
	if (
		(request.method === "PUT" || request.method === "DELETE") &&
		deviceRegistrationMatch?.[1]
	) {
		return handleActivityRegistration({
			request,
			stub,
			identity: ownerIdentity,
			kind: "device",
			installationId: decodeURIComponent(deviceRegistrationMatch[1]),
			activityId: null,
		});
	}
	const activityRegistrationMatch = suffix.match(
		/^\/activity\/registrations\/([^/]+)\/([^/]+)$/,
	);
	if (
		(request.method === "PUT" || request.method === "DELETE") &&
		activityRegistrationMatch?.[1] &&
		activityRegistrationMatch[2]
	) {
		return handleActivityRegistration({
			request,
			stub,
			identity: ownerIdentity,
			kind: "activity",
			installationId: decodeURIComponent(activityRegistrationMatch[1]),
			activityId: decodeURIComponent(activityRegistrationMatch[2]),
		});
	}
	if (request.method === "POST" && suffix === "/attachments") {
		return createAttachmentPlan({ request, url, stub, nodeId });
	}
	if (request.method === "PUT" && attachmentContentMatch?.[1]) {
		return handleAttachmentUpload({
			request,
			env,
			stub,
			nodeId,
			attachmentId: decodeURIComponent(attachmentContentMatch[1]),
		});
	}
	if (request.method === "GET" && attachmentContentMatch?.[1]) {
		return handleAttachmentDownload({
			env,
			stub,
			attachmentId: decodeURIComponent(attachmentContentMatch[1]),
		});
	}
	if (request.method === "POST" && suffix === "/commands") {
		return stub.fetch(new Request("https://relay.internal/internal/commands", request));
	}
	const commandCancelMatch = suffix.match(/^\/commands\/([^/]+)\/cancel$/);
	if (request.method === "POST" && commandCancelMatch?.[1]) {
		return stub.fetch(
			new Request(
				`https://relay.internal/internal/commands/${encodeURIComponent(commandCancelMatch[1])}/cancel`,
				request,
			),
		);
	}
	const commandMatch = suffix.match(/^\/commands\/([^/]+)$/);
	if (request.method === "GET" && commandMatch?.[1]) {
		return stub.fetch(
			new Request(
				`https://relay.internal/internal/commands/${encodeURIComponent(commandMatch[1])}`,
				request,
			),
		);
	}
	return json({ code: "not_found", message: "Relay route not found" }, 404);
}

export default {
	async fetch(request: Request, env: RelayEnv) {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			return errorResponse(error);
		}
	},

	async queue(
		batch: MessageBatch<RelayWakeupMessage | ActivityPushQueueMessage>,
		env: RelayEnv,
	) {
		for (const message of batch.messages) {
			const payload = message.body;
			if ("kind" in payload) {
				if (
					payload.kind !== "activity-push" ||
					payload.nodeId !== env.NODE_ID ||
					!payload.outboxId
				) {
					console.error("[relay] rejected malformed activity push job", payload);
					message.ack();
					continue;
				}
				try {
					const response = await nodeStub(env, payload.nodeId).fetch(
						`https://relay.internal/internal/activity-push/${encodeURIComponent(payload.outboxId)}`,
						{ method: "POST" },
					);
					await response.body?.cancel();
					message.ack();
				} catch (error) {
					console.error("[relay] activity push queue delivery failed", {
						outboxId: payload.outboxId,
						error,
					});
					message.retry();
				}
				continue;
			}
			if (
				payload.protocolVersion !== RELAY_PROTOCOL_VERSION ||
				payload.nodeId !== env.NODE_ID
			) {
				console.error("[relay] rejected malformed queue wakeup", payload);
				message.ack();
				continue;
			}
			try {
				const response = await nodeStub(env, payload.nodeId).fetch(
					"https://relay.internal/internal/wake",
					{ method: "POST" },
				);
				if (!response.ok) throw new Error(`wake returned ${response.status}`);
				message.ack();
			} catch (error) {
				console.error("[relay] queue wakeup failed", error);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<
	RelayEnv,
	RelayWakeupMessage | ActivityPushQueueMessage
>;
