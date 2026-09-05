import {
	AGENT_HARNESSES,
	type AgentHarness,
	type HarnessReadinessEntry,
	type HarnessReadinessResponse,
} from "@cohub/protocol";

export const HARNESS_READINESS_CACHE_VERSION = 1;
export const HARNESS_READINESS_REFRESH_AFTER_MS = 5 * 60_000;
export const HARNESS_READINESS_MAX_AGE_MS = 24 * 60 * 60_000;

type PersistedHarnessReadiness = {
	version: typeof HARNESS_READINESS_CACHE_VERSION;
	userKey: string;
	updatedAt: number;
	response: HarnessReadinessResponse;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHarnessEntry(value: unknown): value is HarnessReadinessEntry {
	if (!isRecord(value)) return false;
	if (!AGENT_HARNESSES.includes(value.harness as AgentHarness)) return false;
	if (
		![
			"ready",
			"not_installed",
			"sign_in_required",
			"setup_required",
			"unavailable",
		].includes(String(value.state))
	)
		return false;
	if (value.action !== undefined) {
		if (!isRecord(value.action)) return false;
		if (!["install", "sign_in", "repair"].includes(String(value.action.kind)))
			return false;
		if (typeof value.action.label !== "string" || !value.action.label.trim())
			return false;
		if (
			value.action.command !== undefined &&
			typeof value.action.command !== "string"
		)
			return false;
		if (
			value.action.href !== undefined &&
			typeof value.action.href !== "string"
		)
			return false;
	}
	return (
		typeof value.label === "string" &&
		Boolean(value.label.trim()) &&
		typeof value.bundled === "boolean" &&
		typeof value.detail === "string" &&
		Boolean(value.detail.trim()) &&
		(value.version === undefined || typeof value.version === "string")
	);
}

export function isHarnessReadinessResponse(
	value: unknown,
): value is HarnessReadinessResponse {
	if (!isRecord(value) || !Array.isArray(value.harnesses)) return false;
	if (
		typeof value.checkedAt !== "string" ||
		!Number.isFinite(Date.parse(value.checkedAt))
	)
		return false;
	if (
		value.harnesses.length !== AGENT_HARNESSES.length ||
		!value.harnesses.every(isHarnessEntry)
	)
		return false;
	const harnesses = new Set(value.harnesses.map((entry) => entry.harness));
	return AGENT_HARNESSES.every((harness) => harnesses.has(harness));
}

function storageKey(userKey: string) {
	return `cohub:harness-readiness:v${HARNESS_READINESS_CACHE_VERSION}:${encodeURIComponent(userKey)}`;
}

export function readHarnessReadinessCache(
	storage: Storage,
	userKey: string,
	now = Date.now(),
) {
	try {
		const value = JSON.parse(storage.getItem(storageKey(userKey)) ?? "null");
		if (!isRecord(value)) return null;
		if (
			value.version !== HARNESS_READINESS_CACHE_VERSION ||
			value.userKey !== userKey ||
			typeof value.updatedAt !== "number" ||
			!Number.isFinite(value.updatedAt) ||
			now - value.updatedAt > HARNESS_READINESS_MAX_AGE_MS ||
			!isHarnessReadinessResponse(value.response)
		)
			return null;
		return {
			response: value.response,
			updatedAt: value.updatedAt,
		};
	} catch {
		return null;
	}
}

export function writeHarnessReadinessCache(
	storage: Storage,
	userKey: string,
	response: HarnessReadinessResponse,
	updatedAt = Date.now(),
) {
	if (!isHarnessReadinessResponse(response)) {
		throw new Error("Harness readiness response is invalid");
	}
	const value: PersistedHarnessReadiness = {
		version: HARNESS_READINESS_CACHE_VERSION,
		userKey,
		updatedAt,
		response,
	};
	storage.setItem(storageKey(userKey), JSON.stringify(value));
}
