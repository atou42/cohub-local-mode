import assert from "node:assert/strict";
import test from "node:test";
import {
	ALPHA_PROJECTION_MAX_BODY_BYTES,
	alphaProjectionStorageKey,
	createAlphaReadProjection,
} from "./alpha-projection.ts";
import type { RelayCommand } from "./protocol.ts";

function command(overrides: Partial<RelayCommand> = {}): RelayCommand {
	return {
		id: "command-1",
		nodeId: "a".repeat(64),
		sequence: 1,
		idempotencyKey: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
		request: {
			method: "GET",
			path: "/api/models?harness=cursor",
			headers: {},
			body: "",
		},
		attachments: [],
		status: "succeeded",
		attempt: 1,
		acceptedAt: "2026-09-02T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:01.000Z",
		claimedAt: "2026-09-02T00:00:00.100Z",
		leaseExpiresAt: null,
		startedAt: "2026-09-02T00:00:00.200Z",
		completedAt: "2026-09-02T00:00:01.000Z",
		result: {
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"models":[]}',
		},
		errorCode: null,
		errorMessage: null,
		...overrides,
	};
}

test("stores only successful bounded allowlisted Alpha reads", () => {
	const projection = createAlphaReadProjection(
		command(),
		"2026-09-02T00:00:02.000Z",
	);
	assert.deepEqual(projection, {
		path: "/api/models?harness=cursor",
		result: {
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"models":[]}',
		},
		updatedAt: "2026-09-02T00:00:02.000Z",
	});
	assert.equal(
		alphaProjectionStorageKey(projection?.path ?? ""),
		"alpha-projection:/api/models?harness=cursor",
	);
	for (const invalid of [
		command({ status: "failed" }),
		command({
			request: {
				method: "PATCH",
				path: "/api/sessions/3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
				headers: {},
				body: '{}',
			},
		}),
		command({ request: { method: "GET", path: "/api/local-mode/auth", headers: {}, body: "" } }),
		command({ result: { status: 500, headers: {}, body: "failed" } }),
		command({ result: { status: 200, headers: {}, body: "x".repeat(ALPHA_PROJECTION_MAX_BODY_BYTES + 1) } }),
	]) {
		assert.equal(createAlphaReadProjection(invalid), null);
	}
});
