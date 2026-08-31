import assert from "node:assert/strict";
import test from "node:test";
import {
	activityWatchScopeFromPreference,
	evolveActivityWatchSnapshot,
	isActivityWatchPreferenceExpired,
	publicActivityWatchPreference,
	selectEffectiveActivityWatchPreference,
	upsertActivityWatchPreference,
	type StoredActivityWatchPreference,
} from "./activity-preferences.ts";

const installationA = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const installationB = "669526bb-bf65-4013-a825-4f61adf199f8";
const localSpaceId = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";
const localSessionId = "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02";
const cloudSpaceId = "d2e2ad0e-3d2b-443f-a583-2756604a08bb";
const cloudSessionId = "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01";
const ownerUserId = "6042060d-5fbd-4a9e-94f0-80d321eda261";

async function preference(
	overrides: Partial<StoredActivityWatchPreference> = {},
) {
	return upsertActivityWatchPreference({
		existing: null,
		nodeId: "mac-mini",
		installationId: installationA,
		ownerSubject: "access-owner",
		ownerEmail: "owner@example.com",
		ownerUserId,
		preferences: {
			watchedSpaces: [{ spaceId: localSpaceId, origin: "local" }],
			focus: {
				spaceId: localSpaceId,
				origin: "local",
				sessionId: localSessionId,
				explicit: true,
			},
		},
		now: "2026-08-31T10:00:00.000Z",
		expiresAt: "2026-09-01T10:00:00.000Z",
		...overrides,
	});
}

test("an identical preference refresh extends expiry without revision churn", async () => {
	const original = await preference();
	const refreshed = await upsertActivityWatchPreference({
		existing: original,
		nodeId: original.nodeId,
		installationId: original.installationId,
		ownerSubject: original.ownerSubject,
		ownerEmail: original.ownerEmail,
		ownerUserId: original.ownerUserId,
		preferences: original.preferences,
		now: "2026-08-31T11:00:00.000Z",
		expiresAt: "2026-09-01T11:00:00.000Z",
	});
	assert.equal(refreshed.revision, original.revision);
	assert.equal(refreshed.preferenceDigest, original.preferenceDigest);
	assert.equal(refreshed.createdAt, original.createdAt);
	assert.equal(refreshed.updatedAt, "2026-08-31T11:00:00.000Z");
	assert.equal(refreshed.expiresAt, "2026-09-01T11:00:00.000Z");
	const publicPreference = publicActivityWatchPreference(refreshed);
	assert.equal("ownerSubject" in publicPreference, false);
	assert.equal("ownerEmail" in publicPreference, false);
	assert.equal("ownerUserId" in publicPreference, false);
	assert.equal("preferenceDigest" in publicPreference, false);

	const changed = await upsertActivityWatchPreference({
		existing: refreshed,
		nodeId: refreshed.nodeId,
		installationId: refreshed.installationId,
		ownerSubject: refreshed.ownerSubject,
		ownerEmail: refreshed.ownerEmail,
		ownerUserId: refreshed.ownerUserId,
		preferences: {
			watchedSpaces: [{ spaceId: cloudSpaceId, origin: "cloud" }],
			focus: null,
		},
		now: "2026-08-31T12:00:00.000Z",
		expiresAt: "2026-09-01T12:00:00.000Z",
	});
	assert.equal(changed.revision, original.revision + 1);
	assert.notEqual(changed.preferenceDigest, original.preferenceDigest);
});

test("the newest owner preference is authoritative and older installs cannot widen focus", async () => {
	const older = await preference({
		installationId: installationA,
		preferences: {
			watchedSpaces: [
				{ spaceId: localSpaceId, origin: "local" },
				{ spaceId: cloudSpaceId, origin: "cloud" },
			],
			focus: {
				spaceId: localSpaceId,
				origin: "local",
				sessionId: localSessionId,
				explicit: true,
			},
		},
		updatedAt: "2026-08-31T10:00:00.000Z",
	});
	const newer = await preference({
		installationId: installationB,
		preferences: {
			watchedSpaces: [{ spaceId: cloudSpaceId, origin: "cloud" }],
			focus: {
				spaceId: cloudSpaceId,
				origin: "cloud",
				sessionId: cloudSessionId,
				explicit: true,
			},
		},
		updatedAt: "2026-08-31T10:01:00.000Z",
	});
	const selected = selectEffectiveActivityWatchPreference(
		[older, newer],
		Date.parse("2026-08-31T10:02:00.000Z"),
	);
	assert.equal(selected?.installationId, installationB);
	assert.deepEqual(activityWatchScopeFromPreference(selected), {
		watchedSpaces: [{ spaceId: cloudSpaceId, origin: "cloud" }],
		focus: {
			spaceId: cloudSpaceId,
			origin: "cloud",
			sessionId: cloudSessionId,
			explicit: true,
		},
	});
});

test("selection is deterministic for equal timestamps and fails closed on expiry", async () => {
	const first = await preference({ installationId: installationA });
	const second = await preference({ installationId: installationB });
	assert.equal(
		selectEffectiveActivityWatchPreference(
			[first, second],
			Date.parse("2026-08-31T10:01:00.000Z"),
		)?.installationId,
		installationB,
	);
	assert.equal(
		isActivityWatchPreferenceExpired(
			first,
			Date.parse("2026-09-01T09:59:59.999Z"),
		),
		false,
	);
	assert.equal(
		isActivityWatchPreferenceExpired(first, Date.parse(first.expiresAt)),
		true,
	);
	assert.equal(
		selectEffectiveActivityWatchPreference(
			[first, second],
			Date.parse(first.expiresAt),
		),
		null,
	);
});

test("global watch revision changes only when the effective scope digest changes", async () => {
	const effective = await preference();
	const initial = await evolveActivityWatchSnapshot({
		current: null,
		effective,
		ownerUserId,
		nowMs: Date.parse("2026-08-31T10:00:00.000Z"),
		leaseMs: 60_000,
	});
	assert.equal(initial.revision, 1);
	assert.match(initial.digest, /^[0-9a-f]{64}$/);
	assert.equal(initial.leaseExpiresAt, "2026-08-31T10:01:00.000Z");

	const refreshed = await evolveActivityWatchSnapshot({
		current: initial,
		effective: {
			...effective,
			updatedAt: "2026-08-31T11:00:00.000Z",
			expiresAt: "2026-09-01T11:00:00.000Z",
		},
		ownerUserId,
		nowMs: Date.parse("2026-08-31T11:00:00.000Z"),
		leaseMs: 60_000,
	});
	assert.equal(refreshed.revision, initial.revision);
	assert.equal(refreshed.digest, initial.digest);
	assert.equal(refreshed.leaseExpiresAt, "2026-08-31T11:01:00.000Z");

	const sameScopeFromAnotherInstallation = await evolveActivityWatchSnapshot({
		current: refreshed,
		effective: {
			...effective,
			installationId: installationB,
			updatedAt: "2026-08-31T11:00:30.000Z",
		},
		ownerUserId,
		nowMs: Date.parse("2026-08-31T11:00:30.000Z"),
		leaseMs: 60_000,
	});
	assert.equal(sameScopeFromAnotherInstallation.revision, initial.revision + 1);
	assert.notEqual(sameScopeFromAnotherInstallation.digest, initial.digest);

	const replacement = await preference({
		preferences: {
			watchedSpaces: [{ spaceId: cloudSpaceId, origin: "cloud" }],
			focus: null,
		},
	});
	const changed = await evolveActivityWatchSnapshot({
		current: sameScopeFromAnotherInstallation,
		effective: replacement,
		ownerUserId,
		nowMs: Date.parse("2026-08-31T11:01:00.000Z"),
		leaseMs: 60_000,
	});
	assert.equal(changed.revision, initial.revision + 2);
	assert.notEqual(changed.digest, initial.digest);

	const revoked = await evolveActivityWatchSnapshot({
		current: changed,
		effective: null,
		ownerUserId,
		nowMs: Date.parse("2026-08-31T11:02:00.000Z"),
		leaseMs: 60_000,
	});
	assert.equal(revoked.revision, changed.revision + 1);
	assert.deepEqual(revoked.watchedSpaces, []);
	assert.equal(revoked.focus, null);
});
