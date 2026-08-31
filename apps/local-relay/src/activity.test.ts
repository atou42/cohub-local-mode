import assert from "node:assert/strict";
import test from "node:test";
import {
	ACTIVITY_PUSH_MAX_BYTES,
	activityRevocationEpochAfterRemoval,
	assertActivityPushPayloadSize,
	buildActivityPushPayload,
	composeRelayHealth,
	currentActivityRevocationEpoch,
	buildActivityStartPushPayload,
	decideActivityOutboxRetry,
	dispatchPendingActivityOutboxes,
	isActivityDeliveryRevoked,
	parseActivityTokenBody,
	nextActivityRevocationEpoch,
	publicActivityRegistration,
	selectActivityProjection,
	shouldEnqueueActivityStart,
	shouldDeleteActivityStartMarker,
	shouldAcceptLifecycleEvent,
	recoverActivitySendingLease,
	revokedActivityOutboxPatch,
	isActivityRegistrationExpired,
	upsertActivityRegistration,
	type RelayTurnLifecycleEvent,
	type StoredActivityRegistration,
} from "./activity.ts";
import type { ActivityWatchPreferences } from "./protocol.ts";

const installationId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const activityId = "669526bb-bf65-4013-a825-4f61adf199f8";
const focusSpaceId = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";
const focusSessionId = "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02";
const focusTurnId = "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01";

function lifecycle(overrides: Partial<RelayTurnLifecycleEvent> = {}): RelayTurnLifecycleEvent {
	return {
		id: crypto.randomUUID(),
		kind: "turn.lifecycle",
		nodeId: "mac-mini",
		origin: "local",
		spaceId: focusSpaceId,
		sessionId: focusSessionId,
		turnId: focusTurnId,
		status: "running",
		observedAt: "2026-08-31T10:00:00.000Z",
		spaceName: "Local Mac",
		sessionTitle: "Ship Agent Pulse",
		...overrides,
	};
}

async function registration(
	overrides: Partial<StoredActivityRegistration> = {},
): Promise<StoredActivityRegistration> {
	return upsertActivityRegistration({
		existing: null,
		id: crypto.randomUUID(),
		revocationEpoch: 0,
		kind: "activity",
		nodeId: "mac-mini",
		ownerSubject: "access-subject",
		ownerEmail: "owner@example.com",
		installationId,
		activityId,
		environment: "development",
		token: "ab".repeat(32),
		now: "2026-08-31T10:00:00.000Z",
		expiresAt: "2026-09-01T10:00:00.000Z",
		...overrides,
	});
}

function preferences(
	overrides: Partial<ActivityWatchPreferences> = {},
): ActivityWatchPreferences {
	return {
		watchedSpaces: [{ spaceId: focusSpaceId, origin: "local" }],
		focus: {
			spaceId: focusSpaceId,
			origin: "local",
			sessionId: focusSessionId,
			explicit: true,
		},
		...overrides,
	};
}

test("validates separate device and activity registration bodies", () => {
	assert.deepEqual(parseActivityTokenBody({
		token: "AB".repeat(32),
		environment: "development",
	}), {
		token: "ab".repeat(32),
		environment: "development",
	});
	assert.deepEqual(
		parseActivityTokenBody(
			{
				token: "cd".repeat(32),
				environment: "production",
			},
			"activity",
		),
		{
			token: "cd".repeat(32),
			environment: "production",
		},
	);
	assert.throws(() =>
		parseActivityTokenBody({
			token: "ab".repeat(32),
			environment: "development",
			ownerEmail: "attacker@example.com",
		}),
	);
	assert.throws(() => parseActivityTokenBody({
		token: "ab".repeat(32),
		environment: "staging",
	}));
});

test("token rotation preserves registration identity without echoing token", async () => {
	const original = await registration();
	const rotated = await upsertActivityRegistration({
		existing: original,
		id: crypto.randomUUID(),
		revocationEpoch: original.revocationEpoch,
		kind: "activity",
		nodeId: "mac-mini",
		ownerSubject: "access-subject",
		ownerEmail: "owner@example.com",
		installationId,
		activityId,
		environment: "production",
		token: "cd".repeat(32),
		now: "2026-08-31T10:01:00.000Z",
		expiresAt: "2026-09-01T10:01:00.000Z",
	});
	assert.equal(rotated.id, original.id);
	assert.equal(rotated.createdAt, original.createdAt);
	assert.notEqual(rotated.tokenFingerprint, original.tokenFingerprint);
	assert.equal(rotated.environment, "production");
	const response = publicActivityRegistration(rotated);
	assert.equal("token" in response, false);
	assert.equal("ownerSubject" in response, false);
	assert.equal("revocationEpoch" in response, false);
	assert.equal(JSON.stringify(response).includes(rotated.token), false);
});

test("registration expiry fails closed and refresh extends the trusted TTL", async () => {
	const original = await registration();
	assert.equal(
		isActivityRegistrationExpired(original, Date.parse("2026-09-01T09:59:59.999Z")),
		false,
	);
	assert.equal(
		isActivityRegistrationExpired(original, Date.parse(original.expiresAt)),
		true,
	);
	const refreshed = await upsertActivityRegistration({
		existing: original,
		id: crypto.randomUUID(),
		revocationEpoch: original.revocationEpoch,
		kind: original.kind,
		nodeId: original.nodeId,
		ownerSubject: original.ownerSubject,
		ownerEmail: original.ownerEmail,
		installationId: original.installationId,
		activityId: original.activityId,
		environment: original.environment,
		token: original.token,
		now: "2026-09-01T09:00:00.000Z",
		expiresAt: "2026-09-02T09:00:00.000Z",
	});
	assert.equal(refreshed.id, original.id);
	assert.equal(refreshed.expiresAt, "2026-09-02T09:00:00.000Z");
});

test("revocation epochs fail closed and preserve newly registered activity delivery", async () => {
	assert.equal(currentActivityRevocationEpoch(undefined), 0);
	assert.equal(nextActivityRevocationEpoch(undefined), 1);
	assert.equal(nextActivityRevocationEpoch(4), 5);
	assert.equal(
		isActivityDeliveryRevoked({
			registrationEpoch: undefined,
			outboxEpoch: 0,
			currentEpoch: 0,
		}),
		true,
	);
	assert.equal(
		isActivityDeliveryRevoked({
			registrationEpoch: 0,
			outboxEpoch: undefined,
			currentEpoch: 0,
		}),
		true,
	);
	assert.equal(
		isActivityDeliveryRevoked({
			registrationEpoch: 2,
			outboxEpoch: 2,
			currentEpoch: 3,
		}),
		true,
	);
	assert.equal(
		isActivityDeliveryRevoked({
			registrationEpoch: 3,
			outboxEpoch: 3,
			currentEpoch: 3,
		}),
		false,
	);

	const reRegistered = await upsertActivityRegistration({
		existing: await registration({ revocationEpoch: 2 }),
		id: crypto.randomUUID(),
		revocationEpoch: 3,
		kind: "activity",
		nodeId: "mac-mini",
		ownerSubject: "access-subject",
		ownerEmail: "owner@example.com",
		installationId,
		activityId,
		environment: "development",
		token: "cd".repeat(32),
		now: "2026-08-31T10:05:00.000Z",
		expiresAt: "2026-09-01T10:05:00.000Z",
	});
	assert.equal(reRegistered.revocationEpoch, 3);
});

test("activity dismissal preserves device delivery and permits a new start", () => {
	const currentEpoch = 4;
	const afterActivityDismissal = activityRevocationEpochAfterRemoval(
		"activity",
		currentEpoch,
	);
	assert.equal(afterActivityDismissal, currentEpoch);
	assert.equal(
		isActivityDeliveryRevoked({
			registrationEpoch: currentEpoch,
			outboxEpoch: currentEpoch,
			currentEpoch: afterActivityDismissal,
		}),
		false,
	);
	assert.equal(
		shouldEnqueueActivityStart({
			hasActivityRegistration: false,
			hasActiveStart: false,
			status: "running",
		}),
		true,
	);

	const afterDeviceLogout = activityRevocationEpochAfterRemoval(
		"device",
		currentEpoch,
	);
	assert.equal(afterDeviceLogout, currentEpoch + 1);
	assert.equal(
		isActivityDeliveryRevoked({
			registrationEpoch: currentEpoch,
			outboxEpoch: currentEpoch,
			currentEpoch: afterDeviceLogout,
		}),
		true,
	);
});

test("start marker deletion is scoped to the revoked activity unless device access ends", () => {
	const activityA = new Set(["activity-a"]);
	assert.equal(
		shouldDeleteActivityStartMarker({
			deviceRevoked: false,
			storedActivityId: "activity-b",
			revokedActivityIds: activityA,
		}),
		false,
	);
	assert.equal(
		shouldDeleteActivityStartMarker({
			deviceRevoked: false,
			storedActivityId: "activity-a",
			revokedActivityIds: activityA,
		}),
		true,
	);
	assert.equal(
		shouldDeleteActivityStartMarker({
			deviceRevoked: true,
			storedActivityId: "activity-b",
			revokedActivityIds: activityA,
		}),
		true,
	);
	assert.equal(
		shouldDeleteActivityStartMarker({
			deviceRevoked: false,
			storedActivityId: "activity-b",
			revokedActivityIds: new Set(["activity-a", "activity-c"]),
		}),
		false,
	);
	assert.deepEqual(
		[
			{
				deviceRevoked: false,
				storedActivityId: "activity-a",
				revokedActivityIds: new Set(["activity-a"]),
			},
			{
				deviceRevoked: false,
				storedActivityId: "activity-b",
				revokedActivityIds: new Set(["activity-a"]),
			},
			{
				deviceRevoked: true,
				storedActivityId: "activity-c",
				revokedActivityIds: new Set<string>(),
			},
		].map(shouldDeleteActivityStartMarker),
		[true, false, true],
	);
});

test("revocation cancels pending and sending outboxes and clears delivery leases", () => {
	const revokedIds = new Set(["registration-1"]);
	for (const state of ["pending", "sending"] as const) {
		assert.deepEqual(
			revokedActivityOutboxPatch(
				{ registrationId: "registration-1", state },
				revokedIds,
				"2026-08-31T10:05:00.000Z",
				"Activity registration revoked",
			),
			{
				state: "cancelled",
				updatedAt: "2026-08-31T10:05:00.000Z",
				queuedAt: null,
				sendingStartedAt: null,
				sendingLeaseExpiresAt: null,
				lastReason: "Activity registration revoked",
			},
		);
	}
	assert.equal(
		revokedActivityOutboxPatch(
			{ registrationId: "registration-1", state: "delivered" },
			revokedIds,
			"2026-08-31T10:05:00.000Z",
			"Activity registration revoked",
		),
		null,
	);
	assert.equal(
		revokedActivityOutboxPatch(
			{ registrationId: "device-registration", state: "pending" },
			revokedIds,
			"2026-08-31T10:05:00.000Z",
			"Activity registration revoked",
		),
		null,
	);
});

test("an unrelated lifecycle event cannot steal explicit focus", async () => {
	const focused = lifecycle();
	const unrelated = lifecycle({
		spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		observedAt: "2026-08-31T10:01:00.000Z",
	});
	const projection = selectActivityProjection(
		preferences(),
		[focused, unrelated],
		unrelated,
	);
	assert.equal(projection?.event.sessionId, focusSessionId);
	assert.equal(projection?.event.turnId, focusTurnId);
	assert.equal(projection?.otherActiveCount, 0);
});

test("projection excludes unwatched Spaces from selection and active counts", async () => {
	const watched = lifecycle();
	const unwatched = lifecycle({
		spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		observedAt: "2026-08-31T10:01:00.000Z",
	});
	const preferenceValue = preferences({
		focus: {
			spaceId: focusSpaceId,
			origin: "local",
			sessionId: null,
			explicit: false,
		},
	});
	const projection = selectActivityProjection(
		preferenceValue,
		[watched, unwatched],
		unwatched,
	);
	assert.equal(projection?.event.turnId, watched.turnId);
	assert.equal(projection?.otherActiveCount, 0);
});

test("explicit session focus matches both its Space and Session", async () => {
	const focused = lifecycle();
	const sameSessionInAnotherSpace = lifecycle({
		spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		observedAt: "2026-08-31T10:01:00.000Z",
	});
	const preferenceValue = preferences({
		watchedSpaces: [
			{ spaceId: focusSpaceId, origin: "local" },
			{
				spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				origin: "local",
			},
		],
	});
	const projection = selectActivityProjection(
		preferenceValue,
		[focused, sameSessionInAnotherSpace],
		sameSessionInAnotherSpace,
	);
	assert.equal(projection?.event.spaceId, focusSpaceId);
	assert.equal(projection?.event.turnId, focusTurnId);
});

test("projection keeps local and cloud Spaces with the same UUID isolated", () => {
	const local = lifecycle();
	const cloud = lifecycle({
		origin: "cloud",
		turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		observedAt: "2026-08-31T10:01:00.000Z",
	});
	const projection = selectActivityProjection(
		preferences(),
		[local, cloud],
		cloud,
	);
	assert.equal(projection?.event.origin, "local");
	assert.equal(projection?.event.turnId, local.turnId);
	assert.equal(projection?.otherActiveCount, 0);
});

test("non-explicit focus follows the newest active session", async () => {
	const first = lifecycle();
	const newest = lifecycle({
		sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		observedAt: "2026-08-31T10:02:00.000Z",
	});
	const preferenceValue = preferences({
		focus: {
			spaceId: focusSpaceId,
			origin: "local",
			sessionId: null,
			explicit: false,
		},
	});
	assert.equal(
		selectActivityProjection(preferenceValue, [first, newest], newest)?.event.turnId,
		newest.turnId,
	);
});

test("builds bounded update and start payloads with monotonic revision fields", () => {
	const event = lifecycle();
	const update = buildActivityPushPayload(event, 7, 120, 2);
	assert.equal(update.aps["content-state"].revision, 7);
	assert.equal(update.aps.event, "update");
	assert.equal(
		update.aps.timestamp,
		Math.floor(Date.parse(event.observedAt) / 1_000),
	);
	assert.equal(update.aps["content-state"].otherActiveCount, 2);
	assert.equal(update.aps["content-state"].origin, "local");
	assert.equal(update.aps["content-state"].spaceName, "Local Mac");
	assert.equal(update.aps["content-state"].sessionTitle, "Ship Agent Pulse");
	assert.equal(update.aps["content-state"].generatedAt, event.observedAt);
	assert.equal(update.aps["content-state"].staleAt, "2026-08-31T10:02:00.000Z");
	assert.ok(assertActivityPushPayloadSize(update) <= ACTIVITY_PUSH_MAX_BYTES);
	const start = buildActivityStartPushPayload({
		event,
		revision: 1,
		staleSeconds: 120,
		otherActiveCount: 0,
		attributesType: "CohubAgentPulseAttributes",
		installationId,
		activityId,
	});
	assert.equal(start.aps.event, "start");
	assert.equal(start.aps["attributes-type"], "CohubAgentPulseAttributes");
	assert.deepEqual(start.aps.attributes, { installationId, activityId });
});

test("payloads over 4KB fail as an explicit deployment error", () => {
	assert.throws(
		() => assertActivityPushPayloadSize({ payload: "x".repeat(ACTIVITY_PUSH_MAX_BYTES) }),
		(error: unknown) =>
			Boolean(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "activity_payload_deployment_failure",
			),
	);
});

test("missing real names makes lifecycle projection explicitly undeliverable", () => {
	assert.throws(
		() => buildActivityPushPayload(
			lifecycle({ spaceName: null, sessionTitle: null }),
			1,
			120,
		),
		(error: unknown) =>
			error instanceof Error && error.message.includes("requires real Space and Session names"),
	);
});

test("retry policy honors Retry-After, backs off, and stops at bounded attempts or age", () => {
	const nowMs = Date.parse("2026-08-31T10:00:00.000Z");
	assert.deepEqual(
		decideActivityOutboxRetry({
			attempts: 2,
			createdAtMs: nowMs - 1_000,
			nowMs,
			retryAfterMs: 30_000,
		}),
		{
			action: "retry",
			nextAttemptAt: "2026-08-31T10:00:30.000Z",
		},
	);
	assert.equal(
		decideActivityOutboxRetry({
			attempts: 8,
			createdAtMs: nowMs - 1_000,
			nowMs,
			retryAfterMs: null,
		}).action,
		"dead_letter",
	);
	assert.equal(
		decideActivityOutboxRetry({
			attempts: 1,
			createdAtMs: nowMs - 24 * 60 * 60 * 1_000,
			nowMs,
			retryAfterMs: null,
		}).action,
		"dead_letter",
	);
});

test("lifecycle projection accepts a same-time terminal transition without allowing regression", () => {
	const current = lifecycle({ observedAt: "2026-08-31T10:00:00.000Z" });
	assert.equal(
		shouldAcceptLifecycleEvent(
			current,
			lifecycle({ observedAt: "2026-08-31T09:59:59.999Z", status: "queued" }),
		),
		false,
	);
	assert.equal(
		shouldAcceptLifecycleEvent(
			current,
			lifecycle({ observedAt: current.observedAt, status: "completed" }),
		),
		true,
	);
	assert.equal(
		shouldAcceptLifecycleEvent(
			lifecycle({ observedAt: current.observedAt, status: "completed" }),
			current,
		),
		false,
	);
	assert.equal(
		shouldAcceptLifecycleEvent(
			lifecycle({ observedAt: current.observedAt, status: "failed" }),
			lifecycle({ observedAt: current.observedAt, status: "completed" }),
		),
		false,
	);
	assert.equal(
		shouldAcceptLifecycleEvent(
			lifecycle({ observedAt: current.observedAt, status: "queued" }),
			lifecycle({ observedAt: current.observedAt, status: "running" }),
		),
		true,
	);
	assert.equal(
		shouldAcceptLifecycleEvent(
			lifecycle({ observedAt: current.observedAt, status: "running" }),
			lifecycle({ observedAt: current.observedAt, status: "abort_requested" }),
		),
		true,
	);
	assert.equal(
		shouldAcceptLifecycleEvent(
			current,
			lifecycle({ observedAt: "2026-08-31T10:00:00.001Z", status: "completed" }),
		),
		true,
	);
});

test("same-time terminal state wins deterministically during projection", async () => {
	const running = lifecycle();
	const completed = lifecycle({ status: "completed" });
	const projection = selectActivityProjection(
		preferences(),
		[completed, running],
		running,
	);
	assert.equal(projection?.event.status, "completed");
});

test("unknown push-to-start delivery is not replayed while updates recover", () => {
	assert.equal(recoverActivitySendingLease("start"), "dead_letter");
	assert.equal(recoverActivitySendingLease("update"), "retry");
	assert.equal(recoverActivitySendingLease("end"), "retry");
});

test("activity push failure does not mark core Relay health unavailable", () => {
	assert.deepEqual(
		composeRelayHealth(2, {
			status: "error",
			code: "apns_configuration_error",
		}),
		{
			status: "ready",
			protocolVersion: 2,
			activityPush: {
				status: "error",
				code: "apns_configuration_error",
			},
		},
	);
});

test("terminal lifecycle ends the activity with final content and a short dismissal", () => {
	const event = lifecycle({ status: "failed" });
	const payload = buildActivityPushPayload(event, 8, 180, 1);
	assert.equal(payload.aps.event, "end");
	if (payload.aps.event !== "end") throw new Error("expected terminal APNs payload");
	assert.equal(payload.aps["content-state"].status, "failed");
	assert.equal(payload.aps["content-state"].revision, 8);
	assert.equal(payload.aps["content-state"].otherActiveCount, 1);
	assert.equal(payload.aps["stale-date"] - payload.aps.timestamp, 180);
	assert.equal(payload.aps["dismissal-date"] - payload.aps.timestamp, 120);
});

test("deduplicates push-to-start while an installation already has a global activity", () => {
	assert.equal(
		shouldEnqueueActivityStart({
			hasActivityRegistration: false,
			hasActiveStart: false,
			status: "running",
		}),
		true,
	);
	assert.equal(
		shouldEnqueueActivityStart({
			hasActivityRegistration: false,
			hasActiveStart: true,
			status: "running",
		}),
		false,
	);
	assert.equal(
		shouldEnqueueActivityStart({
			hasActivityRegistration: true,
			hasActiveStart: false,
			status: "running",
		}),
		false,
	);
	assert.equal(
		shouldEnqueueActivityStart({
			hasActivityRegistration: false,
			hasActiveStart: false,
			status: "completed",
		}),
		false,
	);
});

test("queue failure leaves pending outbox eligible for duplicate-event redrive", async () => {
	const outbox = { id: "outbox-1", eventId: "event-1", state: "pending" };
	let attempts = 0;
	const failed = await dispatchPendingActivityOutboxes(
		[outbox],
		"event-1",
		async () => {
			attempts += 1;
			throw new Error("queue unavailable");
		},
	);
	assert.equal(failed.length, 1);
	assert.equal(outbox.state, "pending");
	assert.equal(attempts, 1);
	assert.equal(
		(
			await dispatchPendingActivityOutboxes([outbox], "event-1", async () => {
				attempts += 1;
			})
		).length,
		0,
	);
	assert.equal(attempts, 2);
});
