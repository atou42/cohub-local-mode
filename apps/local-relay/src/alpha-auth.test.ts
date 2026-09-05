import assert from "node:assert/strict";
import test from "node:test";
import {
	alphaAccountId,
	alphaNodeId,
	requireAlphaUserClaims,
} from "./alpha-auth.ts";
import { RelayProtocolError } from "./protocol.ts";

test("alpha user claims require the dedicated Logto client", () => {
	assert.deepEqual(
		requireAlphaUserClaims(
			{
				sub: "logto-subject",
				talesofai_uuid: "user-uuid",
				client_id: "alpha-client",
			},
			"alpha-client",
		),
		{
			subject: "logto-subject",
			userUuid: "user-uuid",
			clientId: "alpha-client",
		},
	);
	for (const payload of [
		{ sub: "logto-subject", talesofai_uuid: "user-uuid", client_id: "other" },
		{
			sub: "logto-subject",
			talesofai_uuid: "user-uuid",
			client_id: "alpha-client",
			is_third_party: true,
		},
		{ talesofai_uuid: "user-uuid", client_id: "alpha-client" },
	]) {
		assert.throws(
			() => requireAlphaUserClaims(payload, "alpha-client"),
			(error: unknown) =>
				error instanceof RelayProtocolError &&
				(error.code === "alpha_client_mismatch" ||
					error.code === "alpha_third_party_token" ||
					error.code === "alpha_token_invalid"),
		);
	}
});

test("alpha node IDs isolate the same device UUID between accounts", async () => {
	const first = await alphaNodeId({
		accountId: "a".repeat(64),
		deviceId: "669526bb-bf65-4013-a825-4f61adf199f8",
	});
	const repeated = await alphaNodeId({
		accountId: "a".repeat(64),
		deviceId: "669526bb-bf65-4013-a825-4f61adf199f8",
	});
	const otherAccount = await alphaNodeId({
		accountId: "b".repeat(64),
		deviceId: "669526bb-bf65-4013-a825-4f61adf199f8",
	});
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.equal(first, repeated);
	assert.notEqual(first, otherAccount);
});

test("alpha account IDs are stable per issuer and subject", async () => {
	const first = await alphaAccountId({
		issuer: "https://auth.neta.art/oidc",
		subject: "subject-a",
	});
	const repeated = await alphaAccountId({
		issuer: "https://auth.neta.art/oidc",
		subject: "subject-a",
	});
	const other = await alphaAccountId({
		issuer: "https://auth.neta.art/oidc",
		subject: "subject-b",
	});
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.equal(first, repeated);
	assert.notEqual(first, other);
});
