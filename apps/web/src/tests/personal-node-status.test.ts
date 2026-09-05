import assert from "node:assert/strict";
import test from "node:test";

import {
	parsePersonalNodeStatusSnapshot,
	personalNodeStatusNotice,
} from "$lib/personal-node-status";

test("shows Connector recovery progress instead of a generic offline message", () => {
	assert.deepEqual(
		personalNodeStatusNotice({
			connected: false,
			connector: {
				state: "recovering",
				message: "postgres stopped unexpectedly",
				attempt: 2,
				maxAttempts: 5,
				appVersion: "0.2.0-alpha.1",
				updatedAt: "2026-09-03T10:00:00.000Z",
			},
		}),
		{
			kind: "progress",
			text: "Recovering local services (2/5): postgres stopped unexpectedly",
		},
	);
});

test("shows terminal Connector errors and deliberate exit", () => {
	assert.deepEqual(
		personalNodeStatusNotice({
			connected: false,
			connector: {
				state: "error",
				message: "postgres failed after 5 attempts",
				attempt: null,
				maxAttempts: null,
				appVersion: "0.2.0-alpha.1",
				updatedAt: "2026-09-03T10:00:00.000Z",
			},
		}),
		{ kind: "error", text: "postgres failed after 5 attempts" },
	);
	assert.deepEqual(
		personalNodeStatusNotice({
			connected: false,
			connector: {
				state: "stopped",
				message: null,
				attempt: null,
				maxAttempts: null,
				appVersion: "0.2.0-alpha.1",
				updatedAt: "2026-09-03T10:00:00.000Z",
			},
		}),
		{ kind: "error", text: "Cohub Connector was quit on this Mac." },
	);
});

test("healthy nodes stay quiet and unknown offline nodes remain explicit", () => {
	assert.equal(
		personalNodeStatusNotice({ connected: true, connector: null }),
		null,
	);
	assert.deepEqual(
		personalNodeStatusNotice({ connected: false, connector: null }),
		{ kind: "error", text: "Local Mac is offline." },
	);
});

test("rejects corrupt Connector status instead of disguising it as offline", () => {
	assert.throws(
		() =>
			parsePersonalNodeStatusSnapshot({
				connected: false,
				connector: { state: "recovering", message: 17 },
			}),
		/Connector status response is invalid/,
	);
});
