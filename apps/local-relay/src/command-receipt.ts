import { RelayProtocolError, type RelayCommand, type RelayHttpRequest } from "./protocol.ts";

export type CommandReceipt = {
	schemaVersion: 1;
	commandId: string;
	idempotencyKey: string;
	fingerprint: string;
	status: "succeeded" | "failed" | "cancelled";
	completedAt: string;
};

export async function commandRequestFingerprint(request: RelayHttpRequest, attachmentIds: string[]) {
	const value = JSON.stringify({
		method: request.method, path: request.path, body: request.body,
		...(request.bodyEncoding ? { bodyEncoding: request.bodyEncoding } : {}),
		...(request.bodyParts ? { bodyParts: request.bodyParts } : {}),
		headers: Object.fromEntries(Object.entries(request.headers).sort(([a], [b]) => a.localeCompare(b))),
		attachmentIds,
	});
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCommandReceipt(value: unknown): CommandReceipt {
	const receipt = value as CommandReceipt | null;
	if (!receipt || receipt.schemaVersion !== 1 || typeof receipt.commandId !== "string" || !receipt.commandId ||
		typeof receipt.idempotencyKey !== "string" || !receipt.idempotencyKey ||
		typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
		!["succeeded", "failed", "cancelled"].includes(receipt.status) ||
		typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))) {
		throw new Error("Stored relay command receipt is invalid; refusing to replay the operation");
	}
	return receipt;
}

export async function commandReceipt(command: RelayCommand): Promise<CommandReceipt> {
	return parseCommandReceipt({
		schemaVersion: 1, commandId: command.id, idempotencyKey: command.idempotencyKey,
		fingerprint: await commandRequestFingerprint(command.request, (command.attachments ?? []).map(({ id }) => id)),
		status: command.status, completedAt: command.completedAt,
	});
}

export function assertReceiptRequest(receipt: CommandReceipt, fingerprint: string) {
	if (receipt.fingerprint !== fingerprint) {
		throw new RelayProtocolError("idempotency_conflict", "Idempotency key is already bound to a different command", 409);
	}
}

export function expiredCommandResult(receipt: CommandReceipt) {
	return {
		code: "command_result_expired", commandId: receipt.commandId, operationId: receipt.idempotencyKey,
		commandStatus: receipt.status, completedAt: receipt.completedAt,
		message: "This operation already finished, but its response is no longer retained. It was not executed again.",
	};
}
