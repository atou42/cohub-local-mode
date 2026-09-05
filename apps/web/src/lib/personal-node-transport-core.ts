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
		const preferred = active.find((device) => device.id === preferredId);
		if (preferred) return preferred;
	}
	return (
		active.sort((left, right) =>
			(right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
		)[0] ?? null
	);
}

export function buildPersonalNodeReadCommand(path: string) {
	return buildPersonalNodeApiCommand({ method: "GET", path, body: "" });
}

export function buildPersonalNodeApiCommand(input: {
	method: string;
	path: string;
	body: string;
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
	const idempotencyKey = crypto.randomUUID();
	return {
		kind: "alpha_api",
		idempotencyKey,
		request: {
			method,
			path: `${url.pathname}${url.search}`,
			headers: {},
			body: input.body,
		},
	};
}

export function personalNodeCommandResponse(command: PersonalNodeRelayCommand) {
	if (command.result) {
		return new Response(command.result.body, {
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

export function personalNodeProjectionResponse(
	projection: PersonalNodeReadProjection,
) {
	const headers = new Headers(projection.result.headers);
	headers.set("x-cohub-personal-node-cache", "hit");
	headers.set("x-cohub-personal-node-cache-updated-at", projection.updatedAt);
	return new Response(projection.result.body, {
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
