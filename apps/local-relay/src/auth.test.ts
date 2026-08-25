import assert from "node:assert/strict";
import test from "node:test";
import { authorizeNodeRequest } from "./auth.ts";
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
