import assert from "node:assert/strict";
import test from "node:test";
import {
	decideCancel,
	decideExpiredCommand,
	guardResultSize,
	RESULT_MAX_JSON_BYTES,
	selectOldestKeysForGc,
	selectSnapshotCommands,
	selectSnapshotEvents,
	selectTerminalCommandsForGc,
} from "./lifecycle.ts";
import type { RelayCommand } from "./protocol.ts";

function command(overrides: Partial<RelayCommand> = {}): RelayCommand {
	return {
		id: overrides.id ?? "command-1",
		nodeId: "mac-mini",
		sequence: overrides.sequence ?? 1,
		idempotencyKey: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
		request: {
			method: "POST",
			path: "/api/spaces/2f4cb274-7f80-4a4b-b326-22d4af6a9873/prompt",
			headers: {},
			body: "{}",
		},
		attachments: [],
		status: overrides.status ?? "queued",
		attempt: overrides.attempt ?? 0,
		acceptedAt: "2026-08-26T00:00:00.000Z",
		updatedAt: "2026-08-26T00:00:00.000Z",
		claimedAt: null,
		leaseExpiresAt: overrides.leaseExpiresAt ?? null,
		startedAt: null,
		completedAt: overrides.completedAt ?? null,
		result: null,
		errorCode: null,
		errorMessage: null,
		...overrides,
	};
}

test("requeues an expired lease under the attempt cap", () => {
	assert.deepEqual(
		decideExpiredCommand(
			command({
				status: "running",
				attempt: 4,
				leaseExpiresAt: "2026-08-26T00:00:00.000Z",
			}),
			Date.parse("2026-08-26T00:00:01.000Z"),
		),
		{ action: "requeue" },
	);
});

test("fails a command after five expired attempts instead of requeueing", () => {
	const decision = decideExpiredCommand(
		command({
			status: "claimed",
			attempt: 5,
			leaseExpiresAt: "2026-08-26T00:01:00.000Z",
		}),
		Date.parse("2026-08-26T00:02:00.000Z"),
	);
	assert.equal(decision.action, "fail");
	if (decision.action !== "fail") throw new Error("expected fail");
	assert.equal(decision.errorCode, "max_attempts_exceeded");
	assert.match(decision.errorMessage, /5 attempts/);
	assert.match(decision.errorMessage, /2026-08-26T00:01:00.000Z/);
});

test("keeps an active lease that has not expired", () => {
	assert.deepEqual(
		decideExpiredCommand(
			command({
				status: "running",
				attempt: 5,
				leaseExpiresAt: "2026-08-26T00:02:00.000Z",
			}),
			Date.parse("2026-08-26T00:01:00.000Z"),
		),
		{ action: "keep" },
	);
});

test("strips an oversized result body while preserving status", () => {
	const result = guardResultSize(
		{
			status: 202,
			headers: { "content-type": "application/json" },
			body: "x".repeat(RESULT_MAX_JSON_BYTES),
		},
		RESULT_MAX_JSON_BYTES,
	);
	assert.equal(result.status, 202);
	assert.equal(result.headers["content-type"], "application/json");
	const payload = JSON.parse(result.body);
	assert.equal(payload.relayTruncated, true);
	assert.equal(typeof payload.originalBytes, "number");
	assert.ok(payload.originalBytes > RESULT_MAX_JSON_BYTES);
});

test("measures the result guard in UTF-8 bytes, not string length", () => {
	const body = "汉".repeat(100);
	const encoded = JSON.stringify({ status: 200, headers: {}, body });
	assert.ok(encoded.length <= 200);
	const result = guardResultSize({ status: 200, headers: {}, body }, 200);
	const payload = JSON.parse(result.body);
	assert.equal(payload.relayTruncated, true);
	assert.ok(payload.originalBytes > 200);
});

test("leaves a small result untouched", () => {
	const result = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: "{}",
	};
	assert.deepEqual(guardResultSize(result), result);
});

test("cancel state machine covers queued, active, and terminal commands", () => {
	assert.deepEqual(decideCancel(command({ status: "queued" })), {
		action: "cancel",
	});
	assert.deepEqual(decideCancel(command({ status: "claimed" })), {
		action: "conflict",
		code: "command_active",
	});
	assert.deepEqual(decideCancel(command({ status: "running" })), {
		action: "conflict",
		code: "command_active",
	});
	assert.deepEqual(decideCancel(command({ status: "succeeded" })), {
		action: "noop",
	});
	assert.deepEqual(decideCancel(command({ status: "failed" })), {
		action: "noop",
	});
	assert.deepEqual(decideCancel(command({ status: "cancelled" })), {
		action: "noop",
	});
});

test("GC drops terminal commands older than 7 days or beyond the newest 200", () => {
	const nowMs = Date.parse("2026-08-26T00:00:00.000Z");
	const recent = command({
		id: "recent",
		sequence: 3,
		status: "succeeded",
		completedAt: "2026-08-25T00:00:00.000Z",
	});
	const overflow = command({
		id: "overflow",
		sequence: 1,
		status: "failed",
		completedAt: "2026-08-25T12:00:00.000Z",
	});
	const stale = command({
		id: "stale",
		sequence: 2,
		status: "cancelled",
		completedAt: "2026-08-18T23:59:59.000Z",
	});
	const active = command({
		id: "active",
		sequence: 4,
		status: "queued",
	});
	const deleted = selectTerminalCommandsForGc(
		[recent, overflow, stale, active],
		nowMs,
		{ maxKeep: 1, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
	);
	assert.deepEqual(
		deleted.map((item) => item.id).sort(),
		["overflow", "stale"],
	);
});

test("GC keeps the newest keys when a prefix list overflows", () => {
	assert.deepEqual(selectOldestKeysForGc(["a", "b", "c", "d"], 2), ["a", "b"]);
	assert.deepEqual(selectOldestKeysForGc(["a", "b"], 2), []);
});

test("snapshot includes every active command plus the newest terminal ones", () => {
	const commands = [
		command({ id: "old-done", sequence: 1, status: "succeeded" }),
		command({ id: "queued", sequence: 2, status: "queued" }),
		command({ id: "newer-done", sequence: 3, status: "failed" }),
		command({ id: "running", sequence: 4, status: "running" }),
	];
	assert.deepEqual(
		selectSnapshotCommands(commands, 1).map((item) => item.id),
		["queued", "newer-done", "running"],
	);
});

test("snapshot events keep the newest stored items", () => {
	assert.deepEqual(selectSnapshotEvents([1, 2, 3, 4, 5], 3), [3, 4, 5]);
});
