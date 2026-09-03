import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalNodeProgressPoller } from "../lib/features/session-chat/personal-node-progress-poll.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

test("polls one active Personal Node session without overlapping requests", async () => {
	const first = deferred();
	const calls: string[] = [];
	const errors: unknown[] = [];
	let intervalCallback: (() => void) | null = null;
	let cleared = 0;
	const fireInterval = () => {
		const callback = intervalCallback;
		assert.ok(callback);
		callback();
	};
	const poller = createPersonalNodeProgressPoller({
		poll: async (key) => {
			calls.push(key);
			if (calls.length === 1) await first.promise;
		},
		onError: (error) => errors.push(error),
		setIntervalFn: (callback) => {
			intervalCallback = callback;
			return 1;
		},
		clearIntervalFn: () => {
			cleared += 1;
		},
	});

	poller.sync("space\0session");
	await Promise.resolve();
	assert.deepEqual(calls, ["space\0session"]);
	fireInterval();
	await Promise.resolve();
	assert.equal(calls.length, 1);

	first.resolve();
	await first.promise;
	await Promise.resolve();
	fireInterval();
	await Promise.resolve();
	assert.deepEqual(calls, ["space\0session", "space\0session"]);

	poller.sync(null);
	assert.equal(cleared, 1);
	assert.deepEqual(errors, []);
});

test("reports a failed poll and keeps the next interval available", async () => {
	const expected = new Error("relay read failed");
	const errors: unknown[] = [];
	let calls = 0;
	let intervalCallback: (() => void) | null = null;
	const fireInterval = () => {
		const callback = intervalCallback;
		assert.ok(callback);
		callback();
	};
	const poller = createPersonalNodeProgressPoller({
		poll: async () => {
			calls += 1;
			if (calls === 1) throw expected;
		},
		onError: (error) => errors.push(error),
		setIntervalFn: (callback) => {
			intervalCallback = callback;
			return 1;
		},
		clearIntervalFn: () => undefined,
	});

	poller.sync("space\0session");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(errors, [expected]);
	fireInterval();
	await Promise.resolve();
	assert.equal(calls, 2);

	poller.dispose();
	fireInterval();
	await Promise.resolve();
	assert.equal(calls, 2);
});
