import type { SessionRecord } from "@neta-art/cohub";

export function sessionMatchesContext(
	session: Pick<SessionRecord, "id" | "spaceId">,
	spaceId: string,
	sessionId: string,
) {
	return session.spaceId === spaceId && session.id === sessionId;
}
