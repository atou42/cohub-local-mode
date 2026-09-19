import type { GlobalSearchResult } from "@neta-art/cohub";
import { sortCommandItems } from "./score";
import type { CommandPaletteItem } from "./types";

function keyFor(
	item: Pick<
		CommandPaletteItem,
		"type" | "spaceId" | "sessionId" | "turnId" | "id"
	>,
) {
	if (item.type === "turn") return `turn:${item.turnId ?? item.id}`;
	if (item.type === "session") return `session:${item.sessionId ?? item.id}`;
	if (item.type === "label") return `label:${item.id}`;
	if (item.type === "command") return `command:${item.id}`;
	return `space:${item.spaceId}`;
}

export function commandItemKey(
	item: Pick<
		CommandPaletteItem,
		"type" | "spaceId" | "sessionId" | "turnId" | "id"
	>,
) {
	return keyFor(item);
}

type CommandItemKeySource = Pick<
	CommandPaletteItem,
	"type" | "spaceId" | "sessionId" | "turnId" | "id"
>;

/**
 * True when two lists resolve to the same ordered keys. The palette result
 * list is keyed by these identities, so a refresh that lands on an identical
 * sequence changes nothing visually — callers can skip the state update (and
 * the re-render) entirely instead of swapping in an equivalent list.
 */
export function sameCommandItemSequence(
	left: readonly CommandItemKeySource[],
	right: readonly CommandItemKeySource[],
) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (keyFor(left[index]) !== keyFor(right[index])) return false;
	}
	return true;
}

function remoteToItem(item: GlobalSearchResult): CommandPaletteItem {
	return {
		...item,
		excerpt: item.excerpt ?? null,
		spaceName: item.spaceName ?? null,
		sessionTitle: item.sessionTitle ?? null,
		viewerRelation: item.viewerRelation ?? null,
		viewerTier: item.effectiveTier ?? undefined,
		source: "remote",
		spaceOrigin: "cloud",
		remoteScore: item.score,
	};
}

export function mergeCommandResults(input: {
	local: CommandPaletteItem[];
	remote: GlobalSearchResult[];
	limit?: number;
	longQuery?: boolean;
}) {
	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of input.local) byKey.set(keyFor(item), item);
	for (const remoteResult of input.remote) {
		const item = remoteToItem(remoteResult);
		const key = keyFor(item);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, item);
			continue;
		}
		if (existing.spaceOrigin === "local") {
			throw new Error(`Space ${item.spaceId} was returned by both local and cloud nodes`);
		}
		// Remote knows the viewer relation authoritatively; keep its tier.
		byKey.set(key, {
			...existing,
			...item,
			source: "local+remote",
			localScore: existing.localScore ?? existing.score,
			remoteScore: item.score,
			score: Math.max(existing.score, item.score),
			textScore: Math.max(existing.textScore, item.textScore),
			recencyScore: Math.max(existing.recencyScore, item.recencyScore),
			typePriorityScore: Math.max(
				existing.typePriorityScore,
				item.typePriorityScore,
			),
		});
	}
	return sortCommandItems([...byKey.values()], input.longQuery).slice(
		0,
		input.limit ?? 30,
	);
}
