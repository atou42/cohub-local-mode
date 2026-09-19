import { parseNativeDisplayName } from "./display-name";
import {
	type ExplicitNativeFocus,
	NATIVE_ACTIVITY_SCHEMA_VERSION,
	type NativeActivityFreshness,
	type NativeActivityPhase,
	type NativeActivitySnapshot,
	type NativeActivitySpaceSource,
	type NativeActivityTurn,
	type NativePulseFocus,
	type NativeTurnStatus,
	TURN_STATUSES,
} from "./types";

const ACTIVE_STATUSES = new Set<NativeTurnStatus>([
	"queued",
	"running",
	"abort_requested",
]);
const TERMINAL_STATUSES = new Set<NativeTurnStatus>([
	"completed",
	"failed",
	"interrupted",
	"merged",
	"cancelled",
]);

type UnknownRecord = Record<string, unknown>;

export type TurnEventParseResult =
	| { accepted: true; turn: NativeActivityTurn }
	| { accepted: false; reason: string };

export type TurnApplyResult = {
	turns: NativeActivityTurn[];
	accepted: boolean;
	reason: "applied" | "duplicate" | "out_of_order" | "invalid_regression";
};

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readRequiredString(record: UnknownRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableString(
	record: UnknownRecord,
	key: string,
): string | null | undefined {
	const value = record[key];
	if (value === null) return null;
	if (typeof value === "string") return value;
	return undefined;
}

function readTimestamp(
	record: UnknownRecord,
	key: string,
	required: boolean,
): string | null | undefined {
	const value = record[key];
	if (!required && value === null) return null;
	if (typeof value !== "string" || !value) return undefined;
	return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function isTurnStatus(value: unknown): value is NativeTurnStatus {
	return (
		typeof value === "string" &&
		(TURN_STATUSES as readonly string[]).includes(value)
	);
}

export function parseNativeActivityTurn(input: {
	spaceId: string;
	turn: unknown;
	session?: unknown;
	sourceOrder: number;
	previous?: NativeActivityTurn | null;
}): TurnEventParseResult {
	if (!input.spaceId || !isRecord(input.turn)) {
		return { accepted: false, reason: "turn is not an object" };
	}
	const record = input.turn;
	const id = readRequiredString(record, "id");
	const sessionId = readRequiredString(record, "sessionId");
	const sequence = record.sequence;
	const status = record.status;
	const createdAt = readTimestamp(record, "createdAt", true);
	const updatedAt = readTimestamp(record, "updatedAt", true);
	const startedAt = readTimestamp(record, "startedAt", false);
	const completedAt = readTimestamp(record, "completedAt", false);
	const provider = readNullableString(record, "provider");
	const model = readNullableString(record, "model");
	const errorMessage = readNullableString(record, "errorMessage");
	const userPreview = readNullableString(record, "userPreview");
	const assistantPreview = readNullableString(record, "assistantPreview");
	if (
		!id ||
		!sessionId ||
		!Number.isInteger(sequence) ||
		Number(sequence) < 1 ||
		!isTurnStatus(status) ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string" ||
		startedAt === undefined ||
		completedAt === undefined ||
		provider === undefined ||
		model === undefined ||
		errorMessage === undefined ||
		userPreview === undefined ||
		assistantPreview === undefined ||
		!Number.isFinite(input.sourceOrder)
	) {
		return { accepted: false, reason: "turn fields are malformed" };
	}

	const session = isRecord(input.session) ? input.session : null;
	const sessionTitleValue = session
		? readNullableString(session, "title")
		: undefined;
	const sessionSource = session
		? readNullableString(session, "source")
		: undefined;
	const sessionHarness = session
		? readNullableString(session, "agentHarness")
		: undefined;
	if (sessionTitleValue === undefined && session) {
		return { accepted: false, reason: "session title is malformed" };
	}
	if (sessionSource === undefined && session) {
		return { accepted: false, reason: "session source is malformed" };
	}
	if (sessionHarness === undefined && session) {
		return { accepted: false, reason: "session harness is malformed" };
	}
	const sessionTitle = parseNativeDisplayName(
		session ? sessionTitleValue : input.previous?.sessionTitle,
	);
	if (!sessionTitle) {
		return { accepted: false, reason: "session display name is malformed" };
	}

	return {
		accepted: true,
		turn: {
			id,
			spaceId: input.spaceId,
			sessionId,
			sessionTitle,
			sessionSource: sessionSource ?? input.previous?.sessionSource ?? null,
			sessionHarness: sessionHarness ?? input.previous?.sessionHarness ?? null,
			sequence: Number(sequence),
			status,
			provider,
			model,
			userPreview,
			assistantPreview,
			startedAt,
			completedAt,
			createdAt,
			updatedAt,
			errorMessage,
			sourceOrder: input.sourceOrder,
		},
	};
}

export function parseTurnRealtimeEvent(
	event: unknown,
	previous?: NativeActivityTurn | null,
): TurnEventParseResult {
	if (!isRecord(event))
		return { accepted: false, reason: "event is not an object" };
	if (
		event.type !== "session.turn.created" &&
		event.type !== "session.turn.updated" &&
		event.type !== "session.turn.finalized"
	) {
		return { accepted: false, reason: "event type is not authoritative" };
	}
	const spaceId = readRequiredString(event, "spaceId");
	const sessionId = readRequiredString(event, "sessionId");
	const timestamp = event.timestamp;
	const payload = event.payload;
	if (
		!spaceId ||
		!sessionId ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		!isRecord(payload)
	) {
		return { accepted: false, reason: "event envelope is malformed" };
	}
	const rawTurn = payload.turn;
	if (!isRecord(rawTurn)) {
		return { accepted: false, reason: "event turn is malformed" };
	}
	const normalizedTurn = {
		provider: null,
		model: null,
		userPreview: null,
		assistantPreview: null,
		startedAt: null,
		completedAt: null,
		errorMessage: null,
		...(previous
			? {
					id: previous.id,
					sessionId: previous.sessionId,
					sequence: previous.sequence,
					status: previous.status,
					provider: previous.provider,
					model: previous.model,
					userPreview: previous.userPreview,
					assistantPreview: previous.assistantPreview,
					startedAt: previous.startedAt,
					completedAt: previous.completedAt,
					createdAt: previous.createdAt,
					updatedAt: previous.updatedAt,
					errorMessage: previous.errorMessage,
				}
			: {}),
		...rawTurn,
		...(Object.hasOwn(rawTurn, "userText")
			? { userPreview: rawTurn.userText }
			: {}),
		...(Object.hasOwn(rawTurn, "assistantText")
			? { assistantPreview: rawTurn.assistantText }
			: {}),
	};
	const result = parseNativeActivityTurn({
		spaceId,
		turn: normalizedTurn,
		sourceOrder: timestamp,
		previous,
	});
	if (result.accepted && result.turn.sessionId !== sessionId) {
		return { accepted: false, reason: "event session does not match turn" };
	}
	return result;
}

function sameTurn(left: NativeActivityTurn, right: NativeActivityTurn) {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function applyNativeActivityTurn(
	turns: NativeActivityTurn[],
	incoming: NativeActivityTurn,
): TurnApplyResult {
	const index = turns.findIndex((turn) => turn.id === incoming.id);
	if (index < 0) {
		return { turns: [...turns, incoming], accepted: true, reason: "applied" };
	}
	const current = turns[index];
	if (!current) {
		return { turns, accepted: false, reason: "out_of_order" };
	}
	const currentUpdatedAt = Date.parse(current.updatedAt);
	const incomingUpdatedAt = Date.parse(incoming.updatedAt);
	if (
		incomingUpdatedAt < currentUpdatedAt ||
		(incomingUpdatedAt === currentUpdatedAt &&
			incoming.sourceOrder < current.sourceOrder)
	) {
		return { turns, accepted: false, reason: "out_of_order" };
	}
	if (
		TERMINAL_STATUSES.has(current.status) &&
		!TERMINAL_STATUSES.has(incoming.status)
	) {
		return { turns, accepted: false, reason: "invalid_regression" };
	}
	if (
		incomingUpdatedAt === currentUpdatedAt &&
		incoming.sourceOrder === current.sourceOrder
	) {
		return {
			turns,
			accepted: false,
			reason: sameTurn(current, incoming) ? "duplicate" : "out_of_order",
		};
	}
	const next = [...turns];
	next[index] = incoming;
	return { turns: next, accepted: true, reason: "applied" };
}

export function isActiveNativeTurn(turn: NativeActivityTurn): boolean {
	return ACTIVE_STATUSES.has(turn.status);
}

export function reconcilePinnedSpaceOrder(
	previousOrder: string[],
	spaces: Array<{ id: string; isPinned?: boolean }>,
	limit = 3,
): string[] {
	const pinnedIds = spaces
		.filter((space) => space.isPinned)
		.map((space) => space.id);
	const pinnedSet = new Set(pinnedIds);
	const next = previousOrder.filter((id, index) => {
		return pinnedSet.has(id) && previousOrder.indexOf(id) === index;
	});
	for (const id of pinnedIds) {
		if (!next.includes(id)) next.push(id);
	}
	return next.slice(0, limit);
}

function latestTurnBySession(turns: NativeActivityTurn[]) {
	const latest = new Map<string, NativeActivityTurn>();
	for (const turn of turns) {
		const current = latest.get(turn.sessionId);
		if (
			!current ||
			turn.sequence > current.sequence ||
			(turn.sequence === current.sequence &&
				Date.parse(turn.updatedAt) > Date.parse(current.updatedAt))
		) {
			latest.set(turn.sessionId, turn);
		}
	}
	return latest;
}

function dispatchTime(turn: NativeActivityTurn) {
	return Date.parse(turn.startedAt ?? turn.createdAt);
}

export function selectNativePulseFocus(input: {
	explicitFocus: ExplicitNativeFocus | null;
	candidateSpaceIds: string[];
	turnsBySpace: ReadonlyMap<string, NativeActivityTurn[]>;
}): NativePulseFocus | null {
	if (input.explicitFocus) return input.explicitFocus;
	let selected: NativeActivityTurn | null = null;
	for (const spaceId of input.candidateSpaceIds) {
		const latest = latestTurnBySession(input.turnsBySpace.get(spaceId) ?? []);
		for (const turn of latest.values()) {
			if (!isActiveNativeTurn(turn)) continue;
			if (
				!selected ||
				dispatchTime(turn) > dispatchTime(selected) ||
				(dispatchTime(turn) === dispatchTime(selected) &&
					turn.sourceOrder > selected.sourceOrder)
			) {
				selected = turn;
			}
		}
	}
	return selected
		? {
				spaceId: selected.spaceId,
				sessionId: selected.sessionId,
				explicit: false,
			}
		: null;
}

export function phaseForTurn(status: NativeTurnStatus): NativeActivityPhase {
	if (status === "queued") return "dispatching";
	if (status === "running") return "working";
	if (status === "abort_requested") return "stopping";
	if (status === "failed") return "error";
	return "finished";
}

export function resolveNativeFreshness(input: {
	online: boolean;
	connectionState:
		| "idle"
		| "connecting"
		| "reconnecting"
		| "open"
		| "closed"
		| "error";
	reconciling: boolean;
	hasReconciled: boolean;
	reconcileFailed: boolean;
}): NativeActivityFreshness {
	if (!input.online) return "offline";
	if (input.reconcileFailed) return "stale";
	if (
		input.reconciling ||
		!input.hasReconciled ||
		input.connectionState === "connecting" ||
		input.connectionState === "reconnecting"
	) {
		return "recovering";
	}
	if (input.connectionState === "closed" || input.connectionState === "error") {
		return "stale";
	}
	return "live";
}

function projectTurn(turn: NativeActivityTurn) {
	return {
		sessionId: turn.sessionId,
		sessionTitle: turn.sessionTitle,
		turnId: turn.id,
		status: turn.status,
		phase: phaseForTurn(turn.status),
		harness: turn.sessionHarness,
		model: turn.model,
		summary: turn.assistantPreview?.trim() || turn.userPreview?.trim() || null,
		startedAt: turn.startedAt ?? turn.createdAt,
		updatedAt: turn.updatedAt,
		errorMessage: turn.errorMessage,
	};
}

function pickSpaceActivity(
	turns: NativeActivityTurn[],
	focus: NativePulseFocus | null,
) {
	const latest = latestTurnBySession(turns);
	if (focus?.sessionId) {
		const focused = latest.get(focus.sessionId);
		if (focused) return focused;
		if (focus.explicit) return null;
	}
	return (
		[...latest.values()].sort((left, right) => {
			const activeDelta =
				Number(isActiveNativeTurn(right)) - Number(isActiveNativeTurn(left));
			if (activeDelta) return activeDelta;
			return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
		})[0] ?? null
	);
}

export function buildNativeActivitySnapshot(input: {
	revision: number;
	generatedAt: string;
	freshness: NativeActivityFreshness;
	spaces: NativeActivitySpaceSource[];
	watchedSpaceIds: string[];
	turnsBySpace: ReadonlyMap<string, NativeActivityTurn[]>;
	focus: NativePulseFocus | null;
	currentRouteSpaceId?: string | null;
}): NativeActivitySnapshot {
	const watchedSet = new Set(input.watchedSpaceIds);
	const boardSpaces = input.watchedSpaceIds
		.map((id) => input.spaces.find((space) => space.id === id))
		.filter((space): space is NativeActivitySpaceSource => Boolean(space));
	const focusedSpace = input.focus
		? (input.spaces.find((space) => space.id === input.focus?.spaceId) ?? null)
		: null;
	const catalogSpaces =
		focusedSpace && !watchedSet.has(focusedSpace.id)
			? [...boardSpaces, focusedSpace]
			: boardSpaces;
	const focusedTurn = input.focus?.sessionId
		? latestTurnBySession(
				input.turnsBySpace.get(input.focus.spaceId) ?? [],
			).get(input.focus.sessionId)
		: null;
	const primarySpaceId =
		input.focus && focusedSpace
			? input.focus.spaceId
			: input.currentRouteSpaceId && watchedSet.has(input.currentRouteSpaceId)
				? input.currentRouteSpaceId
				: (boardSpaces[0]?.id ?? null);

	let activeCount = 0;
	for (const turns of input.turnsBySpace.values()) {
		for (const turn of latestTurnBySession(turns).values()) {
			if (isActiveNativeTurn(turn)) activeCount += 1;
		}
	}
	const focusedIsActive = Boolean(
		focusedTurn && isActiveNativeTurn(focusedTurn),
	);

	return {
		schemaVersion: NATIVE_ACTIVITY_SCHEMA_VERSION,
		revision: input.revision,
		generatedAt: input.generatedAt,
		freshness: input.freshness,
		primarySpaceId,
		primarySessionId:
			focusedTurn && focusedSpace ? (input.focus?.sessionId ?? null) : null,
		otherActiveCount: Math.max(activeCount - Number(focusedIsActive), 0),
		boardSpaceIds: boardSpaces.map((space) => space.id),
		spaces: catalogSpaces.map((space) => {
			const turns = input.turnsBySpace.get(space.id) ?? [];
			const latest = latestTurnBySession(turns);
			const activity = pickSpaceActivity(
				turns,
				input.focus?.spaceId === space.id ? input.focus : null,
			);
			return {
				spaceId: space.id,
				spaceName: space.name,
				origin: space.origin,
				isPrimary: space.id === primarySpaceId,
				activeAgentCount: [...latest.values()].filter(isActiveNativeTurn)
					.length,
				attentionCount: [...latest.values()].filter(
					(turn) => turn.status === "failed",
				).length,
				activity: activity ? projectTurn(activity) : null,
			};
		}),
	};
}

export function getFocusedActiveTurn(
	focus: NativePulseFocus | null,
	turnsBySpace: ReadonlyMap<string, NativeActivityTurn[]>,
): NativeActivityTurn | null {
	if (!focus?.sessionId) return null;
	const turn = latestTurnBySession(turnsBySpace.get(focus.spaceId) ?? []).get(
		focus.sessionId,
	);
	return turn && isActiveNativeTurn(turn) ? turn : null;
}

export function projectNativeActivityTurn(turn: NativeActivityTurn) {
	return projectTurn(turn);
}
