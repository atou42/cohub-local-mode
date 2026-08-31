import {
	RelayProtocolError,
	type ActivitySpaceOrigin,
	type ActivityWatchPreferences,
} from "./protocol.ts";

export const ACTIVITY_PUSH_MAX_BYTES = 4_096;
export const ACTIVITY_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){32,256}$/i;
export const ACTIVITY_OUTBOX_MAX_ATTEMPTS = 8;
export const ACTIVITY_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const ACTIVITY_OUTBOX_SENDING_LEASE_MS = 2 * 60 * 1_000;
export const ACTIVITY_LIFECYCLE_TERMINAL_TTL_MS = 8 * 24 * 60 * 60 * 1_000;

export const TURN_LIFECYCLE_STATUSES = [
	"queued",
	"running",
	"abort_requested",
	"completed",
	"failed",
	"interrupted",
	"merged",
	"cancelled",
] as const;

export type TurnLifecycleStatus = (typeof TURN_LIFECYCLE_STATUSES)[number];
export type ActivityRegistrationKind = "device" | "activity";
export type ApnsEnvironment = "development" | "production";

export type RelayTurnLifecycleEvent = {
	id: string;
	kind: "turn.lifecycle";
	nodeId: string;
	origin: ActivitySpaceOrigin;
	spaceId: string;
	sessionId: string;
	turnId: string;
	status: TurnLifecycleStatus;
	observedAt: string;
	spaceName: string | null;
	sessionTitle: string | null;
};

export type StoredActivityRegistration = {
	id: string;
	revocationEpoch: number;
	kind: ActivityRegistrationKind;
	nodeId: string;
	ownerSubject: string;
	ownerEmail: string;
	installationId: string;
	activityId: string | null;
	environment: ApnsEnvironment;
	token: string;
	tokenFingerprint: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
};

export type ParsedActivityRegistration = {
	token: string;
	environment: ApnsEnvironment;
};

export type PublicActivityRegistration = Omit<
	StoredActivityRegistration,
	"ownerSubject" | "ownerEmail" | "token" | "revocationEpoch"
>;

export type ActivityContentState = {
	schemaVersion: 1;
	// Revision deduplicates one delivery source. Cross-source ordering uses
	// generatedAt together with the matching top-level APNs timestamp.
	revision: number;
	generatedAt: string;
	staleAt: string;
	nodeId: string;
	origin: ActivitySpaceOrigin;
	spaceId: string;
	sessionId: string;
	turnId: string;
	status: TurnLifecycleStatus;
	otherActiveCount: number;
	spaceName: string;
	sessionTitle: string;
};

export type ActivityUpdatePushPayload = {
	aps: {
		timestamp: number;
		event: "update";
		"stale-date": number;
		"content-state": ActivityContentState;
	};
};

export type ActivityEndPushPayload = {
	aps: {
		timestamp: number;
		event: "end";
		"stale-date": number;
		"dismissal-date": number;
		"content-state": ActivityContentState;
	};
};

export type ActivityStartPushPayload = {
	aps: {
		timestamp: number;
		event: "start";
		"stale-date": number;
		"attributes-type": string;
		attributes: {
			installationId: string;
			activityId: string;
		};
		"content-state": ActivityContentState;
	};
};

export type ActivityPushPayload =
	| ActivityUpdatePushPayload
	| ActivityEndPushPayload
	| ActivityStartPushPayload;

export type ApnsDisposition =
	| "delivered"
	| "invalidate_registration"
	| "deployment_failure"
	| "retry"
	| "permanent_failure";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_OR_TOPIC_REASONS = new Set([
	"BadDeviceToken",
	"DeviceTokenNotForTopic",
	"MissingDeviceToken",
	"BadTopic",
	"MissingTopic",
	"TopicDisallowed",
]);

export function validateActivityIdentifier(value: string, label: string) {
	if (!UUID_PATTERN.test(value)) {
		throw new RelayProtocolError(
			"invalid_activity_identifier",
			`${label} must be a UUID`,
		);
	}
	return value.toLowerCase();
}

export function parseActivityTokenBody(
	value: unknown,
	_kind: ActivityRegistrationKind = "device",
): ParsedActivityRegistration {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RelayProtocolError(
			"invalid_activity_registration",
			"registration body must be an object",
		);
	}
	const keys = Object.keys(value).sort();
	const expectedKeys = ["environment", "token"];
	if (
		keys.length !== expectedKeys.length ||
		keys.some((key, index) => key !== expectedKeys[index])
	) {
		throw new RelayProtocolError(
			"invalid_activity_registration",
			"activity token registration body requires only token and environment",
		);
	}
	const token = (value as { token?: unknown }).token;
	const environment = (value as { environment?: unknown }).environment;
	if (typeof token !== "string" || !ACTIVITY_TOKEN_PATTERN.test(token)) {
		throw new RelayProtocolError(
			"invalid_activity_token",
			"ActivityKit token must be an even-length hexadecimal value between 64 and 512 characters",
		);
	}
	if (environment !== "development" && environment !== "production") {
		throw new RelayProtocolError(
			"invalid_apns_environment",
			"APNs token environment must be development or production",
		);
	}
	return {
		token: token.toLowerCase(),
		environment,
	};
}

export async function activityTokenFingerprint(token: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

export async function upsertActivityRegistration(input: {
	existing: StoredActivityRegistration | null;
	id: string;
	revocationEpoch: number;
	kind: ActivityRegistrationKind;
	nodeId: string;
	ownerSubject: string;
	ownerEmail: string;
	installationId: string;
	activityId: string | null;
	environment: ApnsEnvironment;
	token: string;
	now: string;
	expiresAt: string;
}) {
	assertActivityRevocationEpoch(input.revocationEpoch);
	return {
		id: input.existing?.id ?? input.id,
		revocationEpoch: input.revocationEpoch,
		kind: input.kind,
		nodeId: input.nodeId,
		ownerSubject: input.ownerSubject,
		ownerEmail: input.ownerEmail,
		installationId: input.installationId,
		activityId: input.activityId,
		environment: input.environment,
		token: input.token,
		tokenFingerprint: await activityTokenFingerprint(input.token),
		createdAt: input.existing?.createdAt ?? input.now,
		updatedAt: input.now,
		expiresAt: input.expiresAt,
	} satisfies StoredActivityRegistration;
}

function isActivityRevocationEpoch(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertActivityRevocationEpoch(value: unknown): asserts value is number {
	if (!isActivityRevocationEpoch(value)) {
		throw new Error("activity revocation epoch must be a nonnegative safe integer");
	}
}

export function currentActivityRevocationEpoch(stored: unknown) {
	if (stored === undefined) return 0;
	assertActivityRevocationEpoch(stored);
	return stored;
}

export function nextActivityRevocationEpoch(stored: unknown) {
	const current = currentActivityRevocationEpoch(stored);
	if (current === Number.MAX_SAFE_INTEGER) {
		throw new Error("activity revocation epoch is exhausted");
	}
	return current + 1;
}

export function activityRevocationEpochAfterRemoval(
	kind: ActivityRegistrationKind,
	stored: unknown,
) {
	return kind === "device"
		? nextActivityRevocationEpoch(stored)
		: currentActivityRevocationEpoch(stored);
}

export function shouldDeleteActivityStartMarker(input: {
	deviceRevoked: boolean;
	storedActivityId: unknown;
	revokedActivityIds: ReadonlySet<string>;
}) {
	if (input.deviceRevoked) return true;
	return (
		typeof input.storedActivityId === "string" &&
		input.revokedActivityIds.has(input.storedActivityId)
	);
}

export function isActivityDeliveryRevoked(input: {
	registrationEpoch: unknown;
	outboxEpoch: unknown;
	currentEpoch: unknown;
}) {
	if (
		!isActivityRevocationEpoch(input.registrationEpoch) ||
		!isActivityRevocationEpoch(input.outboxEpoch) ||
		!isActivityRevocationEpoch(input.currentEpoch)
	) {
		return true;
	}
	return (
		input.registrationEpoch !== input.currentEpoch ||
		input.outboxEpoch !== input.currentEpoch
	);
}

export function revokedActivityOutboxPatch(
	outbox: {
		registrationId: string;
		state: string;
	},
	revokedRegistrationIds: ReadonlySet<string>,
	now: string,
	reason: string,
) {
	if (
		!revokedRegistrationIds.has(outbox.registrationId) ||
		(outbox.state !== "pending" && outbox.state !== "sending")
	) {
		return null;
	}
	return {
		state: "cancelled" as const,
		updatedAt: now,
		queuedAt: null,
		sendingStartedAt: null,
		sendingLeaseExpiresAt: null,
		lastReason: reason,
	};
}

export function isActivityRegistrationExpired(
	registration: Pick<StoredActivityRegistration, "expiresAt">,
	nowMs = Date.now(),
) {
	const expiresAtMs = Date.parse(registration.expiresAt);
	return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

export async function dispatchPendingActivityOutboxes<T extends {
	id: string;
	eventId: string;
	state: string;
}>(
	outboxes: Iterable<T>,
	eventId: string | undefined,
	send: (outbox: T) => Promise<void>,
) {
	const failures: Array<{ outbox: T; error: unknown }> = [];
	for (const outbox of outboxes) {
		if (
			outbox.state !== "pending" ||
			(eventId !== undefined && outbox.eventId !== eventId)
		) {
			continue;
		}
		try {
			await send(outbox);
		} catch (error) {
			failures.push({ outbox, error });
		}
	}
	return failures;
}

export function publicActivityRegistration(
	registration: StoredActivityRegistration,
): PublicActivityRegistration {
	const {
		ownerSubject: _ownerSubject,
		ownerEmail: _ownerEmail,
		token: _token,
		revocationEpoch: _revocationEpoch,
		...publicValue
	} = registration;
	return publicValue;
}

export function buildActivityPushPayload(
	event: RelayTurnLifecycleEvent,
	revision: number,
	staleSeconds: number,
	otherActiveCount = 0,
): ActivityPushPayload {
	if (!isDeliverableLifecycleProjection(event)) {
		throw new RelayProtocolError(
			"activity_projection_incomplete",
			"APNs activity projection requires real Space and Session names",
			503,
		);
	}
	if (!Number.isSafeInteger(revision) || revision < 1) {
		throw new Error("activity revision must be a positive integer");
	}
	if (!Number.isSafeInteger(staleSeconds) || staleSeconds < 1) {
		throw new Error("activity stale seconds must be a positive integer");
	}
	if (!Number.isSafeInteger(otherActiveCount) || otherActiveCount < 0) {
		throw new Error("other active count must be a nonnegative integer");
	}
	const generatedAtMs = Date.parse(event.observedAt);
	if (!Number.isFinite(generatedAtMs)) {
		throw new Error("turn lifecycle observedAt is invalid");
	}
	const staleAtMs = generatedAtMs + staleSeconds * 1_000;
	const terminal = TERMINAL_TURN_STATUSES.has(event.status);
	const contentState: ActivityContentState = {
		schemaVersion: 1,
		revision,
		generatedAt: new Date(generatedAtMs).toISOString(),
		staleAt: new Date(staleAtMs).toISOString(),
		nodeId: event.nodeId,
		origin: event.origin,
		spaceId: event.spaceId,
		sessionId: event.sessionId,
		turnId: event.turnId,
		status: event.status,
		otherActiveCount,
		spaceName: event.spaceName,
		sessionTitle: event.sessionTitle,
	};
	const payload: ActivityUpdatePushPayload | ActivityEndPushPayload = terminal
		? {
				aps: {
					timestamp: Math.floor(generatedAtMs / 1_000),
					event: "end",
					"stale-date": Math.floor(staleAtMs / 1_000),
					"dismissal-date": Math.floor((generatedAtMs + 120_000) / 1_000),
					"content-state": contentState,
				},
			}
		: {
				aps: {
					timestamp: Math.floor(generatedAtMs / 1_000),
					event: "update",
					"stale-date": Math.floor(staleAtMs / 1_000),
					"content-state": contentState,
				},
			};
	assertActivityPushPayloadSize(payload);
	return payload;
}

export function isDeliverableLifecycleProjection(
	event: RelayTurnLifecycleEvent,
): event is RelayTurnLifecycleEvent & { spaceName: string; sessionTitle: string } {
	return Boolean(event.spaceName && event.sessionTitle);
}

export function buildActivityStartPushPayload(input: {
	event: RelayTurnLifecycleEvent;
	revision: number;
	staleSeconds: number;
	otherActiveCount: number;
	attributesType: string;
	installationId: string;
	activityId: string;
}): ActivityStartPushPayload {
	if (!input.attributesType.trim()) {
		throw new Error("live activity attributes type is required");
	}
	const update = buildActivityPushPayload(
		input.event,
		input.revision,
		input.staleSeconds,
		input.otherActiveCount,
	);
	const payload: ActivityStartPushPayload = {
		aps: {
			...update.aps,
			event: "start",
			"attributes-type": input.attributesType,
			attributes: {
				installationId: input.installationId,
				activityId: input.activityId,
			},
		},
	};
	assertActivityPushPayloadSize(payload);
	return payload;
}

export function shouldEnqueueActivityStart(input: {
	hasActivityRegistration: boolean;
	hasActiveStart: boolean;
	status: TurnLifecycleStatus;
}) {
	return (
		!input.hasActivityRegistration &&
		!input.hasActiveStart &&
		ACTIVE_TURN_STATUSES.has(input.status)
	);
}

export function shouldAcceptLifecycleEvent(
	current: RelayTurnLifecycleEvent | null,
	next: RelayTurnLifecycleEvent,
) {
	if (!current) return true;
	const currentObservedAt = Date.parse(current.observedAt);
	const nextObservedAt = Date.parse(next.observedAt);
	if (nextObservedAt !== currentObservedAt) {
		return nextObservedAt > currentObservedAt;
	}
	return lifecycleStatusRank(next.status) > lifecycleStatusRank(current.status);
}

export function recoverActivitySendingLease(event: ActivityPushPayload["aps"]["event"]) {
	return event === "start" ? "dead_letter" as const : "retry" as const;
}

export function composeRelayHealth(
	protocolVersion: number,
	activityPush: Record<string, unknown>,
) {
	return {
		status: "ready" as const,
		protocolVersion,
		activityPush,
	};
}

const ACTIVE_TURN_STATUSES = new Set<TurnLifecycleStatus>([
	"queued",
	"running",
	"abort_requested",
]);
const TERMINAL_TURN_STATUSES = new Set<TurnLifecycleStatus>([
	"completed",
	"failed",
	"interrupted",
	"merged",
	"cancelled",
]);

function lifecycleStatusRank(status: TurnLifecycleStatus) {
	if (TERMINAL_TURN_STATUSES.has(status)) return 3;
	if (status === "abort_requested") return 2;
	if (status === "running") return 1;
	return 0;
}

function activitySpaceKey(origin: ActivitySpaceOrigin, spaceId: string) {
	return `${origin}\0${spaceId}`;
}

function activitySessionKey(event: RelayTurnLifecycleEvent) {
	return `${event.origin}\0${event.spaceId}\0${event.sessionId}`;
}

function activityTurnKey(event: RelayTurnLifecycleEvent) {
	return `${event.origin}\0${event.turnId}`;
}

export function selectActivityProjection(
	preferences: ActivityWatchPreferences,
	events: RelayTurnLifecycleEvent[],
	triggeringEvent: RelayTurnLifecycleEvent,
) {
	const watchedSpaces = new Set(
		preferences.watchedSpaces.map((space) =>
			activitySpaceKey(space.origin, space.spaceId),
		),
	);
	if (preferences.focus) {
		watchedSpaces.add(
			activitySpaceKey(preferences.focus.origin, preferences.focus.spaceId),
		);
	}
	const isInWatchedScope = (event: RelayTurnLifecycleEvent) =>
		watchedSpaces.has(activitySpaceKey(event.origin, event.spaceId));
	const scopedEvents = events.filter(isInWatchedScope);
	const scopedTriggeringEvent = isInWatchedScope(triggeringEvent)
		? triggeringEvent
		: undefined;
	const newestByTurn = new Map<string, RelayTurnLifecycleEvent>();
	for (const event of scopedEvents) {
		const key = activityTurnKey(event);
		const current = newestByTurn.get(key);
		if (shouldAcceptLifecycleEvent(current ?? null, event)) {
			newestByTurn.set(key, event);
		}
	}
	const latest = [...newestByTurn.values()].sort(
		(left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt),
	);
	const active = latest.filter((event) => ACTIVE_TURN_STATUSES.has(event.status));
	let primary: RelayTurnLifecycleEvent | undefined;
	if (preferences.focus?.sessionId) {
		primary = latest.find(
			(event) =>
				event.origin === preferences.focus?.origin &&
				event.spaceId === preferences.focus.spaceId &&
				event.sessionId === preferences.focus.sessionId,
		);
	} else if (preferences.focus) {
		primary = active.find(
			(event) =>
				event.origin === preferences.focus?.origin &&
				event.spaceId === preferences.focus.spaceId,
		);
		if (
			!primary &&
			scopedTriggeringEvent?.origin === preferences.focus.origin &&
			scopedTriggeringEvent.spaceId === preferences.focus.spaceId
		) {
			primary = scopedTriggeringEvent;
		}
	} else {
		primary = active[0] ?? scopedTriggeringEvent;
	}
	if (!primary) return null;
	const otherActiveSessions = new Set(
		active
			.filter((event) => activitySessionKey(event) !== activitySessionKey(primary))
			.map(activitySessionKey),
	);
	return { event: primary, otherActiveCount: otherActiveSessions.size };
}

export function assertActivityPushPayloadSize(payload: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
	if (bytes > ACTIVITY_PUSH_MAX_BYTES) {
		throw new RelayProtocolError(
			"activity_payload_deployment_failure",
			`APNs live activity payload deployment failed because it exceeds ${ACTIVITY_PUSH_MAX_BYTES} bytes`,
			413,
		);
	}
	return bytes;
}

export function classifyApnsResponse(status: number, reason: string | null) {
	if (status === 200) return "delivered" satisfies ApnsDisposition;
	if (status === 410 || (status === 400 && reason && TOKEN_OR_TOPIC_REASONS.has(reason))) {
		return "invalidate_registration" satisfies ApnsDisposition;
	}
	if (status === 403) return "deployment_failure" satisfies ApnsDisposition;
	if (status === 429 || status >= 500) return "retry" satisfies ApnsDisposition;
	return "permanent_failure" satisfies ApnsDisposition;
}

export function decideActivityOutboxRetry(input: {
	attempts: number;
	createdAtMs: number;
	nowMs: number;
	retryAfterMs: number | null;
	maxAttempts?: number;
	maxAgeMs?: number;
}) {
	const maxAttempts = input.maxAttempts ?? ACTIVITY_OUTBOX_MAX_ATTEMPTS;
	const maxAgeMs = input.maxAgeMs ?? ACTIVITY_OUTBOX_MAX_AGE_MS;
	if (input.attempts >= maxAttempts || input.nowMs - input.createdAtMs >= maxAgeMs) {
		return { action: "dead_letter" as const };
	}
	const exponentialMs = Math.min(15 * 60 * 1_000, 1_000 * 2 ** Math.max(0, input.attempts - 1));
	const delayMs = Math.max(exponentialMs, input.retryAfterMs ?? 0);
	return {
		action: "retry" as const,
		nextAttemptAt: new Date(input.nowMs + delayMs).toISOString(),
	};
}
