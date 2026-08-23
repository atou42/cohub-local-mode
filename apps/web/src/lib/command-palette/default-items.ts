import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { SessionRecord, SpaceRecord } from "@neta-art/cohub";
import {
	idbGetAllByIndex,
	idbGetSomeByIndex,
	type SessionListCacheRecord,
	type SessionTurnsCacheRecord,
	type SpaceRecordCacheRecord,
} from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import {
	getSpaceOrigin,
	resolveSpaceOrigin,
	routeWithSpaceOrigin,
} from "$lib/space-origin";
import { getSpacePublicProfile } from "$lib/space-profile";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { commandItemKey } from "./merge-results";
import { allowsResourceType, type CommandPaletteSearchPlan } from "./scope";
import { recencyScore } from "./score";
import type { CommandPaletteItem } from "./types";

const DEFAULT_LIMIT = 30;
const DEFAULT_SESSION_LIST_SCAN_LIMIT = 120;
const DEFAULT_TURN_RECORD_SCAN_LIMIT = 80;

function compactText(value: string | null | undefined, limit: number) {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - 1))}…`
		: text;
}

function timeValue(value: string | null | undefined) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function timestampValue(value: number | null | undefined) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isoFromTimestamp(value: number) {
	return value > 0 ? new Date(value).toISOString() : null;
}

function sessionActivityAt(session: SessionRecord) {
	return (
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null
	);
}

function spaceActivityAt(space: SpaceRecord) {
	return space.lastActivityAt ?? space.updatedAt ?? space.createdAt ?? null;
}

function newerTime(
	current: string | null | undefined,
	candidate: string | null | undefined,
): string | null {
	return timeValue(candidate) > timeValue(current)
		? (candidate ?? null)
		: (current ?? null);
}

function getSessionActivityBySpace(records: SessionListCacheRecord[]) {
	const activityBySpace = new Map<string, string | null>();
	for (const record of records) {
		let activityAt = record.watermark;
		for (const session of record.sessions) {
			activityAt = newerTime(activityAt, sessionActivityAt(session));
		}
		const current = activityBySpace.get(record.spaceId);
		activityBySpace.set(record.spaceId, newerTime(current, activityAt));
	}
	return activityBySpace;
}

function defaultScore(rank: number, updatedAt: string | null | undefined) {
	const fresh = recencyScore(updatedAt);
	return {
		score: Math.max(0.2, 0.92 - rank * 0.012) * 0.72 + fresh * 0.28,
		textScore: 0,
		recencyScore: fresh,
	};
}

function spaceToDefaultItem(
	space: SpaceRecord,
	rank: number,
	currentSpaceId?: string | null,
	activityAt?: string | null,
): CommandPaletteItem {
	const updatedAt = activityAt ?? spaceActivityAt(space);
	const score = defaultScore(rank, updatedAt);
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		sessionId: null,
		turnId: null,
		sequence: null,
		title: space.name ?? "Untitled space",
		excerpt: compactText(space.description, 220),
		spaceName: space.name ?? null,
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
		sessionTitle: null,
		matchedField: "name",
		href: routeWithSpaceOrigin(
			buildSpaceLandingRoute(space.id),
			getSpaceOrigin(space),
		),
		updatedAt,
		source: "default",
		localScore: score.score,
		isPinned: space.isPinned ?? false,
		spaceOrigin: getSpaceOrigin(space),
		typePriorityScore: currentSpaceId === space.id ? 0.93 : 0.88,
		...score,
	};
}

function sessionToDefaultItem(
	session: SessionRecord,
	spaceName: string | null,
	rank: number,
): CommandPaletteItem {
	const title = session.title || "Untitled session";
	const updatedAt =
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null;
	const score = defaultScore(rank, updatedAt);
	return {
		type: "session",
		id: session.id,
		spaceId: session.spaceId,
		sessionId: session.id,
		turnId: null,
		sequence: null,
		title,
		excerpt: null,
		spaceName,
		sessionTitle: title,
		matchedField: "title",
		href: routeWithSpaceOrigin(
			`/spaces/${session.spaceId}/sessions/${session.id}`,
			resolveSpaceOrigin(session.spaceId),
		),
		updatedAt,
		source: "default",
		localScore: score.score,
		typePriorityScore: 0.74,
		...score,
	};
}

function turnToDefaultItem(input: {
	turn: SessionTurnRecord;
	session: SessionRecord | null;
	spaceId: string;
	spaceName: string | null;
	rank: number;
}): CommandPaletteItem | null {
	const text = input.turn.userText ?? "";
	const title = compactText(text, 140);
	if (!title) return null;
	const updatedAt = input.turn.updatedAt ?? input.turn.createdAt ?? null;
	const score = defaultScore(input.rank, updatedAt);
	return {
		type: "turn",
		id: input.turn.id,
		spaceId: input.spaceId,
		sessionId: input.turn.sessionId,
		turnId: input.turn.id,
		sequence: input.turn.sequence,
		title,
		excerpt: compactText(text, 260),
		spaceName: input.spaceName,
		sessionTitle: input.session?.title ?? null,
		matchedField: "userText",
		href: routeWithSpaceOrigin(
			`/spaces/${input.spaceId}/sessions/${input.turn.sessionId}?turn=${input.turn.sequence}`,
			resolveSpaceOrigin(input.spaceId),
		),
		updatedAt,
		source: "default",
		localScore: score.score,
		typePriorityScore: 0.66,
		...score,
	};
}

function shouldAbort(signal?: AbortSignal) {
	if (signal?.aborted)
		throw new DOMException("Default items aborted", "AbortError");
}

async function yieldToUi() {
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export async function getCommandPaletteDefaultItems(
	plan: CommandPaletteSearchPlan & {
		currentSpaceId?: string | null;
		signal?: AbortSignal;
	},
): Promise<CommandPaletteItem[]> {
	shouldAbort(plan.signal);
	const userKey = getCacheUserKey();
	const spacesById = new Map<string, SpaceRecord>();

	const spaceRecords = await idbGetAllByIndex<SpaceRecordCacheRecord>(
		"space_records",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
	);
	shouldAbort(plan.signal);
	for (const record of spaceRecords) {
		if (record.userKey === userKey)
			spacesById.set(record.spaceId, record.space);
	}

	// Prefer the list cache when present: it is refreshed in the background when
	// the palette opens, while per-space IndexedDB records may lag behind briefly.
	for (const space of getCachedSpaceList() ?? [])
		spacesById.set(space.id, space);

	const items: CommandPaletteItem[] = [];
	let userSessionLists: SessionListCacheRecord[] | null = null;
	const getUserSessionLists = async () => {
		if (userSessionLists) return userSessionLists;
		const records = await idbGetSomeByIndex<SessionListCacheRecord>(
			"session_lists",
			"by_updated_at",
			IDBKeyRange.lowerBound(0),
			{
				limit: DEFAULT_SESSION_LIST_SCAN_LIMIT,
				direction: "prev",
				filter: (record) => record.userKey === userKey,
			},
		);
		shouldAbort(plan.signal);
		userSessionLists = records;
		return userSessionLists;
	};

	if (allowsResourceType(plan, "space")) {
		shouldAbort(plan.signal);
		const recentSpaces = getRecentSpaces(userKey);
		const recentRankBySpace = new Map(
			recentSpaces.map((entry, index) => [entry.spaceId, index]),
		);
		const recentActivityBySpace = new Map(
			recentSpaces.map((entry) => [entry.spaceId, entry.timestamp]),
		);
		const activityBySpace = getSessionActivityBySpace(
			await getUserSessionLists(),
		);
		const effectiveActivityTime = (space: SpaceRecord) =>
			Math.max(
				timeValue(activityBySpace.get(space.id) ?? null),
				timestampValue(recentActivityBySpace.get(space.id)),
				timeValue(spaceActivityAt(space)),
			);
		const orderedSpaces = [...spacesById.values()].sort((a, b) => {
			const activityDelta = effectiveActivityTime(b) - effectiveActivityTime(a);
			if (activityDelta !== 0) return activityDelta;
			if (a.id === plan.currentSpaceId && b.id !== plan.currentSpaceId)
				return -1;
			if (b.id === plan.currentSpaceId && a.id !== plan.currentSpaceId)
				return 1;
			const recentDelta =
				(recentRankBySpace.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
				(recentRankBySpace.get(b.id) ?? Number.MAX_SAFE_INTEGER);
			if (recentDelta !== 0) return recentDelta;
			return timeValue(spaceActivityAt(b)) - timeValue(spaceActivityAt(a));
		});
		orderedSpaces.forEach((space, rank) => {
			const effectiveActivityAt = isoFromTimestamp(
				effectiveActivityTime(space),
			);
			items.push(
				spaceToDefaultItem(
					space,
					rank,
					plan.currentSpaceId,
					effectiveActivityAt,
				),
			);
		});
	}

	if (allowsResourceType(plan, "session") || allowsResourceType(plan, "turn")) {
		await yieldToUi();
		shouldAbort(plan.signal);
		const sessionLists = await getUserSessionLists();
		const sessionsById = new Map<string, SessionRecord>();
		for (const record of sessionLists) {
			for (const session of record.sessions)
				sessionsById.set(session.id, session);
		}
		if (allowsResourceType(plan, "session")) {
			[...sessionsById.values()]
				.sort(
					(a, b) =>
						timeValue(b.lastMessageAt ?? b.updatedAt ?? b.createdAt) -
						timeValue(a.lastMessageAt ?? a.updatedAt ?? a.createdAt),
				)
				.slice(0, DEFAULT_LIMIT)
				.forEach((session, rank) => {
					items.push(
						sessionToDefaultItem(
							session,
							spacesById.get(session.spaceId)?.name ?? null,
							rank,
						),
					);
				});
		}

		if (allowsResourceType(plan, "turn")) {
			await yieldToUi();
			shouldAbort(plan.signal);
			const turnRecords = await idbGetSomeByIndex<SessionTurnsCacheRecord>(
				"session_turns",
				"by_last_accessed",
				IDBKeyRange.lowerBound(0),
				{
					limit: DEFAULT_TURN_RECORD_SCAN_LIMIT,
					direction: "prev",
					filter: (record) => record.userKey === userKey,
				},
			);
			shouldAbort(plan.signal);
			let rank = 0;
			for (const record of turnRecords
				.filter((record) => record.userKey === userKey)
				.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)) {
				const session =
					record.session ?? sessionsById.get(record.sessionId) ?? null;
				const turns = [...record.turns].sort(
					(a, b) =>
						timeValue(b.updatedAt ?? b.createdAt) -
						timeValue(a.updatedAt ?? a.createdAt),
				);
				for (const turn of turns) {
					const item = turnToDefaultItem({
						turn,
						session,
						spaceId: record.spaceId,
						spaceName: spacesById.get(record.spaceId)?.name ?? null,
						rank,
					});
					if (item) items.push(item);
					rank += 1;
					if (rank >= DEFAULT_LIMIT) break;
				}
				if (rank >= DEFAULT_LIMIT) break;
			}
		}
	}

	// Local commands are injected synchronously by the palette UI so they never
	// wait on IndexedDB / network. Keep this path resource-only.
	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of items) {
		const key = commandItemKey(item);
		if (!byKey.has(key)) byKey.set(key, item);
	}
	return [...byKey.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, DEFAULT_LIMIT);
}
