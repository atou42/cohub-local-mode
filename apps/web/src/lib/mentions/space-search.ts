import type { GlobalSearchResult, SpaceRecord } from "@neta-art/cohub";
import {
	idbGetAllByIndex,
	idbGetSomeByIndex,
	type SessionListCacheRecord,
	type SpaceRecordCacheRecord,
} from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import { recencyScore, textMatchScore } from "$lib/command-palette/score";
import { sdk } from "$lib/sdk";
import { getSpaceOrigin, registerSpaceOrigin } from "$lib/space-origin";
import {
	getSpacePublicProfile,
	normalizeSpacePublicProfile,
} from "$lib/space-profile";
import { getCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import {
	buildSpaceMentionHref,
	buildSpaceMentionUri,
	type SpaceMentionSuggestion,
} from "./space";

const SPACE_LINK_RESOLVE_LIMIT = 20;

const LOCAL_LIMIT = 24;
const REMOTE_LIMIT = 30;
const LOCAL_ACTIVITY_SESSION_LIST_SCAN_LIMIT = 120;

function compactText(value: string | null | undefined, limit: number) {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - 1))}…`
		: text;
}

function scoreSpace(input: {
	name: string | null | undefined;
	description?: string | null;
	query: string;
	activityAt?: string | null;
}) {
	const nameScore = textMatchScore(input.name, input.query);
	const descriptionScore =
		textMatchScore(input.description, input.query) * 0.72;
	const textScore = Math.max(nameScore, descriptionScore);
	const fresh = recencyScore(input.activityAt);
	const score = textScore * 0.82 + fresh * 0.18;
	return { score, textScore, recencyScore: fresh };
}

function spaceName(space: Pick<SpaceRecord, "name" | "title" | "id">) {
	return space.name ?? space.title ?? `space:${space.id.slice(0, 8)}`;
}

function localSpaceToSuggestion(
	space: SpaceRecord,
	query: string,
	activityAt?: string | null,
): SpaceMentionSuggestion | null {
	const spaceActivityAt =
		activityAt ??
		space.lastActivityAt ??
		space.updatedAt ??
		space.createdAt ??
		null;
	const scored = scoreSpace({
		name: space.name ?? space.title,
		description: space.description,
		query,
		activityAt: spaceActivityAt,
	});
	if (query.trim() && scored.textScore <= 0) return null;
	return {
		type: "space",
		id: space.id,
		spaceId: space.id,
		name: spaceName(space),
		description: compactText(space.description, 180),
		ownerProfile: space.ownerProfile ?? null,
		spaceProfile: getSpacePublicProfile(space),
		href: buildSpaceMentionHref(space.id),
		uri: buildSpaceMentionUri(space.id),
		origin: getSpaceOrigin(space),
		activityAt: spaceActivityAt,
		source: "local",
		...scored,
	};
}

function remoteSpaceToSuggestion(
	item: GlobalSearchResult,
): SpaceMentionSuggestion | null {
	if (item.type !== "space") return null;
	const ownerProfile = "ownerProfile" in item ? item.ownerProfile : null;
	const spaceProfile = "spaceProfile" in item ? item.spaceProfile : null;
	return {
		type: "space",
		id: item.spaceId,
		spaceId: item.spaceId,
		name: item.title || item.spaceName || `space:${item.spaceId.slice(0, 8)}`,
		description: compactText(item.excerpt ?? null, 180),
		ownerProfile: ownerProfile ?? null,
		spaceProfile: normalizeSpacePublicProfile(spaceProfile),
		href: item.href || buildSpaceMentionHref(item.spaceId),
		uri: buildSpaceMentionUri(item.spaceId),
		origin: "cloud",
		activityAt: item.updatedAt,
		source: "remote",
		score: item.score,
		textScore: item.textScore,
		recencyScore: item.recencyScore,
	};
}

function sortSuggestions(items: SpaceMentionSuggestion[]) {
	return [...items].sort((a, b) => {
		const scoreDelta = b.score - a.score;
		if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
		const textDelta = b.textScore - a.textScore;
		if (Math.abs(textDelta) > 0.0001) return textDelta;
		return timeValue(b.activityAt) - timeValue(a.activityAt);
	});
}

function timeValue(value: string | null | undefined) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function sessionActivityAt(
	session: Pick<SpaceRecord, "updatedAt" | "createdAt"> & {
		lastMessageAt?: string | null;
	},
) {
	return (
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null
	);
}

function newerTime(
	current: string | null | undefined,
	candidate: string | null | undefined,
): string | null {
	return timeValue(candidate) > timeValue(current)
		? (candidate ?? null)
		: (current ?? null);
}

async function getLocalSessionActivityBySpace(
	userKey: string,
	options?: { signal?: AbortSignal },
) {
	const activityBySpace = new Map<string, string | null>();
	const sessionLists = await idbGetSomeByIndex<SessionListCacheRecord>(
		"session_lists",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
		{
			limit: LOCAL_ACTIVITY_SESSION_LIST_SCAN_LIMIT,
			direction: "prev",
			filter: (record) => record.userKey === userKey,
		},
	);
	shouldAbort(options?.signal);
	for (const record of sessionLists) {
		if (record.userKey !== userKey) continue;
		let activityAt = record.watermark;
		for (const session of record.sessions) {
			activityAt = newerTime(activityAt, sessionActivityAt(session));
		}
		const current = activityBySpace.get(record.spaceId);
		activityBySpace.set(record.spaceId, newerTime(current, activityAt) ?? null);
	}
	return activityBySpace;
}

function shouldAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");
}

export function mergeSpaceMentionSuggestions(input: {
	local: SpaceMentionSuggestion[];
	remote: SpaceMentionSuggestion[];
	currentSpaceId?: string | null;
	limit?: number;
}) {
	const byId = new Map<string, SpaceMentionSuggestion>();
	for (const item of input.local) {
		if (item.spaceId === input.currentSpaceId) continue;
		byId.set(item.spaceId, item);
	}
	for (const item of input.remote) {
		if (item.spaceId === input.currentSpaceId) continue;
		const existing = byId.get(item.spaceId);
		if (!existing) {
			byId.set(item.spaceId, item);
			continue;
		}
		if (existing.origin !== item.origin) {
			throw new Error(
				`Space ${item.spaceId} was returned by both local and cloud nodes`,
			);
		}
		byId.set(item.spaceId, {
			...existing,
			...item,
			ownerProfile: item.ownerProfile ?? existing.ownerProfile,
			spaceProfile: normalizeSpacePublicProfile(
				item.spaceProfile ?? existing.spaceProfile,
			),
			description: item.description ?? existing.description,
			source: "local+remote",
			score: Math.max(existing.score, item.score),
			textScore: Math.max(existing.textScore, item.textScore),
			recencyScore: Math.max(existing.recencyScore, item.recencyScore),
		});
	}
	return sortSuggestions([...byId.values()]).slice(
		0,
		input.limit ?? REMOTE_LIMIT,
	);
}

export async function searchLocalSpaceMentions(
	query: string,
	options?: {
		signal?: AbortSignal;
		currentSpaceId?: string | null;
		limit?: number;
	},
): Promise<SpaceMentionSuggestion[]> {
	const normalized = query.trim();
	const spaces: SpaceRecord[] = [];
	const seen = new Set<string>();
	const add = (space: SpaceRecord) => {
		if (space.id === options?.currentSpaceId || seen.has(space.id)) return;
		seen.add(space.id);
		spaces.push(space);
	};

	for (const space of getCachedSpaceList() ?? []) add(space);
	shouldAbort(options?.signal);

	const userKey = getCacheUserKey();
	const records = await idbGetAllByIndex<SpaceRecordCacheRecord>(
		"space_records",
		"by_updated_at",
		IDBKeyRange.lowerBound(0),
	);
	shouldAbort(options?.signal);
	for (const record of records) {
		if (record.userKey !== userKey) continue;
		add(record.space);
	}

	const activityBySpace = normalized
		? null
		: await getLocalSessionActivityBySpace(userKey, {
				signal: options?.signal,
			});
	shouldAbort(options?.signal);

	const items = spaces
		.map((space) =>
			localSpaceToSuggestion(
				space,
				normalized,
				activityBySpace?.get(space.id) ?? null,
			),
		)
		.filter((item): item is SpaceMentionSuggestion => Boolean(item));

	return sortSuggestions(items).slice(0, options?.limit ?? LOCAL_LIMIT);
}

export async function resolveSpaceMentionLabels(
	spaceIds: string[],
	options?: { signal?: AbortSignal; limit?: number },
): Promise<Map<string, string>> {
	const unique = [...new Set(spaceIds.filter(Boolean))].slice(
		0,
		options?.limit ?? SPACE_LINK_RESOLVE_LIMIT,
	);
	const resolved = new Map<string, string>();
	await Promise.all(
		unique.map(async (spaceId) => {
			try {
				const space = await sdk
					.space(spaceId)
					.get((input, init) =>
						fetch(input, { ...init, signal: options?.signal }),
					);
				cacheSpaceRecordSoon(space);
				registerSpaceOrigin(space);
				const name = space.name ?? space.title;
				if (name) resolved.set(spaceId, name);
			} catch (error) {
				if ((error as { name?: string })?.name === "AbortError") return;
				// Detail endpoint intentionally returns minimal public/session-accessible
				// data when possible. If a space is unavailable, keep the fallback label.
			}
		}),
	);
	return resolved;
}

export async function searchRemoteSpaceMentions(
	query: string,
	options?: {
		signal?: AbortSignal;
		currentSpaceId?: string | null;
		limit?: number;
	},
): Promise<SpaceMentionSuggestion[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	const fetcher: typeof fetch = (input, init) =>
		fetch(input, { ...init, signal: options?.signal });
	const result = await sdk.search.query(
		{ q, limit: options?.limit ?? REMOTE_LIMIT, types: ["space"] },
		fetcher,
	);
	const items = result.items
		.map(remoteSpaceToSuggestion)
		.filter((item): item is SpaceMentionSuggestion =>
			Boolean(item && item.spaceId !== options?.currentSpaceId),
		);
	for (const item of items) {
		registerSpaceOrigin({ id: item.spaceId, origin: item.origin });
	}
	return items;
}
