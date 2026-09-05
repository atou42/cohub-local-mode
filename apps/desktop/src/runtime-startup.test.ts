import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import { waitForRuntimeStartup, type RuntimeStartupChild } from "./runtime-startup.ts";

class FakeRuntimeChild extends EventEmitter implements RuntimeStartupChild {
	readonly pid = 42;
	exitCode: number | null = null;
}

function fakeChild() {
	return new FakeRuntimeChild();
}

test("identity failure is cleaned once and ignores a late ready message", async () => {
	const child = fakeChild();
	let verifyCalls = 0;
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => {
			verifyCalls += 1;
			return verifyCalls > 1;
		},
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 100,
	});

	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });
	await assert.rejects(startup, /identity check failed/);
	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });

	assert.equal(cleanupCalls, 1);
	assert.equal(verifyCalls, 1);
});

test("a ready verification that finishes after exit cannot succeed", async () => {
	const child = fakeChild();
	let resolveVerification!: (ready: boolean) => void;
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: () => new Promise<boolean>((resolve) => {
			resolveVerification = resolve;
		}),
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 100,
	});

	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });
	await new Promise((resolve) => setImmediate(resolve));
	child.emit("exit", 1, null);
	resolveVerification(true);

	await assert.rejects(startup, /stopped/);
	assert.equal(cleanupCalls, 1);
});

test("only a verified matching instance becomes ready", async () => {
	const child = fakeChild();
	let verifyCalls = 0;
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => {
			verifyCalls += 1;
			return true;
		},
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 100,
	});

	child.emit("message", { type: "runtime-ready", instanceId: "other" });
	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });

	await startup;
	assert.equal(verifyCalls, 1);
	assert.equal(cleanupCalls, 0);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(cleanupCalls, 0);
});

test("timeout performs cleanup before rejecting", async () => {
	const child = fakeChild();
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => true,
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 10,
	});

	await assert.rejects(startup, /within 10 milliseconds/);
	assert.equal(cleanupCalls, 1);
});

test("early exit performs cleanup and reports the exit", async () => {
	const child = fakeChild();
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => true,
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 100,
	});

	child.emit("exit", 7, null);
	await assert.rejects(startup, /stopped \(7\)/);
	assert.equal(cleanupCalls, 1);
});

test("child startup error performs cleanup and reports the error", async () => {
	const child = fakeChild();
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => true,
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 100,
	});

	child.emit("error", new Error("spawn failed"));
	await assert.rejects(startup, /spawn failed/);
	assert.equal(cleanupCalls, 1);
});

test("cleanup failure is exposed instead of being swallowed", async () => {
	const child = fakeChild();
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => false,
		cleanup: async () => {
			throw new Error("termination failed");
		},
		timeoutMs: 100,
	});

	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });
	await assert.rejects(startup, /termination failed/);
});

test("a real temporary Node child is terminated after timeout cleanup", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	assert.ok(child.pid);
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: async () => true,
		cleanup: async () => {
			if (child.exitCode !== null) return;
			process.kill(-child.pid!, "SIGTERM");
			await once(child, "exit");
		},
		timeoutMs: 50,
	});

	await assert.rejects(startup, /within 50 milliseconds/);
	assert.equal(child.signalCode, "SIGTERM");
});
