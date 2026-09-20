import type { SessionRecord } from "@neta-art/cohub";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import { resetGeneration } from "$lib/stores/session-generation-controller";
import { planGenerationReconcile } from "$lib/stores/session-generation-state";

export function reconcileGenerationStateFromSessionList(
	sessions: SessionRecord[],
	options?: { authoritative?: boolean; requestStartedAt?: number },
) {
	const authoritative = options?.authoritative === true;
	const requestStartedAt = options?.requestStartedAt ?? 0;
	for (const session of sessions) {
		// Older cached list records do not have activeTurn. They are useful for
		// first paint, but cannot authoritatively clear or restore generation.
		if (session.activeTurn === undefined) continue;
		const plan = planGenerationReconcile({
			current: sessionGenerationStore.get(session.id),
			activeTurn: session.activeTurn,
			authoritative,
			requestStartedAt,
		});
		if (plan.reset) resetGeneration(session.id);
		if (plan.resumeTurnId) {
			sessionGenerationStore.resumePending(session.id, {
				spaceId: session.spaceId,
				turnId: plan.resumeTurnId,
				anchorUserMessageId: session.activeTurn?.anchorUserMessageId ?? null,
			});
		}
	}
}
