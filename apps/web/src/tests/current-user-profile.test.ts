import assert from "node:assert/strict";
import test from "node:test";
import { resolveMessageAuthorProfile } from "../lib/message-author-profile.ts";

const staleLocalProfile = {
	userUuid: "dec89612d5074605aeeb101a2918379a",
	username: null,
	displayName: "atou",
	avatarUrl: null,
};

const cloudProfile = {
	userUuid: "dec89612d5074605aeeb101a2918379a",
	username: "atou",
	displayName: "ATou",
	avatarUrl: "https://example.com/avatar.png",
};

test("uses the authenticated profile for the current user's local turns", () => {
	assert.deepEqual(
		resolveMessageAuthorProfile({
			messageAuthorUuid: staleLocalProfile.userUuid,
			messageAuthorProfile: staleLocalProfile,
			currentUserUuid: cloudProfile.userUuid,
			currentUserProfile: cloudProfile,
		}),
		cloudProfile,
	);
});

test("does not replace another participant's profile", () => {
	assert.deepEqual(
		resolveMessageAuthorProfile({
			messageAuthorUuid: "another-user",
			messageAuthorProfile: staleLocalProfile,
			currentUserUuid: cloudProfile.userUuid,
			currentUserProfile: cloudProfile,
		}),
		staleLocalProfile,
	);
});

test("keeps the server profile until the authenticated profile is loaded", () => {
	assert.deepEqual(
		resolveMessageAuthorProfile({
			messageAuthorUuid: staleLocalProfile.userUuid,
			messageAuthorProfile: staleLocalProfile,
			currentUserUuid: cloudProfile.userUuid,
			currentUserProfile: null,
		}),
		staleLocalProfile,
	);
});

test("recognizes the current user from the server profile when authorUuid is absent", () => {
	assert.deepEqual(
		resolveMessageAuthorProfile({
			messageAuthorUuid: null,
			messageAuthorProfile: staleLocalProfile,
			currentUserUuid: cloudProfile.userUuid,
			currentUserProfile: cloudProfile,
		}),
		cloudProfile,
	);
});
