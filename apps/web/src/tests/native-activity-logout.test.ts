import assert from "node:assert/strict";
import test from "node:test";
import {
	registerAuthInvalidationCleanup,
	runAuthInvalidationCleanup,
} from "$lib/native-activity/auth-invalidation";

test("concurrent auth invalidation shares one native cleanup", async () => {
	let calls = 0;
	let release!: () => void;
	const unregister = registerAuthInvalidationCleanup(async () => {
		calls += 1;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	const first = runAuthInvalidationCleanup();
	await Promise.resolve();
	const second = runAuthInvalidationCleanup();
	assert.equal(first, second);
	assert.equal(calls, 1);
	release();
	await Promise.all([first, second]);
	unregister();
});

test("failed auth cleanup can be retried without a stale in-flight lock", async () => {
	let calls = 0;
	const unregister = registerAuthInvalidationCleanup(async () => {
		calls += 1;
		if (calls === 1) throw new Error("reset failed");
	});
	await assert.rejects(runAuthInvalidationCleanup(), /reset failed/);
	await runAuthInvalidationCleanup();
	assert.equal(calls, 2);
	unregister();
});
