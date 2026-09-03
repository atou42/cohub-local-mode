export type PersonalNodeConnectorStatus = {
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

export type PersonalNodeStatusSnapshot = {
	connected: boolean;
	connector: PersonalNodeConnectorStatus | null;
};

export type PersonalNodeStatusNotice = {
	kind: "progress" | "error";
	text: string;
};

const connectorStates = new Set<PersonalNodeConnectorStatus["state"]>([
	"signed-out",
	"initializing",
	"local-runtime-unavailable",
	"connecting",
	"connected",
	"recovering",
	"error",
	"stopped",
]);

export function parsePersonalNodeStatusSnapshot(
	value: unknown,
): PersonalNodeStatusSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Connector status response is invalid");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.connected !== "boolean") {
		throw new Error("Connector status response is invalid");
	}
	if (record.connector === undefined || record.connector === null) {
		return { connected: record.connected, connector: null };
	}
	if (typeof record.connector !== "object" || Array.isArray(record.connector)) {
		throw new Error("Connector status response is invalid");
	}
	const connector = record.connector as Record<string, unknown>;
	const integerOrNull = (field: string) => {
		const candidate = connector[field];
		if (candidate === null) return null;
		if (
			!Number.isInteger(candidate) ||
			Number(candidate) < 1 ||
			Number(candidate) > 100
		) {
			throw new Error("Connector status response is invalid");
		}
		return Number(candidate);
	};
	if (
		typeof connector.state !== "string" ||
		!connectorStates.has(
			connector.state as PersonalNodeConnectorStatus["state"],
		) ||
		(connector.message !== null && typeof connector.message !== "string") ||
		typeof connector.appVersion !== "string" ||
		!connector.appVersion ||
		typeof connector.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(connector.updatedAt))
	) {
		throw new Error("Connector status response is invalid");
	}
	return {
		connected: record.connected,
		connector: {
			state: connector.state as PersonalNodeConnectorStatus["state"],
			message: connector.message as string | null,
			attempt: integerOrNull("attempt"),
			maxAttempts: integerOrNull("maxAttempts"),
			appVersion: connector.appVersion,
			updatedAt: connector.updatedAt,
		},
	};
}

export function personalNodeStatusNotice(
	status: PersonalNodeStatusSnapshot,
): PersonalNodeStatusNotice | null {
	const connector = status.connector;
	if (status.connected && (!connector || connector.state === "connected")) {
		return null;
	}
	if (!connector) return { kind: "error", text: "Local Mac is offline." };
	if (connector.state === "recovering") {
		const progress =
			connector.attempt && connector.maxAttempts
				? ` (${connector.attempt}/${connector.maxAttempts})`
				: "";
		return {
			kind: "progress",
			text: `Recovering local services${progress}${connector.message ? `: ${connector.message}` : ""}`,
		};
	}
	if (connector.state === "initializing") {
		return { kind: "progress", text: "Starting local services on this Mac..." };
	}
	if (connector.state === "connecting") {
		return {
			kind: "progress",
			text: connector.message ?? "Connecting this Mac to Cohub...",
		};
	}
	if (connector.state === "stopped") {
		return { kind: "error", text: "Cohub Connector was quit on this Mac." };
	}
	if (connector.state === "signed-out") {
		return {
			kind: "error",
			text: connector.message ?? "Cohub Connector needs sign-in.",
		};
	}
	if (
		connector.state === "error" ||
		connector.state === "local-runtime-unavailable"
	) {
		return {
			kind: "error",
			text: connector.message ?? "Local services on this Mac need attention.",
		};
	}
	return status.connected
		? null
		: { kind: "error", text: "Local Mac is offline." };
}
