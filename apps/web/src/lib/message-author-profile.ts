import type { ChatMessage } from "$lib/session-tree";

type AuthorProfile = NonNullable<ChatMessage["authorProfile"]>;

export function resolveMessageAuthorProfile(input: {
	messageAuthorUuid?: string | null;
	messageAuthorProfile?: AuthorProfile | null;
	currentUserUuid?: string | null;
	currentUserProfile?: AuthorProfile | null;
}): AuthorProfile | null {
	const currentUserUuid = input.currentUserUuid?.trim();
	const messageAuthorUuid =
		input.messageAuthorUuid?.trim() ||
		input.messageAuthorProfile?.userUuid?.trim();
	if (
		currentUserUuid &&
		messageAuthorUuid === currentUserUuid &&
		input.currentUserProfile?.userUuid === currentUserUuid
	) {
		return input.currentUserProfile;
	}
	return input.messageAuthorProfile ?? null;
}
