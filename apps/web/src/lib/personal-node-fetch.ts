import {
	type PersonalNodeStatusSnapshot,
	parsePersonalNodeStatusSnapshot,
} from "$lib/personal-node-status";
import {
	buildPersonalNodeApiCommand,
	buildPersonalNodeReadCommand,
	isPersonalNodeCommandTerminal,
	type PersonalNodeDevice,
	type PersonalNodeRelayCommand,
	personalNodeCommandResponse,
	selectPersonalNodeDevice,
} from "$lib/personal-node-transport-core";

const ACTIVE_DEVICE_STORAGE_KEY = "cohub:personal-node:active-device";
const DEVICE_CACHE_MS = 10_000;
const STATUS_CACHE_MS = 2_000;
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
let readGeneration = 0;

function errorResponse(code: string, message: string, status: number) {
	return Response.json({ code, message }, { status });
}

function authorizationHeader(request: Request) {
	const value = request.headers.get("authorization")?.trim() ?? "";
	if (!/^Bearer\s+\S+/i.test(value)) return null;
	return value;
}

function preferredDeviceId() {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem(ACTIVE_DEVICE_STORAGE_KEY);
	} catch {
		return null;
	}
}

function rememberDevice(deviceId: string) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(ACTIVE_DEVICE_STORAGE_KEY, deviceId);
	} catch {
		// Selection remains available in memory when browser storage is unavailable.
	}
}

export async function resolvePersonalNodeDevice(authorization: string) {
	if (
		deviceCache?.authorization === authorization &&
		Date.now() - deviceCache.resolvedAt < DEVICE_CACHE_MS
	) {
		return deviceCache.device;
	}
	const response = await fetch("/api/alpha/v1/devices", {
		headers: { authorization },
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(`Personal Node devices returned HTTP ${response.status}`);
	}
	const payload = (await response.json()) as {
		devices?: PersonalNodeDevice[];
	} | null;
	if (
		!Array.isArray(payload?.devices) ||
		payload.devices.some((device) =>
			!device || typeof device.id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device.id) ||
			typeof device.displayName !== "string" ||
			!["active", "revoked"].includes(device.status)
		)
	) throw new Error("Personal Node device list is invalid");
	const device = selectPersonalNodeDevice(
		payload.devices,
		preferredDeviceId(),
	);
	if (!device) return null;
	rememberDevice(device.id);
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
	if (
		statusCache?.deviceId === deviceId &&
		statusCache.authorization === authorization &&
		Date.now() - statusCache.resolvedAt < STATUS_CACHE_MS
	) {
		return statusCache.status;
	}
	const response = await fetch(
		`/api/alpha/v1/nodes/${encodeURIComponent(deviceId)}/status`,
		{ headers: { authorization }, cache: "no-store" },
	);
	if (!response.ok) {
		throw new Error(`Personal Node status returned HTTP ${response.status}`);
	}
	const status = parsePersonalNodeStatusSnapshot(
		await response.json().catch(() => null),
	);
	statusCache = { deviceId, authorization, status, resolvedAt: Date.now() };
	return status;
}

async function waitForCommand(input: {
	deviceId: string;
	command: PersonalNodeRelayCommand;
	authorization: string;
}) {
	let command = input.command;
	const deadline = Date.now() + READ_TIMEOUT_MS;
	let delayMs = 80;
	while (!isPersonalNodeCommandTerminal(command) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		delayMs = Math.min(500, Math.ceil(delayMs * 1.5));
		const response = await fetch(
			`/api/alpha/v1/nodes/${encodeURIComponent(input.deviceId)}/commands/${encodeURIComponent(command.id)}`,
			{ headers: { authorization: input.authorization }, cache: "no-store" },
		);
		if (!response.ok) return response;
		const payload = (await response.json()) as {
			command: PersonalNodeRelayCommand;
		};
		command = payload.command;
	}
	if (isPersonalNodeCommandTerminal(command)) {
		return personalNodeCommandResponse(command);
	}
	void fetch(
		`/api/alpha/v1/nodes/${encodeURIComponent(input.deviceId)}/commands/${encodeURIComponent(command.id)}/cancel`,
		{
			method: "POST",
			headers: { authorization: input.authorization },
			cache: "no-store",
		},
	);
	return errorResponse(
		"personal_node_timeout",
		"Personal Node read timed out",
		504,
	);
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
	const device = selectedDevice ?? await resolvePersonalNodeDevice(authorization);
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
	const url = new URL(request.url);
	const commandInput =
		request.method === "GET"
			? buildPersonalNodeReadCommand(`${url.pathname}${url.search}`)
			: buildPersonalNodeApiCommand({
					method: request.method,
					path: `${url.pathname}${url.search}`,
					body: await request.clone().text(),
				});
	const response = await fetch(
		`/api/alpha/v1/nodes/${encodeURIComponent(device.id)}/commands`,
		{
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
			},
			body: JSON.stringify(commandInput),
			cache: "no-store",
		},
	);
	if (!response.ok) return response;
	const payload = (await response.json()) as {
		command: PersonalNodeRelayCommand;
	};
	return waitForCommand({
		deviceId: device.id,
		command: payload.command,
		authorization,
	});
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
	const device = authorization
		? await resolvePersonalNodeDevice(authorization)
		: null;
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
