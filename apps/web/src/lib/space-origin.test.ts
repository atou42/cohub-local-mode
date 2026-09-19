import assert from "node:assert/strict";
import test from "node:test";
import {
	getSpaceOrigin,
	isLocalSpace,
	registerSpaceOrigin,
	resolveSpaceOrigin,
	routeWithSpaceOrigin,
} from "./space-origin.js";

test("older Space records remain cloud records", () => {
	assert.equal(getSpaceOrigin({}), "cloud");
	assert.equal(isLocalSpace({}), false);
});

test("local origin is explicit", () => {
	assert.equal(getSpaceOrigin({ origin: "local" }), "local");
	assert.equal(isLocalSpace({ origin: "local" }), true);
});

test("corrupt origins are not disguised as cloud", () => {
	assert.throws(
		() => getSpaceOrigin({ origin: "elsewhere" } as never),
		/Unsupported Space origin/,
	);
});

test("registered origins route Space clients without guessing", () => {
	registerSpaceOrigin({ id: "local-space", origin: "local" });
	assert.equal(resolveSpaceOrigin("local-space"), "local");
	assert.equal(resolveSpaceOrigin("unknown-cloud-space"), "cloud");
});

test("local routes preserve existing query and hash", () => {
	assert.equal(
		routeWithSpaceOrigin("/spaces/local/sessions/new?turn=2#tool", "local"),
		"/spaces/local/sessions/new?turn=2&origin=local#tool",
	);
	assert.equal(routeWithSpaceOrigin("/spaces/cloud", "cloud"), "/spaces/cloud");
});
