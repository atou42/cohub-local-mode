import type { PersonalNodeBodyPart } from "./personal-node-http-body";

export type PersonalNodeDevice = {
	id: string;
	displayName: string;
	status: "active" | "revoked";
	updatedAt?: string | null;
};

export type PersonalNodeRelayResult = {
	status: number;
	headers: Record<string, string>;
	body: string;
	bodyEncoding?: "base64";
	bodyParts?: PersonalNodeBodyPart[];
};

export type PersonalNodeRelayCommand = {
	id: string;
	status:
		| "accepted"
		| "queued"
		| "claimed"
		| "running"
		| "succeeded"
		| "failed"
		| "cancelled";
	result: PersonalNodeRelayResult | null;
	errorCode: string | null;
	errorMessage: string | null;
};

export type PersonalNodeReadProjection = {
	path: string;
	result: PersonalNodeRelayResult;
	updatedAt: string;
};

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function selectPersonalNodeDevice(
	devices: PersonalNodeDevice[],
	preferredId: string | null,
) {
	const active = devices.filter(
		(device) => device.status === "active" && UUID_PATTERN.test(device.id),
	);
	if (preferredId) {
		return active.find((device) => device.id === preferredId) ?? null;
	}
	return (
		active.sort((left, right) =>
			(right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
		)[0] ?? null
	);
}

export function buildPersonalNodeReadCommand(path: string, headers?: HeadersInit) {
	return buildPersonalNodeApiCommand({ method: "GET", path, body: "", headers });
}

export function buildPersonalNodeApiCommand(input: {
	method: string;
	path: string;
	body: string;
	bodyEncoding?: "base64";
	bodyParts?: PersonalNodeBodyPart[];
	headers?: HeadersInit;
	idempotencyKey?: string;
}) {
	const method = input.method.toUpperCase();
	if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		throw new Error("Personal Node request method is not supported");
	}
	const path = input.path;
	const url = new URL(path, "https://alpha.internal");
	if (url.origin !== "https://alpha.internal" || !path.startsWith("/api/")) {
		throw new Error("Personal Node requests require a local API path");
	}
	const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
	if (!UUID_PATTERN.test(idempotencyKey)) throw new Error("Personal Node operation identity must be a UUID");
	const headers = new Headers(input.headers);
	const allowed = ["content-type", "accept", "range", "if-match", "if-none-match", "if-modified-since", "x-cohub-fs-mutation-id"];
	return {
		kind: "alpha_api",
		idempotencyKey,
		request: {
			method,
			path: `${url.pathname}${url.search}`,
			headers: Object.fromEntries(allowed.flatMap((name) => headers.has(name) ? [[name, headers.get(name)!]] : [])),
			body: input.body,
			...(input.bodyEncoding ? { bodyEncoding: input.bodyEncoding } : {}),
			...(input.bodyParts ? { bodyParts: input.bodyParts } : {}),
		},
	};
}

export function personalNodeCommandResponse(command: PersonalNodeRelayCommand, transferredBody?: BodyInit) {
	if (command.result) {
		if (command.result.bodyParts && !transferredBody) throw new Error("Personal Node response body must be downloaded before use");
		return new Response(transferredBody ?? relayResponseBody(command.result), {
			status: command.result.status,
			headers: command.result.headers,
		});
	}
	const status = command.status === "cancelled" ? 409 : 502;
	return Response.json(
		{
			code: command.errorCode ?? `personal_node_${command.status}`,
			message:
				command.errorMessage ??
				`Personal Node command ended with ${command.status}`,
		},
		{ status },
	);
}

function relayResponseBody(result: PersonalNodeRelayResult) {
	if (result.bodyEncoding !== undefined) {
		if (result.bodyEncoding !== "base64") throw new Error("Personal Node response encoding is invalid");
		const decoded = atob(result.body);
		if (btoa(decoded) !== result.body) throw new Error("Personal Node response body is invalid base64");
		if (!decoded && [204, 205, 304].includes(result.status)) return null;
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	}
	return result.body === "" && [204, 205, 304].includes(result.status)
		? null
		: result.body;
}

export async function encodePersonalNodeRequestBody(request: Request, transferredBytes?: Uint8Array) {
	const bytes = transferredBytes ?? new Uint8Array(await request.clone().arrayBuffer());
	const contentType = request.headers.get("content-type") ?? "";
	if (bytes.byteLength === 0) return { body: "" };
	if (!contentType || /\bjson\b/i.test(contentType) || /^text\//i.test(contentType)) {
		try { return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
		catch { /* Preserve non-UTF-8 bytes rather than replacing them. */ }
	}
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	return { body: btoa(binary), bodyEncoding: "base64" as const };
}

export function personalNodeProjectionResponse(
	projection: PersonalNodeReadProjection,
) {
	const headers = new Headers(projection.result.headers);
	headers.set("x-cohub-personal-node-cache", "hit");
	headers.set("x-cohub-personal-node-cache-updated-at", projection.updatedAt);
	return new Response(relayResponseBody(projection.result), {
		status: projection.result.status,
		headers,
	});
}

export function isPersonalNodeCommandTerminal(
	command: PersonalNodeRelayCommand,
) {
	return (
		command.status === "succeeded" ||
		command.status === "failed" ||
		command.status === "cancelled"
	);
}
