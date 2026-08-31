import assert from "node:assert/strict";
import test from "node:test";
import {
	registerSpaceOrigins,
	resolveSpaceOrigin,
} from "../lib/space-origin.ts";
import { routeSpacePinClient } from "../lib/stores/space-pin-routing.ts";

test("space pin operations route local and cloud Spaces to their matching clients", () => {
	const localSpaceId = "space-pin-routing-local";
	const cloudSpaceId = "space-pin-routing-cloud";
	registerSpaceOrigins([
		{ id: localSpaceId, origin: "local" },
		{ id: cloudSpaceId, origin: "cloud" },
	]);

	const selectedOrigins: string[] = [];
	const clientForOrigin = (origin: "local" | "cloud") => {
		selectedOrigins.push(origin);
		return `${origin}-client`;
	};

	assert.equal(
		routeSpacePinClient(localSpaceId, resolveSpaceOrigin, clientForOrigin),
		"local-client",
	);
	assert.equal(
		routeSpacePinClient(cloudSpaceId, resolveSpaceOrigin, clientForOrigin),
		"cloud-client",
	);
	assert.deepEqual(selectedOrigins, ["local", "cloud"]);
});
