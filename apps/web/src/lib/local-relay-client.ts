import { env } from "$env/dynamic/public";
import { getAuthToken } from "$lib/auth";
import { resolvePersonalNodeDevice } from "$lib/personal-node-fetch";
import {
	connectLocalRelayEvents,
	type LocalRelayEventHandlers,
	resolveLocalRelayEventsUrl,
} from "./local-relay-events";

export type LocalRelayAttachment = {
	id: string;
	name: string;
	size: number;
	contentType: string;
	sha256: string;
	state: "pending" | "ready" | "failed";
	expiresAt: string;
};

export type LocalRelayCommand = {
	id: string;
	status:
		| "accepted"
		| "queued"
		| "claimed"
		| "running"
		| "succeeded"
		| "failed"
		| "cancelled";
	errorCode: string | null;
	errorMessage: string | null;
	result: {
		status: number;
		headers: Record<string, string>;
		body: string;
	} | null;
};

export class LocalRelayRequestError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(message: string, code: string, status: number) {
		super(message);
		this.name = "LocalRelayRequestError";
		this.code = code;
		this.status = status;
	}
}

export const LOCAL_RELAY_COMMAND_POLL_INTERVAL_MS = 2_000;

export type PendingLocalRelayCommand = {
	commandId: string;
	spaceId: string;
	sessionId: string;
	optimisticTurnId: string;
	clientMessageId: string;
	createdAt: string;
};

const PENDING_COMMANDS_STORAGE_KEY = "cohub:local-relay-pending:v1";
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const relayBasePath = (
	env.PUBLIC_LOCAL_RELAY_BASE_PATH?.trim() || "/relay"
).replace(/\/$/, "");
const relayNodeId = env.PUBLIC_LOCAL_RELAY_NODE_ID?.trim() || "mac-mini";
const isPersonalNodeAlpha = env.PUBLIC_PERSONAL_NODE_ALPHA === "true";

export const isLocalRelayEnabled =
	env.PUBLIC_LOCAL_RELAY_ENABLED?.trim() === "true";

export const localFederatedApiUrl =
	env.PUBLIC_LOCAL_FEDERATED_API_URL?.trim() || "https://relay-node.atou.cc";

function relayNodePath(suffix: string) {
	return `${relayBasePath}/v1/nodes/${encodeURIComponent(relayNodeId)}${suffix}`;
}

async function relayRequestContext() {
	if (!isPersonalNodeAlpha) {
		return {
			path: (suffix: string) => relayNodePath(suffix),
			headers: {} as Record<string, string>,
			webSocketProtocols: undefined as string[] | undefined,
		};
	}
	const token = await getAuthToken();
	if (!token) {
		throw new LocalRelayRequestError(
			"Personal Node sign-in is required",
			"personal_node_auth_required",
			401,
		);
	}
	const authorization = `Bearer ${token}`;
	const device = await resolvePersonalNodeDevice(authorization);
	if (!device) {
		throw new LocalRelayRequestError(
			"No active Personal Node is registered",
			"personal_node_missing",
			409,
		);
	}
	if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
		throw new LocalRelayRequestError(
			"Personal Node session token is invalid",
			"personal_node_auth_invalid",
			401,
		);
	}
	return {
		path: (suffix: string) =>
			`/api/alpha/v1/nodes/${encodeURIComponent(device.id)}${suffix}`,
		headers: { authorization },
		webSocketProtocols: ["cohub-alpha-v1", `cohub-alpha-bearer.${token}`],
	};
}

function isPendingCommand(value: unknown): value is PendingLocalRelayCommand {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		[
			"commandId",
			"spaceId",
			"sessionId",
			"optimisticTurnId",
			"clientMessageId",
		].every(
			(key) =>
				typeof record[key] === "string" && UUID_PATTERN.test(record[key]),
		) &&
		typeof record.createdAt === "string" &&
		Number.isFinite(Date.parse(record.createdAt))
	);
}

function readPendingCommands() {
	if (typeof localStorage === "undefined")
		return [] as PendingLocalRelayCommand[];
	const raw = localStorage.getItem(PENDING_COMMANDS_STORAGE_KEY);
	if (raw === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error("Local relay recovery data is corrupted", { cause: error });
	}
	if (!Array.isArray(parsed) || !parsed.every(isPendingCommand)) {
		throw new Error("Local relay recovery data is corrupted");
	}
	return parsed;
}

function writePendingCommands(commands: PendingLocalRelayCommand[]) {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(PENDING_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
}

export function listPendingLocalRelayCommands(spaceId: string) {
	return readPendingCommands().filter((command) => command.spaceId === spaceId);
}

export function registerPendingLocalRelayCommand(
	command: PendingLocalRelayCommand,
) {
	if (!isPendingCommand(command)) {
		throw new Error("Local relay recovery command is invalid");
	}
	const current = readPendingCommands();
	writePendingCommands([
		command,
		...current.filter((item) => item.commandId !== command.commandId),
	]);
}

export function removePendingLocalRelayCommand(commandId: string) {
	const current = readPendingCommands();
	writePendingCommands(current.filter((item) => item.commandId !== commandId));
}

export async function getLocalRelayNodeStatus(signal?: AbortSignal) {
	const relay = await relayRequestContext();
	const response = await fetch(relay.path("/status"), {
		headers: relay.headers,
		credentials: "include",
		cache: "no-store",
		signal,
	});
	if (!response.ok)
		throw await responseError(response, "Relay status could not be loaded");
	const payload = (await response.json()) as { connected?: unknown };
	if (typeof payload.connected !== "boolean") {
		throw new Error("Relay status response is invalid");
	}
	return payload.connected;
}

async function responseError(response: Response, fallback: string) {
	const payload = (await response
		.clone()
		.json()
		.catch(() => null)) as { message?: unknown; code?: unknown } | null;
	const message =
		typeof payload?.message === "string" ? payload.message : fallback;
	const code =
		typeof payload?.code === "string" ? payload.code : "relay_request_failed";
	return new LocalRelayRequestError(
		`${message} (${code})`,
		code,
		response.status,
	);
}

function bytesToHex(value: ArrayBuffer) {
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function uploadBlob(input: {
	url: string;
	headers: Record<string, string>;
	file: File;
	onProgress?: (ratio: number) => void;
	signal?: AbortSignal;
}) {
	return new Promise<void>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		let settled = false;
		const abort = () => xhr.abort();
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			input.signal?.removeEventListener("abort", abort);
			callback();
		};
		xhr.open("PUT", input.url);
		xhr.withCredentials = true;
		for (const [name, value] of Object.entries(input.headers)) {
			xhr.setRequestHeader(name, value);
		}
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable)
				input.onProgress?.(event.loaded / event.total);
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				input.onProgress?.(1);
				finish(resolve);
				return;
			}
			finish(() =>
				reject(new Error(`Relay attachment upload failed (${xhr.status})`)),
			);
		};
		xhr.onerror = () =>
			finish(() => reject(new Error("Relay attachment upload failed")));
		xhr.onabort = () => {
			const error = new Error("Relay attachment upload aborted");
			error.name = "AbortError";
			finish(() => reject(error));
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		if (input.signal?.aborted) abort();
		else xhr.send(input.file);
	});
}

export async function uploadLocalRelayAttachment(input: {
	file: File;
	name?: string;
	onProgress?: (ratio: number) => void;
	signal?: AbortSignal;
}) {
	const relay = await relayRequestContext();
	const contentType = input.file.type || "application/octet-stream";
	const sha256 = bytesToHex(
		await crypto.subtle.digest("SHA-256", await input.file.arrayBuffer()),
	);
	const planResponse = await fetch(relay.path("/attachments"), {
		method: "POST",
		headers: { ...relay.headers, "content-type": "application/json" },
		credentials: "include",
		body: JSON.stringify({
			name: input.name || input.file.name || "attachment",
			size: input.file.size,
			contentType,
			sha256,
		}),
		signal: input.signal,
	});
	if (!planResponse.ok) {
		throw await responseError(planResponse, "Relay attachment plan failed");
	}
	const plan = (await planResponse.json()) as {
		attachment: LocalRelayAttachment;
		upload: { url: string; headers: Record<string, string> };
	};
	await uploadBlob({
		url: plan.upload.url,
		headers: { ...plan.upload.headers, ...relay.headers },
		file: input.file,
		onProgress: input.onProgress,
		signal: input.signal,
	});
	const contentUrl = relay.path(
		`/attachments/${encodeURIComponent(plan.attachment.id)}/content`,
	);
	return {
		...plan.attachment,
		state: "ready" as const,
		contentUrl,
		referenceUrl: contentUrl,
	};
}

export async function submitLocalRelayPrompt(input: {
	spaceId: string;
	clientMessageId: string;
	body: Record<string, unknown>;
	attachmentIds?: string[];
}) {
	const relay = await relayRequestContext();
	const response = await fetch(relay.path("/commands"), {
		method: "POST",
		headers: { ...relay.headers, "content-type": "application/json" },
		credentials: "include",
		body: JSON.stringify({
			idempotencyKey: input.clientMessageId,
			attachmentIds: input.attachmentIds ?? [],
			request: {
				method: "POST",
				path: `/api/spaces/${input.spaceId}/prompt`,
				body: JSON.stringify(input.body),
			},
		}),
	});
	if (!response.ok)
		throw await responseError(response, "Relay rejected the message");
	return ((await response.json()) as { command: LocalRelayCommand }).command;
}

export function openLocalRelayEvents(
	handlers: LocalRelayEventHandlers,
	options: { signal?: AbortSignal } = {},
) {
	let closed = false;
	let connection: { close(): void } | null = null;
	void relayRequestContext()
		.then((relay) => {
			if (closed || options.signal?.aborted) return;
			const url = resolveLocalRelayEventsUrl(
				relay.path("/events"),
				typeof window === "undefined" ? null : window.location,
			);
			connection = connectLocalRelayEvents({
				url,
				protocols: relay.webSocketProtocols,
				handlers,
				signal: options.signal,
			});
		})
		.catch((error) => {
			console.warn("[local-relay] event authentication failed", error);
			if (!closed && !options.signal?.aborted) handlers.onUnavailable?.();
		});
	return {
		close() {
			closed = true;
			connection?.close();
		},
	};
}

export async function cancelLocalRelayCommand(
	commandId: string,
	signal?: AbortSignal,
) {
	const relay = await relayRequestContext();
	const response = await fetch(
		relay.path(`/commands/${encodeURIComponent(commandId)}/cancel`),
		{
			method: "POST",
			headers: relay.headers,
			credentials: "include",
			cache: "no-store",
			signal,
		},
	);
	if (!response.ok) {
		throw await responseError(response, "Relay command cancel failed");
	}
	return ((await response.json()) as { command: LocalRelayCommand }).command;
}

export async function waitForLocalRelayCommand(
	commandId: string,
	options: { signal?: AbortSignal; intervalMs?: number } = {},
) {
	const intervalMs = options.intervalMs ?? LOCAL_RELAY_COMMAND_POLL_INTERVAL_MS;
	const relay = await relayRequestContext();
	for (;;) {
		if (options.signal?.aborted) throw options.signal.reason;
		const response = await fetch(
			relay.path(`/commands/${encodeURIComponent(commandId)}`),
			{
				headers: relay.headers,
				credentials: "include",
				cache: "no-store",
				signal: options.signal,
			},
		);
		if (!response.ok)
			throw await responseError(response, "Relay command lookup failed");
		const command = ((await response.json()) as { command: LocalRelayCommand })
			.command;
		if (["succeeded", "failed", "cancelled"].includes(command.status))
			return command;
		await new Promise<void>((resolve, reject) => {
			const abort = () => {
				clearTimeout(timeout);
				reject(options.signal?.reason);
			};
			const timeout = setTimeout(() => {
				options.signal?.removeEventListener("abort", abort);
				resolve();
			}, intervalMs);
			options.signal?.addEventListener("abort", abort, { once: true });
		});
	}
}
