import {
	type PersonalNodeStatusSnapshot,
	parsePersonalNodeStatusSnapshot,
} from "$lib/personal-node-status";
import { personalNodeBodyStream, transferPersonalNodeRequestBody, uploadPersonalNodeBodyPart } from "$lib/personal-node-http-body";
import { localRelayRequestTimeoutMs } from "@cohub/protocol/local-relay-request-timeout";
import { PERSONAL_NODE_STATUS_REFRESH_MS, PersonalNodeControlError } from "$lib/personal-node-status-polling";
import {
	buildPersonalNodeApiCommand,
	buildPersonalNodeReadCommand,
	encodePersonalNodeRequestBody,
	isPersonalNodeCommandTerminal,
	type PersonalNodeDevice,
	type PersonalNodeRelayCommand,
	personalNodeCommandResponse,
	selectPersonalNodeDevice,
} from "$lib/personal-node-transport-core";

const ACTIVE_DEVICE_STORAGE_KEY = "cohub:personal-node:active-device";
const DEVICE_CACHE_MS = PERSONAL_NODE_STATUS_REFRESH_MS;
const STATUS_CACHE_MS = PERSONAL_NODE_STATUS_REFRESH_MS;
const READ_TIMEOUT_MS = 30_000;

let deviceCache: {
	device: PersonalNodeDevice;
	resolvedAt: number;
	authorization: string;
} | null = null;
let statusCache: {
	deviceId: string;
	authorization: string;
	status: PersonalNodeStatusSnapshot;
	resolvedAt: number;
} | null = null;
const inFlightReads = new Map<string, Promise<Response>>();
const inFlightControlReads = new Map<string, Promise<Response>>();
let serviceFailure: PersonalNodeControlError | null = null;
let devicesCache: { authorization: string; accountId: string; devices: PersonalNodeDevice[]; generation: number; resolvedAt: number } | null = null;
let readGeneration = 0;
let authorizationGeneration = 0;
let activeAuthorization = "";
let accountCache: { authorization: string; accountId: string } | null = null;

export function invalidatePersonalNodeRequests() {
	authorizationGeneration += 1;
	readGeneration += 1;
	activeAuthorization = "";
	accountCache = null;
	deviceCache = null;
	statusCache = null;
	devicesCache = null;
	serviceFailure = null;
	inFlightControlReads.clear();
}

function requestGeneration(authorization: string) {
	if (activeAuthorization !== authorization) {
		invalidatePersonalNodeRequests();
		activeAuthorization = authorization;
	}
	return authorizationGeneration;
}

function assertRequestCurrent(generation: number) {
	if (generation !== authorizationGeneration) throw new Error("Personal Node account or device changed; discard the previous response");
}

function assertControlAvailable() {
	if (serviceFailure && Date.now() < serviceFailure.retryAt) throw serviceFailure;
}

async function fetchControl(path: string, label: string, authorization: string, generation: number) {
	assertRequestCurrent(generation);
	assertControlAvailable();
	const key = `${generation}\0${path}`;
	const existing = inFlightControlReads.get(key);
	if (existing) return (await existing).clone();
	const operation = (async () => {
		let response: Response;
		try {
			response = await fetch(path, { headers: { authorization }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
		} catch (error) {
			assertRequestCurrent(generation);
			serviceFailure = new PersonalNodeControlError(error instanceof Error ? error.message : String(error), Date.now() + 30_000);
			throw serviceFailure;
		}
		assertRequestCurrent(generation);
		if (!response.ok) {
			const retryAfter = response.headers.get("retry-after");
			const requestedMs = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - Date.now();
			const delay = Number.isFinite(requestedMs) ? Math.max(30_000, Math.min(3_600_000, requestedMs)) : 30_000;
			const error = new PersonalNodeControlError(`Personal Node ${label} returned HTTP ${response.status}`, Date.now() + delay);
			if (response.status === 429 || response.status >= 500) serviceFailure = error;
			throw error;
		}
		return response;
	})();
	inFlightControlReads.set(key, operation);
	try { return (await operation).clone(); }
	finally { if (inFlightControlReads.get(key) === operation) inFlightControlReads.delete(key); }
}

export function currentPersonalNodeScope() {
	if (!accountCache || !deviceCache || deviceCache.authorization !== activeAuthorization) return null;
	return { accountId: accountCache.accountId, deviceId: deviceCache.device.id, generation: authorizationGeneration };
}

async function resolveAccount(authorization: string, generation: number) {
	assertControlAvailable();
	if (accountCache?.authorization === authorization) return accountCache.accountId;
	const response = await fetchControl("/api/alpha/v1/account", "account", authorization, generation);
	assertRequestCurrent(generation);
	if (!response.ok) throw new Error(`Personal Node account returned HTTP ${response.status}`);
	const payload = await response.json();
	assertRequestCurrent(generation);
	if (typeof payload?.accountId !== "string" || !/^[a-f0-9]{64}$/.test(payload.accountId)) throw new Error("Personal Node account is invalid");
	accountCache = { authorization, accountId: payload.accountId };
	return payload.accountId as string;
}

function errorResponse(code: string, message: string, status: number) {
	return Response.json({ code, message }, { status });
}

function authorizationHeader(request: Request) {
	const value = request.headers.get("authorization")?.trim() ?? "";
	if (!/^Bearer\s+\S+/i.test(value)) return null;
	return value;
}

function preferredDeviceId(accountId: string) {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(`${ACTIVE_DEVICE_STORAGE_KEY}:${accountId}`);
}

function rememberDevice(accountId: string, deviceId: string) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(`${ACTIVE_DEVICE_STORAGE_KEY}:${accountId}`, deviceId);
	} catch {
		// Selection remains available in memory when browser storage is unavailable.
	}
}

export async function listPersonalNodeDevices(authorization: string, options: { refresh?: boolean } = {}) {
	const generation = requestGeneration(authorization);
	const accountId = await resolveAccount(authorization, generation);
	assertRequestCurrent(generation);
	if (!options.refresh && devicesCache?.authorization === authorization && Date.now() - devicesCache.resolvedAt < DEVICE_CACHE_MS) {
		return { accountId, devices: devicesCache.devices, generation };
	}
	const response = await fetchControl("/api/alpha/v1/devices", "devices", authorization, generation);
	assertRequestCurrent(generation);
	if (!response.ok) {
		throw new Error(`Personal Node devices returned HTTP ${response.status}`);
	}
	const payload = (await response.json()) as {
		devices?: PersonalNodeDevice[];
	} | null;
	assertRequestCurrent(generation);
	if (
		!Array.isArray(payload?.devices) ||
		payload.devices.some((device) =>
			!device || typeof device.id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device.id) ||
			typeof device.displayName !== "string" ||
			!["active", "revoked"].includes(device.status)
		)
	) throw new Error("Personal Node device list is invalid");
	devicesCache = { authorization, accountId, devices: payload.devices, generation, resolvedAt: Date.now() };
	return { accountId, devices: payload.devices, generation };
}

export async function choosePersonalNodeDevice(authorization: string, deviceId: string) {
	const { accountId, devices, generation } = await listPersonalNodeDevices(authorization, { refresh: true });
	assertRequestCurrent(generation);
	const device = devices.find((entry) => entry.id === deviceId && entry.status === "active");
	if (!device) throw new Error("The selected Personal Node device is unavailable");
	// An explicit switch reloads the app. Never claim it persisted if storage failed.
	if (typeof localStorage !== "undefined") localStorage.setItem(`${ACTIVE_DEVICE_STORAGE_KEY}:${accountId}`, device.id);
	invalidatePersonalNodeRequests();
	activeAuthorization = authorization;
	accountCache = { authorization, accountId };
	deviceCache = { authorization, device, resolvedAt: Date.now() };
	return device;
}

export async function resolvePersonalNodeDevice(authorization: string) {
	const generation = requestGeneration(authorization);
	const accountId = await resolveAccount(authorization, generation);
	assertRequestCurrent(generation);
	if (deviceCache?.authorization === authorization && Date.now() - deviceCache.resolvedAt < DEVICE_CACHE_MS) return deviceCache.device;
	const { devices } = await listPersonalNodeDevices(authorization);
	const preferredId = preferredDeviceId(accountId);
	const device = selectPersonalNodeDevice(devices, preferredId);
	if (deviceCache && device && deviceCache.device.id !== device.id) {
		throw new Error("The Personal Node device changed in another tab; reload before continuing");
	}
	if (!device && preferredId) throw new Error("The selected Personal Node device is unavailable; choose a device explicitly");
	if (!device) return null;
	rememberDevice(accountId, device.id);
	deviceCache = { device, resolvedAt: Date.now(), authorization };
	return device;
}

export async function isPersonalNodeDeviceConnected(
	deviceId: string,
	authorization: string,
) {
	return (await getPersonalNodeDeviceStatus(deviceId, authorization)).connected;
}

export async function getPersonalNodeDeviceStatus(
	deviceId: string,
	authorization: string,
) {
	const generation = requestGeneration(authorization);
	assertControlAvailable();
	if (
		statusCache?.deviceId === deviceId &&
		statusCache.authorization === authorization &&
		Date.now() - statusCache.resolvedAt < STATUS_CACHE_MS
	) {
		return statusCache.status;
	}
	const response = await fetchControl(
		`/api/alpha/v1/nodes/${encodeURIComponent(deviceId)}/status`,
		"status", authorization, generation,
	);
	assertRequestCurrent(generation);
	if (!response.ok) {
		throw new Error(`Personal Node status returned HTTP ${response.status}`);
	}
	const status = parsePersonalNodeStatusSnapshot(
		await response.json().catch(() => null),
	);
	assertRequestCurrent(generation);
	statusCache = { deviceId, authorization, status, resolvedAt: Date.now() };
	return status;
}

async function waitForCommand(input: {
	deviceId: string;
	command: PersonalNodeRelayCommand;
	authorization: string;
	generation: number;
	operationId: string;
	method: string;
	timeoutMs?: number;
}) {
	assertRequestCurrent(input.generation);
	let command = input.command;
	const deadline = Date.now() + (input.timeoutMs ?? READ_TIMEOUT_MS);
	let delayMs = 80;
	while (!isPersonalNodeCommandTerminal(command) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		assertRequestCurrent(input.generation);
		delayMs = Math.min(500, Math.ceil(delayMs * 1.5));
		const response = await fetch(
			`/api/alpha/v1/nodes/${encodeURIComponent(input.deviceId)}/commands/${encodeURIComponent(command.id)}`,
			{ headers: { authorization: input.authorization }, cache: "no-store" },
		);
		assertRequestCurrent(input.generation);
		if (!response.ok) return response;
		const payload = (await response.json()) as {
			command: PersonalNodeRelayCommand;
		};
		command = payload.command;
		assertRequestCurrent(input.generation);
	}
	if (isPersonalNodeCommandTerminal(command)) {
		const body = command.result?.bodyParts ? personalNodeBodyStream(command.result.bodyParts, {
			basePath: `/api/alpha/v1/nodes/${encodeURIComponent(input.deviceId)}`, authorization: input.authorization, assertCurrent: () => assertRequestCurrent(input.generation),
		}) : undefined;
		const response = personalNodeCommandResponse(command, body);
		response.headers.set("x-cohub-operation-id", input.operationId);
		response.headers.set("x-cohub-command-id", command.id);
		return response;
	}
	if (input.method === "GET") void fetch(
		`/api/alpha/v1/nodes/${encodeURIComponent(input.deviceId)}/commands/${encodeURIComponent(command.id)}/cancel`,
		{
			method: "POST",
			headers: { authorization: input.authorization },
			cache: "no-store",
		},
	).catch(() => {});
	return Response.json({
		code: "personal_node_result_pending", operationId: input.operationId, commandId: command.id, deviceId: input.deviceId,
		commandStatus: command.status,
		message: `The operation is still ${command.status}. Its result is not yet known; do not resend it. Operation ${input.operationId}`,
	}, { status: 504 });
}

async function executeRequest(request: Request, selectedDevice?: PersonalNodeDevice) {
	const authorization = authorizationHeader(request);
	if (!authorization) {
		return errorResponse(
			"personal_node_auth_required",
			"Personal Node sign-in is required",
			401,
		);
	}
	const generation = requestGeneration(authorization);
	const device = selectedDevice ?? await resolvePersonalNodeDevice(authorization);
	assertRequestCurrent(generation);
	if (!device) {
		return errorResponse(
			"personal_node_missing",
			"No active Personal Node is registered",
			409,
		);
	}
	if (!(await isPersonalNodeDeviceConnected(device.id, authorization))) {
		return errorResponse(
			"personal_node_offline",
			`${device.displayName} is offline`,
			503,
		);
	}
	assertRequestCurrent(generation);
	const url = new URL(request.url);
	const transferred = request.method === "GET" ? { bytes: new Uint8Array(0) } : await transferPersonalNodeRequestBody(request, (bytes) => uploadPersonalNodeBodyPart(bytes, {
		basePath: `/api/alpha/v1/nodes/${encodeURIComponent(device.id)}`, authorization, assertCurrent: () => assertRequestCurrent(generation), signal: request.signal,
	}));
	const encoded = transferred.bodyParts ? { body: "", bodyParts: transferred.bodyParts, bodyEncoding: undefined } : await encodePersonalNodeRequestBody(request, transferred.bytes);
	let operationId = request.headers.get("x-cohub-operation-id") ?? request.headers.get("idempotency-key") ?? undefined;
	if (!operationId && !encoded.bodyEncoding && encoded.body.startsWith("{")) {
		try {
			const body = JSON.parse(encoded.body);
			const stable = body.clientMessageId ?? body.mutationId;
			if (typeof stable === "string") operationId = stable;
		} catch { /* Invalid JSON is left for the API to reject. */ }
	}
	const commandInput =
		request.method === "GET"
			? buildPersonalNodeReadCommand(`${url.pathname}${url.search}`, request.headers)
			: buildPersonalNodeApiCommand({
					method: request.method,
					path: `${url.pathname}${url.search}`,
					...encoded,
					headers: request.headers,
					idempotencyKey: operationId,
				});
	assertRequestCurrent(generation);
	const basePath = `/api/alpha/v1/nodes/${encodeURIComponent(device.id)}`;
	const unknown = (commandId?: string) => Response.json({
		code: "personal_node_outcome_unknown", operationId: commandInput.idempotencyKey, deviceId: device.id, ...(commandId ? { commandId } : {}),
		message: `The operation response was lost. Check operation ${commandInput.idempotencyKey} before retrying; it was not sent again.`,
	}, { status: 504, headers: { "x-cohub-operation-id": commandInput.idempotencyKey } });
	let response: Response | null = null;
	try {
		response = await fetch(`${basePath}/commands`, {
			method: "POST", headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify(commandInput), cache: "no-store", signal: request.signal,
		});
	} catch {
		assertRequestCurrent(generation);
	}
	assertRequestCurrent(generation);
	if (!response || response.status >= 500) {
		try {
			response = await fetch(`${basePath}/operations/${encodeURIComponent(commandInput.idempotencyKey)}`, { headers: { authorization }, cache: "no-store" });
		} catch { assertRequestCurrent(generation); return unknown(); }
		assertRequestCurrent(generation);
		if (response.status === 404 || response.status >= 500) return unknown();
	}
	if (!response.ok) return response;
	let command: PersonalNodeRelayCommand;
	try {
		const payload = await response.json();
		if (!payload?.command || typeof payload.command.id !== "string" || !["accepted", "queued", "claimed", "running", "succeeded", "failed", "cancelled"].includes(payload.command.status)) throw new Error("Invalid relay command response");
		command = payload.command;
	} catch { assertRequestCurrent(generation); return unknown(); }
	return waitForCommand({
		deviceId: device.id,
		command,
		authorization,
		generation,
		operationId: commandInput.idempotencyKey,
		method: request.method,
		timeoutMs: localRelayRequestTimeoutMs(commandInput.request, READ_TIMEOUT_MS),
	}).catch(() => { assertRequestCurrent(generation); return unknown(command.id); });
}

export const personalNodeFetch: typeof fetch = async (input, init) => {
	const request = new Request(input, init);
	if (request.method !== "GET") {
		// Reads issued after a mutation must not reuse a pre-mutation request.
		readGeneration += 1;
		try {
			return await executeRequest(request);
		} finally {
			readGeneration += 1;
		}
	}
	const authorization = authorizationHeader(request) ?? "";
	const generation = requestGeneration(authorization);
	const device = authorization
		? await resolvePersonalNodeDevice(authorization)
		: null;
	assertRequestCurrent(generation);
	if (!device) return executeRequest(request);
	const key = `${authorization}\0${device.id}\0${readGeneration}\0${request.url}`;
	const existing = inFlightReads.get(key);
	if (existing) return (await existing).clone();
	const operation = executeRequest(request, device).finally(() => {
		inFlightReads.delete(key);
	});
	inFlightReads.set(key, operation);
	return (await operation).clone();
};
