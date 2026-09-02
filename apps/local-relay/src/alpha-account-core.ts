import { RelayProtocolError } from "./protocol.ts";

export const ALPHA_ACCOUNT_SCHEMA_VERSION = 1 as const;
export const ALPHA_MAX_DEVICES_PER_ACCOUNT = 10;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export type AlphaDevicePlatform = "macos";
export type AlphaDeviceStatus = "active" | "revoked";

export type AlphaDeviceRecord = {
	schemaVersion: typeof ALPHA_ACCOUNT_SCHEMA_VERSION;
	id: string;
	installationId: string;
	displayName: string;
	platform: AlphaDevicePlatform;
	appVersion: string | null;
	credentialHash: string;
	status: AlphaDeviceStatus;
	createdAt: string;
	updatedAt: string;
	lastSeenAt: string | null;
	revokedAt: string | null;
};

export type AlphaDeviceRegistrationInput = {
	installationId: string;
	displayName: string;
	platform: AlphaDevicePlatform;
	appVersion: string | null;
	credentialHash: string;
};

function requiredString(value: unknown, field: string, maxLength: number) {
	if (typeof value !== "string" || !value.trim()) {
		throw new RelayProtocolError(
			"alpha_device_invalid",
			`${field} is required`,
		);
	}
	const normalized = value.trim();
	if (normalized.length > maxLength) {
		throw new RelayProtocolError(
			"alpha_device_invalid",
			`${field} is too long`,
		);
	}
	return normalized;
}

export function parseAlphaDeviceRegistration(
	value: unknown,
): AlphaDeviceRegistrationInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RelayProtocolError(
			"alpha_device_invalid",
			"Device registration must be an object",
		);
	}
	const input = value as Record<string, unknown>;
	const installationId = requiredString(
		input.installationId,
		"installationId",
		36,
	).toLowerCase();
	if (!UUID_PATTERN.test(installationId)) {
		throw new RelayProtocolError(
			"alpha_device_invalid",
			"installationId must be a UUID",
		);
	}
	if (input.platform !== "macos") {
		throw new RelayProtocolError(
			"alpha_device_platform_unsupported",
			"Personal Node Alpha supports macOS only",
			422,
		);
	}
	const credentialHash = requiredString(
		input.credentialHash,
		"credentialHash",
		64,
	).toLowerCase();
	if (!SHA256_PATTERN.test(credentialHash)) {
		throw new RelayProtocolError(
			"alpha_device_invalid",
			"credentialHash must be a SHA-256 hex digest",
		);
	}
	const appVersion =
		input.appVersion === undefined || input.appVersion === null
			? null
			: requiredString(input.appVersion, "appVersion", 64);
	return {
		installationId,
		displayName: requiredString(input.displayName, "displayName", 80),
		platform: "macos",
		appVersion,
		credentialHash,
	};
}

export function createAlphaDeviceRecord(input: {
	registration: AlphaDeviceRegistrationInput;
	deviceId: string;
	now: string;
}): AlphaDeviceRecord {
	if (!UUID_PATTERN.test(input.deviceId)) {
		throw new Error("deviceId must be a UUID");
	}
	return {
		schemaVersion: ALPHA_ACCOUNT_SCHEMA_VERSION,
		id: input.deviceId.toLowerCase(),
		...input.registration,
		status: "active",
		createdAt: input.now,
		updatedAt: input.now,
		lastSeenAt: null,
		revokedAt: null,
	};
}

export function updateAlphaDeviceRegistration(input: {
	existing: AlphaDeviceRecord;
	registration: AlphaDeviceRegistrationInput;
	now: string;
}) {
	if (input.existing.status === "revoked") {
		throw new RelayProtocolError(
			"alpha_device_revoked",
			"Revoked device installations cannot be registered again",
			409,
		);
	}
	if (input.existing.credentialHash !== input.registration.credentialHash) {
		throw new RelayProtocolError(
			"alpha_device_credential_conflict",
			"Device credential differs; use credential rotation",
			409,
		);
	}
	return {
		...input.existing,
		displayName: input.registration.displayName,
		appVersion: input.registration.appVersion,
		updatedAt: input.now,
	};
}

export function rotateAlphaDeviceCredential(input: {
	existing: AlphaDeviceRecord;
	credentialHash: unknown;
	now: string;
}) {
	if (input.existing.status !== "active") {
		throw new RelayProtocolError(
			"alpha_device_revoked",
			"Revoked devices cannot rotate credentials",
			409,
		);
	}
	const credentialHash = requiredString(
		input.credentialHash,
		"credentialHash",
		64,
	).toLowerCase();
	if (!SHA256_PATTERN.test(credentialHash)) {
		throw new RelayProtocolError(
			"alpha_device_invalid",
			"credentialHash must be a SHA-256 hex digest",
		);
	}
	return { ...input.existing, credentialHash, updatedAt: input.now };
}

export function revokeAlphaDevice(
	existing: AlphaDeviceRecord,
	now: string,
) {
	if (existing.status === "revoked") return existing;
	return {
		...existing,
		status: "revoked" as const,
		updatedAt: now,
		revokedAt: now,
	};
}

export function alphaDeviceCredentialMatches(
	device: AlphaDeviceRecord,
	credentialHash: string,
) {
	return (
		device.status === "active" &&
		SHA256_PATTERN.test(credentialHash) &&
		device.credentialHash === credentialHash.toLowerCase()
	);
}

export function publicAlphaDevice(device: AlphaDeviceRecord) {
	const { credentialHash: _credentialHash, ...safe } = device;
	return safe;
}
