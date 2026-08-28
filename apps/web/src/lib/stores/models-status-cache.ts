import type { ModelStatusResponse } from "@cohub/protocol/model/status";

const STORAGE_KEY = "cohub:model-status:v1";
export const MODEL_STATUS_CACHE_REFRESH_AFTER_MS = 5 * 60 * 1000;
export const MODEL_STATUS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type PersistedModelStatus = {
	version: 1;
	updatedAt: number;
	status: ModelStatusResponse;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStatus(value: unknown): value is ModelStatusResponse {
	return isRecord(value) && isRecord(value.models);
}

export function readModelsStatusCache(
	storage: Storage,
	now = Date.now(),
): { status: ModelStatusResponse; updatedAt: number } | null {
	try {
		const parsed = JSON.parse(
			storage.getItem(STORAGE_KEY) ?? "null",
		) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1) return null;
		if (
			typeof parsed.updatedAt !== "number" ||
			!Number.isFinite(parsed.updatedAt)
		)
			return null;
		if (
			now - parsed.updatedAt > MODEL_STATUS_CACHE_MAX_AGE_MS ||
			!isStatus(parsed.status)
		)
			return null;
		return { status: parsed.status, updatedAt: parsed.updatedAt };
	} catch {
		return null;
	}
}

export function writeModelsStatusCache(
	storage: Storage,
	status: ModelStatusResponse,
	updatedAt = Date.now(),
) {
	if (!isStatus(status)) return;
	const value: PersistedModelStatus = { version: 1, updatedAt, status };
	storage.setItem(STORAGE_KEY, JSON.stringify(value));
}
