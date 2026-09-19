import {
	RELAY_PROTOCOL_VERSION,
	type ActivitySpaceReference,
	type ActivityWatchFocus,
	type ActivityWatchPreferences,
	type ActivityWatchReplaceMessage,
} from "./protocol.ts";

export const ACTIVITY_WATCH_LEASE_MS = 2 * 60 * 1_000;

export type StoredActivityWatchPreference = {
	nodeId: string;
	installationId: string;
	ownerSubject: string;
	ownerEmail: string;
	ownerUserId: string;
	preferences: ActivityWatchPreferences;
	preferenceDigest: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
};

export type StoredActivityWatchSnapshot = ActivityWatchReplaceMessage & {
	sourceInstallationId: string | null;
	updatedAt: string;
};

export type StoredActivityWatchAck = {
	revision: number;
	digest: string;
	ackedAt: string;
};

function canonicalSpaceReference(value: ActivitySpaceReference) {
	return { origin: value.origin, spaceId: value.spaceId };
}

export function canonicalActivityWatchPreferences(
	preferences: ActivityWatchPreferences,
) {
	return JSON.stringify({
		watchedSpaces: preferences.watchedSpaces.map(canonicalSpaceReference),
		focus: preferences.focus
			? {
					origin: preferences.focus.origin,
					spaceId: preferences.focus.spaceId,
					sessionId: preferences.focus.sessionId,
					explicit: preferences.focus.explicit,
				}
			: null,
	});
}

export function canonicalActivityWatchScope(input: {
	ownerUserId: string;
	sourceInstallationId: string | null;
	watchedSpaces: ActivitySpaceReference[];
	focus: ActivityWatchFocus | null;
}) {
	return JSON.stringify({
		ownerUserId: input.ownerUserId,
		sourceInstallationId: input.sourceInstallationId,
		watchedSpaces: input.watchedSpaces.map(canonicalSpaceReference),
		focus: input.focus
			? {
					origin: input.focus.origin,
					spaceId: input.focus.spaceId,
					sessionId: input.focus.sessionId,
					explicit: input.focus.explicit,
				}
			: null,
	});
}

export async function activityWatchDigest(value: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function upsertActivityWatchPreference(input: {
	existing: StoredActivityWatchPreference | null;
	nodeId: string;
	installationId: string;
	ownerSubject: string;
	ownerEmail: string;
	ownerUserId: string;
	preferences: ActivityWatchPreferences;
	now: string;
	expiresAt: string;
}) {
	const preferenceDigest = await activityWatchDigest(
		canonicalActivityWatchPreferences(input.preferences),
	);
	const existing = input.existing;
	const unchanged = existing?.preferenceDigest === preferenceDigest;
	return {
		nodeId: input.nodeId,
		installationId: input.installationId,
		ownerSubject: input.ownerSubject,
		ownerEmail: input.ownerEmail,
		ownerUserId: input.ownerUserId,
		preferences: input.preferences,
		preferenceDigest,
		revision: unchanged && existing ? existing.revision : (existing?.revision ?? 0) + 1,
		createdAt: existing?.createdAt ?? input.now,
		updatedAt: input.now,
		expiresAt: input.expiresAt,
	} satisfies StoredActivityWatchPreference;
}

export function isActivityWatchPreferenceExpired(
	preference: StoredActivityWatchPreference,
	nowMs = Date.now(),
) {
	const expiresAtMs = Date.parse(preference.expiresAt);
	return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

export function selectEffectiveActivityWatchPreference(
	preferences: Iterable<StoredActivityWatchPreference>,
	nowMs = Date.now(),
) {
	return (
		[...preferences]
			.filter((preference) => !isActivityWatchPreferenceExpired(preference, nowMs))
			.sort((left, right) => {
				const updatedDifference =
					Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
				if (updatedDifference !== 0) return updatedDifference;
				return right.installationId.localeCompare(left.installationId);
			})[0] ?? null
	);
}

export function activityWatchScopeFromPreference(
	preference: StoredActivityWatchPreference | null,
) {
	const watchedSpaces = preference?.preferences.watchedSpaces ?? [];
	const focus = preference?.preferences.focus ?? null;
	return { watchedSpaces, focus };
}

export async function evolveActivityWatchSnapshot(input: {
	current: StoredActivityWatchSnapshot | null;
	effective: StoredActivityWatchPreference | null;
	ownerUserId: string;
	nowMs: number;
	leaseMs?: number;
}) {
	const scope = activityWatchScopeFromPreference(input.effective);
	const digest = await activityWatchDigest(
		canonicalActivityWatchScope({
			ownerUserId: input.ownerUserId,
			sourceInstallationId: input.effective?.installationId ?? null,
			...scope,
		}),
	);
	const changed = input.current?.digest !== digest;
	const current = input.current;
	const revision = changed ? (current?.revision ?? 0) + 1 : (current?.revision ?? 1);
	const leaseMs = input.leaseMs ?? ACTIVITY_WATCH_LEASE_MS;
	const preferenceExpiryMs = input.effective
		? Date.parse(input.effective.expiresAt)
		: input.nowMs + leaseMs;
	const expiresAtMs = Number.isFinite(preferenceExpiryMs)
		? Math.max(input.nowMs, preferenceExpiryMs)
		: input.nowMs;
	const leaseExpiresAtMs = Math.min(input.nowMs + leaseMs, expiresAtMs);
	return {
		protocolVersion: RELAY_PROTOCOL_VERSION,
		type: "activity-watch.replace",
		revision,
		digest,
		ownerUserId: input.ownerUserId,
		expiresAt: new Date(expiresAtMs).toISOString(),
		leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
		...scope,
		sourceInstallationId: input.effective?.installationId ?? null,
		updatedAt: new Date(input.nowMs).toISOString(),
	} satisfies StoredActivityWatchSnapshot;
}

export function publicActivityWatchPreference(
	preference: StoredActivityWatchPreference,
) {
	return {
		installationId: preference.installationId,
		preferences: preference.preferences,
		revision: preference.revision,
		updatedAt: preference.updatedAt,
		expiresAt: preference.expiresAt,
	};
}
