import { DurableObject } from "cloudflare:workers";
import { authorizeNodeRequest, authorizeOwnerRequest } from "./auth";
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
	parseNodeMessage,
	RELAY_PROTOCOL_VERSION,
	RelayProtocolError,
	type RelayBrowserEvent,
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

type RelayEnv = {
	NODES: DurableObjectNamespace<LocalNodeRelay>;
	COMMAND_WAKEUPS: Queue<RelayWakeupMessage>;
	ATTACHMENTS: R2Bucket;
	ALLOWED_ORIGIN: string;
	NODE_ID: string;
	NODE_TOKEN: string;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
	OWNER_EMAIL: string;
	COMMAND_LEASE_MS: string;
	COMMAND_MAX_BODY_BYTES: string;
	ATTACHMENT_MAX_BYTES: string;
	ATTACHMENT_TTL_MS: string;
};

const COMMAND_KEY_PREFIX = "command:";
const COMMAND_ID_PREFIX = "command-id:";
const IDEMPOTENCY_PREFIX = "idempotency:";
const NEXT_SEQUENCE_KEY = "meta:next-sequence";
const NEXT_EVENT_SEQUENCE_KEY = "meta:next-event-sequence";
const ATTACHMENT_KEY_PREFIX = "attachment:";
const TURN_EVENT_KEY_PREFIX = "turnevent:";
const TURN_EVENT_ID_PREFIX = "turnevent-id:";

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

function websocketPair() {
	const pair = new WebSocketPair();
	return {
		client: pair[0],
		server: pair[1],
	};
}

function websocketResponse(client: WebSocket) {
	return new Response(null, { status: 101, webSocket: client });
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

	constructor(state: DurableObjectState, env: RelayEnv) {
		super(state, env);
		this.leaseMs = parsePositiveInteger(env.COMMAND_LEASE_MS, "COMMAND_LEASE_MS");
	}

	async fetch(request: Request) {
		try {
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
			if (request.method === "POST" && url.pathname === "/internal/attachments") {
				return await this.createAttachment(request);
			}
			if (request.method === "POST" && url.pathname === "/internal/wake") {
				await this.dispatchNext();
				return json({ ok: true });
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

	private async getStatus() {
		const active = (await this.listCommands()).find(
			(command) => command.status === "claimed" || command.status === "running",
		);
		return json({
			protocolVersion: RELAY_PROTOCOL_VERSION,
			nodeId: this.env.NODE_ID,
			connected: this.ctx.getWebSockets("node").length > 0,
			activeCommandId: active?.id ?? null,
			activeCommandStatus: active?.status ?? null,
		});
	}

	private async createAttachment(request: Request) {
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
			nodeId: this.env.NODE_ID,
			objectKey: `nodes/${this.env.NODE_ID}/attachments/${id}`,
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

	private connectNode(request: Request) {
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
			nodeId: this.env.NODE_ID,
		});
		this.ctx.waitUntil(
			Promise.all([this.ensurePeriodicAlarm(), this.dispatchNext()]),
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
			events: selectSnapshotEvents(await this.listTurnEvents()),
		});
		return websocketResponse(client);
	}

	private async createCommand(request: Request) {
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
				nodeId: this.env.NODE_ID,
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
						nodeId: this.env.NODE_ID,
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
		await this.collectGarbage(nowMs);
		await this.scheduleNextAlarm(nowMs);
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
		const existingKey = await this.ctx.storage.get<string>(
			`${TURN_EVENT_ID_PREFIX}${event.id}`,
		);
		if (existingKey) {
			sendSocket(socket, {
				protocolVersion: RELAY_PROTOCOL_VERSION,
				type: "turn-event-ack",
				eventId: event.id,
			});
			return;
		}
		const sequence = (await this.ctx.storage.get<number>(NEXT_EVENT_SEQUENCE_KEY)) ?? 1;
		const key = turnEventStorageKey(sequence);
		await this.ctx.storage.put({
			[NEXT_EVENT_SEQUENCE_KEY]: sequence + 1,
			[key]: event,
			[`${TURN_EVENT_ID_PREFIX}${event.id}`]: key,
		});
		const browserEvent: RelayBrowserEvent = {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn.event",
			event,
		};
		for (const browserSocket of this.ctx.getWebSockets("browser")) {
			sendSocket(browserSocket, browserEvent);
		}
		sendSocket(socket, {
			protocolVersion: RELAY_PROTOCOL_VERSION,
			type: "turn-event-ack",
			eventId: event.id,
		});
		await this.gcTurnEvents();
	}

	private async listTurnEvents() {
		const records = await this.ctx.storage.list<RelayTurnEvent>({
			prefix: TURN_EVENT_KEY_PREFIX,
		});
		return [...records.values()];
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
		"COMMAND_LEASE_MS",
		"COMMAND_MAX_BODY_BYTES",
		"ATTACHMENT_MAX_BYTES",
		"ATTACHMENT_TTL_MS",
	] as const) {
		if (!env[name]?.trim()) throw new Error(`Missing relay setting: ${name}`);
	}
}

function nodeStub(env: RelayEnv, nodeId: string) {
	if (nodeId !== env.NODE_ID) {
		throw new RelayProtocolError("node_not_found", "Local node not found", 404);
	}
	return env.NODES.getByName(nodeId);
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

async function createAttachmentPlan(input: {
	request: Request;
	url: URL;
	stub: DurableObjectStub<LocalNodeRelay>;
	nodeId: string;
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
	const prefix = input.url.pathname.startsWith("/relay/") ? "/relay" : "";
	const uploadUrl = new URL(
		`${prefix}/v1/nodes/${encodeURIComponent(input.nodeId)}/attachments/${encodeURIComponent(payload.attachment.id)}/content`,
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

async function handleAttachmentUpload(input: {
	request: Request;
	env: RelayEnv;
	stub: DurableObjectStub<LocalNodeRelay>;
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

async function handleAttachmentDownload(input: {
	env: RelayEnv;
	stub: DurableObjectStub<LocalNodeRelay>;
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
		return json({ status: "ready", protocolVersion: RELAY_PROTOCOL_VERSION });
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
	await authorizeOwnerRequest(request, {
		teamDomain: env.TEAM_DOMAIN,
		policyAudience: env.POLICY_AUD,
		ownerEmail: env.OWNER_EMAIL,
	});
	if (
		(request.method !== "GET" || suffix === "/events") &&
		request.headers.get("origin") !== env.ALLOWED_ORIGIN
	) {
		throw new RelayProtocolError(
			"origin_not_allowed",
			"Request origin is not allowed for this relay",
			403,
		);
	}
	if (request.method === "GET" && suffix === "/events") {
		return stub.fetch(new Request("https://relay.internal/internal/events", request));
	}
	if (request.method === "GET" && suffix === "/status") {
		return stub.fetch("https://relay.internal/internal/status");
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

	async queue(batch: MessageBatch<RelayWakeupMessage>, env: RelayEnv) {
		for (const message of batch.messages) {
			const payload = message.body;
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
} satisfies ExportedHandler<RelayEnv, RelayWakeupMessage>;
