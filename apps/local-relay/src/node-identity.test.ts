import assert from "node:assert/strict";
import test from "node:test";
import {
	bindRelayNodeRequest,
	decideRelayNodeIdentity,
	RELAY_NODE_IDENTITY_HEADER,
} from "./node-identity.ts";
import { RelayProtocolError } from "./protocol.ts";

test("binds a dynamic node identity once and reuses stored identity", () => {
	assert.deepEqual(
		decideRelayNodeIdentity({ requested: "account:device" }),
		{ nodeId: "account:device", shouldPersist: true },
	);
	assert.deepEqual(
		decideRelayNodeIdentity({
			stored: "account:device",
			configured: "legacy-node",
		}),
		{ nodeId: "account:device", shouldPersist: false },
	);
});

test("rejects missing, malformed, and conflicting node identities", () => {
	for (const input of [
		{},
		{ requested: "contains spaces" },
		{ stored: "account:device", requested: "account:other-device" },
	]) {
		assert.throws(
			() => decideRelayNodeIdentity(input),
			(error: unknown) => error instanceof RelayProtocolError,
		);
	}
});

test("trusted relay routing overwrites a caller-supplied node identity", () => {
	const request = bindRelayNodeRequest(
		new Request("https://relay.internal/internal/node", {
			headers: { [RELAY_NODE_IDENTITY_HEADER]: "attacker" },
		}),
		undefined,
		"expected-node",
	);
	assert.equal(request.headers.get(RELAY_NODE_IDENTITY_HEADER), "expected-node");
});
