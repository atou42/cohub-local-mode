import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { localAccountFromVerifiedRegistration } from "./local-account.js";

for (const userUuid of ["7c3b9d14-b3db-4dd9-a146-559ebfc1e14e", "7c3b9d14b3db4dd9a146559ebfc1e14e"]) test(`local identity preserves the verified user identifier ${userUuid.length}`, () => {
	const issuer = "https://auth.neta.art/oidc";
	const claims = { iss: issuer, sub: "verified-subject", client_id: "desktop", talesofai_uuid: userUuid };
	const accessToken = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const accountId = createHash("sha256").update(`${issuer}\0${claims.sub}`).digest("hex");
	const input = { issuer, accessToken, account: { accountId, userUuid }, deviceId: "e91fab11-b18b-46ee-8338-913fbcd1b140" };
	assert.equal(localAccountFromVerifiedRegistration(input).subject, claims.sub);
	assert.equal(localAccountFromVerifiedRegistration(input).userUuid, userUuid);
	assert.throws(() => localAccountFromVerifiedRegistration({ ...input, account: { ...input.account, accountId: "a".repeat(64) } }), /binding/);
	assert.throws(() => localAccountFromVerifiedRegistration({ ...input, issuer: "https://other.example/oidc" }), /does not match/);
	assert.throws(() => localAccountFromVerifiedRegistration({ ...input, account: { ...input.account, userUuid: "wrong-user" } }), /does not match/);
});
