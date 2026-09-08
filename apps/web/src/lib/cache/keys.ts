import { authStore } from "$lib/stores/auth.svelte";
import { IS_PERSONAL_NODE_ALPHA } from "$lib/auth";
import { currentPersonalNodeScope } from "$lib/personal-node-fetch";

/**
 * User-scoped cache partition key.
 *
 * Priority:
 * 1. Backend userUuid (stable product identity)
 * 2. Auth subject (`claims.sub`) when authenticated but /api/me is unavailable
 * 3. `guest` only for truly unauthenticated visitors
 *
 * Never share authenticated private data under a global `guest` key.
 */
export function getCacheUserKey() {
	const subject =
		typeof authStore.claims?.sub === "string"
			? authStore.claims.sub.trim()
			: "";
	const userKey = authStore.userUuid || (subject ? `sub:${subject}` : "guest");
	if (!IS_PERSONAL_NODE_ALPHA) return userKey;
	const scope = currentPersonalNodeScope();
	return scope ? `personal-node:${scope.accountId}:${scope.deviceId}:${userKey}` : `personal-node:unresolved:${userKey}`;
}

/**
 * Whether user-scoped cache IO is safe under the current identity.
 * Authenticated sessions without any isolatable key must not read/write `guest`.
 */
export function canUseUserScopedCache(userKey = getCacheUserKey()) {
	if (IS_PERSONAL_NODE_ALPHA) {
		const scope = currentPersonalNodeScope();
		return Boolean(scope && authStore.isAuthenticated && userKey.startsWith(`personal-node:${scope.accountId}:${scope.deviceId}:`));
	}
	if (userKey !== "guest") return true;
	return !authStore.isAuthenticated;
}

/**
 * Prefer this for IndexedDB / localStorage IO that is user-scoped.
 * Waits for auth hydration so cold start does not briefly use the wrong key.
 */
export async function getCacheUserKeyAsync() {
	await authStore.ensureLoaded();
	return getCacheUserKey();
}

export function encodeKeyPart(value: string) {
	return encodeURIComponent(value);
}

export function spaceRecordKey(userKey: string, spaceId: string) {
	return [userKey, spaceId].map(encodeKeyPart).join(":");
}

export function sessionListKey(userKey: string, spaceId: string) {
	return [userKey, spaceId, "recent"].map(encodeKeyPart).join(":");
}

/** User-level cross-space session list cache key. */
export function userSessionListKey(userKey: string) {
	return [userKey, "user", "sessions", "recent"].map(encodeKeyPart).join(":");
}

export function sessionListIndexKey(userKey: string, spaceId: string) {
	return [userKey, spaceId, "recent", "index"].map(encodeKeyPart).join(":");
}

export function sessionDetailKey(
	userKey: string,
	spaceId: string,
	sessionId: string,
) {
	return [userKey, spaceId, sessionId, "detail"].map(encodeKeyPart).join(":");
}

export function labelTreeKey(userKey: string, spaceId: string) {
	return [userKey, spaceId, "labels"].map(encodeKeyPart).join(":");
}

export function labelItemsKey(
	userKey: string,
	spaceId: string,
	labelId: string,
) {
	return [userKey, spaceId, labelId, "items-v2"].map(encodeKeyPart).join(":");
}

export function resourceLabelsKey(
	userKey: string,
	spaceId: string,
	resourceType: string,
	resourceRef: string,
) {
	return [userKey, spaceId, resourceType, resourceRef]
		.map(encodeKeyPart)
		.join(":");
}

export function userProfileKey(userKey: string, userUuid: string) {
	return [userKey, "user-profile", userUuid].map(encodeKeyPart).join(":");
}

export function filePendingDraftKey(
	userKey: string,
	spaceId: string,
	path: string,
) {
	return [userKey, spaceId, path, "file-draft"].map(encodeKeyPart).join(":");
}

export function boardPendingTransactionKey(
	userKey: string,
	spaceId: string,
	boardId: string,
	txId: string,
) {
	return [userKey, spaceId, boardId, txId].map(encodeKeyPart).join(":");
}

export function taskRunKey(
	userKey: string,
	spaceId: string,
	taskRunId: string,
) {
	return [userKey, spaceId, taskRunId].map(encodeKeyPart).join(":");
}

export function sessionTurnsKey(
	userKey: string,
	spaceId: string,
	sessionId: string,
) {
	return [userKey, spaceId, sessionId, "turns-v2"].map(encodeKeyPart).join(":");
}

export function sessionGenerationSnapshotKey(
	userKey: string,
	spaceId: string,
	sessionId: string,
) {
	return [userKey, spaceId, sessionId, "generation"]
		.map(encodeKeyPart)
		.join(":");
}

export function spaceFsDirKey(
	userKey: string,
	spaceId: string,
	dirPath: string,
) {
	return [userKey, spaceId, normalizeDirPath(dirPath)]
		.map(encodeKeyPart)
		.join(":");
}

export function spaceFsEpochKey(userKey: string, spaceId: string) {
	return [userKey, spaceId, "fs-epoch"].map(encodeKeyPart).join(":");
}

export function normalizeDirPath(dirPath: string) {
	return dirPath.trim().replace(/^\/+|\/+$/g, "");
}
