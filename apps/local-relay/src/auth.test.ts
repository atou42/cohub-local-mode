import assert from "node:assert/strict";
import test from "node:test";
import { authorizeNodeRequest, requireOwnerAccessIdentity } from "./auth.ts";
import { RelayProtocolError } from "./protocol.ts";

test("node bearer authentication fails closed", async () => {
	await assert.rejects(
		() => authorizeNodeRequest(new Request("https://relay.test"), "expected"),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "node_token_missing" &&
			error.status === 401,
	);
	await assert.rejects(
		() =>
			authorizeNodeRequest(
				new Request("https://relay.test", {
					headers: { authorization: "Bearer wrong" },
				}),
				"expected",
			),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "node_token_invalid" &&
			error.status === 403,
	);
	await assert.doesNotReject(() =>
		authorizeNodeRequest(
			new Request("https://relay.test", {
				headers: { authorization: "Bearer expected" },
			}),
			"expected",
		),
	);
});

test("owner identity requires the configured email and a verified Access subject", () => {
	assert.deepEqual(
		requireOwnerAccessIdentity(
			{ sub: "access-subject", email: "Owner@Example.com" },
			"owner@example.com",
		),
		{ subject: "access-subject", email: "owner@example.com" },
	);
	for (const payload of [
		{ sub: "access-subject", email: "attacker@example.com" },
		{ email: "owner@example.com" },
	]) {
		assert.throws(
			() => requireOwnerAccessIdentity(payload, "owner@example.com"),
			(error: unknown) => error instanceof RelayProtocolError && error.status === 403,
		);
	}
});
