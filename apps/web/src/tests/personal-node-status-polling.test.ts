import assert from "node:assert/strict";
import test from "node:test";
import { PersonalNodeControlError, startPersonalNodeStatusPolling } from "$lib/personal-node-status-polling";

class Visibility extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";
	change(state: DocumentVisibilityState) { this.visibilityState = state; this.dispatchEvent(new Event("visibilitychange")); }
}

const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };

test("node polling pauses while hidden, refreshes on return, and stops without leaked timers", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const visibility = new Visibility();
	visibility.change("hidden");
	let calls = 0;
	const monitor = startPersonalNodeStatusPolling({ visibility, refresh: async () => { calls++; }, onError: error => { throw error; } });
	t.after(monitor.stop);
	await monitor.ready;
	assert.equal(calls, 0);
	visibility.change("visible");
	await settle();
	assert.equal(calls, 1);
	t.mock.timers.tick(3_000);
	await settle();
	assert.equal(calls, 1);
	t.mock.timers.tick(12_000);
	await settle();
	assert.equal(calls, 2);
	visibility.change("hidden");
	t.mock.timers.tick(3_600_000);
	await settle();
	assert.equal(calls, 2);
	visibility.change("visible");
	await settle();
	assert.equal(calls, 3);
	monitor.stop();
	visibility.change("hidden");
	visibility.change("visible");
	t.mock.timers.tick(3_600_000);
	await settle();
	assert.equal(calls, 3);
});

test("visibility changes cannot bypass maintenance Retry-After", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const visibility = new Visibility();
	let calls = 0;
	let errors = 0;
	const monitor = startPersonalNodeStatusPolling({ visibility,
		refresh: async () => { calls++; if (calls === 1) throw new PersonalNodeControlError("HTTP 503", Date.now() + 3_600_000); },
		onError: () => { errors++; },
	});
	t.after(monitor.stop);
	await monitor.ready;
	for (let i = 0; i < 10; i++) { visibility.change("hidden"); visibility.change("visible"); }
	t.mock.timers.tick(3_599_999);
	await settle();
	assert.equal(calls, 1);
	assert.equal(errors, 1);
	t.mock.timers.tick(1);
	await settle();
	assert.equal(calls, 2);
});

test("a slow status refresh is shared and cannot restart polling after stop", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const visibility = new Visibility();
	let finish!: () => void;
	let calls = 0;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	const monitor = startPersonalNodeStatusPolling({ visibility, refresh: async () => { calls++; await pending; }, onError: error => { throw error; } });
	t.after(monitor.stop);
	await settle();
	visibility.change("hidden");
	visibility.change("visible");
	await settle();
	assert.equal(calls, 1);
	monitor.stop();
	finish();
	await monitor.ready;
	t.mock.timers.tick(3_600_000);
	await settle();
	assert.equal(calls, 1);
});

test("ordinary failures back off instead of maintaining a 3-second error loop", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const visibility = new Visibility();
	let calls = 0;
	const monitor = startPersonalNodeStatusPolling({ visibility, refresh: async () => { calls++; throw new Error("offline"); }, onError: () => {} });
	t.after(monitor.stop);
	await monitor.ready;
	for (const delay of [30_000, 60_000, 120_000, 120_000]) {
		const before = calls;
		t.mock.timers.tick(delay - 1);
		await settle();
		assert.equal(calls, before);
		t.mock.timers.tick(1);
		await settle();
		assert.equal(calls, before + 1);
	}
});
