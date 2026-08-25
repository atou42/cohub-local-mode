import { env } from "$env/dynamic/public";

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

export const isLocalRelayEnabled =
	env.PUBLIC_LOCAL_RELAY_ENABLED?.trim() === "true";

function relayNodePath(suffix: string) {
	return `${relayBasePath}/v1/nodes/${encodeURIComponent(relayNodeId)}${suffix}`;
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
	const response = await fetch(relayNodePath("/status"), {
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
	return new Error(`${message} (${code})`);
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
	const contentType = input.file.type || "application/octet-stream";
	const sha256 = bytesToHex(
		await crypto.subtle.digest("SHA-256", await input.file.arrayBuffer()),
	);
	const planResponse = await fetch(relayNodePath("/attachments"), {
		method: "POST",
		headers: { "content-type": "application/json" },
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
		headers: plan.upload.headers,
		file: input.file,
		onProgress: input.onProgress,
		signal: input.signal,
	});
	const contentUrl = relayNodePath(
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
	const response = await fetch(relayNodePath("/commands"), {
		method: "POST",
		headers: { "content-type": "application/json" },
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

export async function waitForLocalRelayCommand(
	commandId: string,
	options: { signal?: AbortSignal; intervalMs?: number } = {},
) {
	const intervalMs = options.intervalMs ?? 250;
	for (;;) {
		if (options.signal?.aborted) throw options.signal.reason;
		const response = await fetch(
			relayNodePath(`/commands/${encodeURIComponent(commandId)}`),
			{ credentials: "include", cache: "no-store", signal: options.signal },
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
