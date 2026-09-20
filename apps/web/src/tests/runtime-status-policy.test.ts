import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createRuntimeStatusFreshness,
	RUNTIME_STATUS_DENIED_BACKOFF_MS,
	RUNTIME_STATUS_ERROR_BACKOFF_MS,
	RUNTIME_STATUS_MIN_INTERVAL_MS,
	RUNTIME_STATUS_UNAVAILABLE_BACKOFF_MS,
	runtimeStatusBackoffMs,
	shouldRequestRuntimeStatus,
} from "../lib/features/space/runtime-status-policy.ts";

test("a never-probed Space is requested immediately", () => {
	const state = createRuntimeStatusFreshness();
	assert.equal(shouldRequestRuntimeStatus(state, { now: 1_000 }), true);
});

test("a recent success collapses duplicate probes", () => {
	const state = createRuntimeStatusFreshness();
	state.lastSuccessAt = 10_000;
	assert.equal(
		shouldRequestRuntimeStatus(state, {
			now: 10_000 + RUNTIME_STATUS_MIN_INTERVAL_MS - 1,
		}),
		false,
	);
	assert.equal(
		shouldRequestRuntimeStatus(state, {
			now: 10_000 + RUNTIME_STATUS_MIN_INTERVAL_MS,
		}),
		true,
	);
});

test("an explicit force ignores freshness and backoff", () => {
	const state = createRuntimeStatusFreshness();
	state.lastSuccessAt = 10_000;
	state.retryAt = 60_000;
	assert.equal(
		shouldRequestRuntimeStatus(state, { now: 11_000, force: true }),
		true,
	);
});

test("an active backoff window suppresses probes", () => {
	const state = createRuntimeStatusFreshness();
	state.retryAt = 60_000;
	assert.equal(shouldRequestRuntimeStatus(state, { now: 59_999 }), false);
	assert.equal(shouldRequestRuntimeStatus(state, { now: 60_000 }), true);
});

test("missing routes back off far longer than transient failures", () => {
	assert.equal(
		runtimeStatusBackoffMs(404),
		RUNTIME_STATUS_UNAVAILABLE_BACKOFF_MS,
	);
	assert.equal(
		runtimeStatusBackoffMs(405),
		RUNTIME_STATUS_UNAVAILABLE_BACKOFF_MS,
	);
	assert.equal(runtimeStatusBackoffMs(403), RUNTIME_STATUS_DENIED_BACKOFF_MS);
	assert.equal(runtimeStatusBackoffMs(401), RUNTIME_STATUS_DENIED_BACKOFF_MS);
	assert.equal(runtimeStatusBackoffMs(500), RUNTIME_STATUS_ERROR_BACKOFF_MS);
	assert.equal(runtimeStatusBackoffMs(null), RUNTIME_STATUS_ERROR_BACKOFF_MS);
	assert.ok(
		RUNTIME_STATUS_UNAVAILABLE_BACKOFF_MS > RUNTIME_STATUS_DENIED_BACKOFF_MS,
	);
	assert.ok(RUNTIME_STATUS_DENIED_BACKOFF_MS > RUNTIME_STATUS_ERROR_BACKOFF_MS);
});
