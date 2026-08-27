import type { PromptTemplateCatalogEntry } from "@neta-art/cohub";
import {
	canUseUserScopedCache,
	encodeKeyPart,
	getCacheUserKey,
} from "$lib/cache/keys";

const CACHE_VERSION = 3;

function getCacheKey(spaceId: string, userKey: string) {
	return `cohub:space-prompt-templates:${encodeKeyPart(userKey)}:${encodeKeyPart(spaceId)}:v${CACHE_VERSION}`;
}

function isPromptTemplate(value: unknown): value is PromptTemplateCatalogEntry {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.name === "string" &&
		typeof record.description === "string" &&
		(record.argumentHint === undefined ||
			typeof record.argumentHint === "string") &&
		(record.category === undefined || typeof record.category === "string") &&
		(record.quickAction === undefined ||
			typeof record.quickAction === "boolean") &&
		(record.buttonLabel === undefined ||
			typeof record.buttonLabel === "string") &&
		(record.order === undefined || typeof record.order === "number") &&
		(record.scope === "platform" ||
			record.scope === "mod" ||
			record.scope === "user" ||
			record.scope === "project")
	);
}

export function readCachedPromptTemplates(spaceId: string) {
	if (typeof localStorage === "undefined") return null;
	const userKey = getCacheUserKey();
	if (!canUseUserScopedCache(userKey)) return null;
	try {
		const raw = localStorage.getItem(getCacheKey(spaceId, userKey));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if (record.version !== CACHE_VERSION || !Array.isArray(record.prompts)) {
			return null;
		}
		if (!record.prompts.every(isPromptTemplate)) return null;
		return record.prompts;
	} catch {
		return null;
	}
}

export function writeCachedPromptTemplates(
	spaceId: string,
	prompts: PromptTemplateCatalogEntry[],
) {
	if (typeof localStorage === "undefined") return;
	const userKey = getCacheUserKey();
	if (!canUseUserScopedCache(userKey)) return;
	try {
		localStorage.setItem(
			getCacheKey(spaceId, userKey),
			JSON.stringify({ version: CACHE_VERSION, prompts }),
		);
	} catch {
		// Cache writes are best-effort and should never block workspace boot.
	}
}
