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

test("a ready message waits for owner persistence before authentication", async () => {
	const child = fakeChild();
	let finishOwner!: () => void;
	let verified = false;
	const owner = new Promise<void>((resolve) => { finishOwner = resolve; });
	const startup = waitForRuntimeStartup({
		child, instanceId: "instance-1", prepare: () => owner,
		verifyReady: () => { verified = true; return true; },
		cleanup: async () => {}, timeoutMs: 1_000,
	});
	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });
	await new Promise((resolve) => setImmediate(resolve));
	const verifiedBeforeOwner = verified;
	finishOwner();
	await startup;
	assert.equal(verifiedBeforeOwner, false);
	assert.equal(verified, true);
});

test("owner persistence failure cleans the child without waiting for ready", async () => {
	const child = fakeChild();
	let cleaned = false;
	await assert.rejects(waitForRuntimeStartup({
		child, instanceId: "instance-1", prepare: async () => { throw new Error("Owner write failed"); },
		verifyReady: () => true, cleanup: async () => { cleaned = true; }, timeoutMs: 30,
	}), /Owner write failed/);
	assert.equal(cleaned, true);
});

test("cancellation waits for a pending owner write before cleanup", async () => {
	const child = fakeChild();
	const controller = new AbortController();
	let finishOwner!: () => void;
	let ownerWritten = false;
	let cleanedAfterOwner = false;
	const owner = new Promise<void>((resolve) => { finishOwner = () => { ownerWritten = true; resolve(); }; });
	const startup = waitForRuntimeStartup({
		child, instanceId: "instance-1", prepare: () => owner, signal: controller.signal,
		verifyReady: () => true, cleanup: async () => { cleanedAfterOwner = ownerWritten; }, timeoutMs: 1_000,
	});
	await new Promise((resolve) => setImmediate(resolve));
	const rejected = assert.rejects(startup, /Stopped during owner write/);
	controller.abort(new Error("Stopped during owner write"));
	finishOwner();
	await rejected;
	assert.equal(cleanedAfterOwner, true);
});

test("cancellation cleans the runtime and rejects a late authenticated ready", async () => {
	const child = fakeChild();
	const controller = new AbortController();
	let cleanupCalls = 0;
	let readyCalls = 0;
	const startup = waitForRuntimeStartup({
		child, instanceId: "instance-1", signal: controller.signal,
		verifyReady: () => true,
		cleanup: async () => { cleanupCalls += 1; },
		onReady: () => { readyCalls += 1; },
		timeoutMs: 100,
	});
	controller.abort(new Error("Startup stopped"));
	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });
	await assert.rejects(startup, /Startup stopped/);
	assert.equal(cleanupCalls, 1);
	assert.equal(readyCalls, 0);
});

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
	const verificationStarted = Promise.withResolvers<void>();
	let cleanupCalls = 0;
	const startup = waitForRuntimeStartup({
		child,
		instanceId: "instance-1",
		verifyReady: () => new Promise<boolean>((resolve) => {
			resolveVerification = resolve;
			verificationStarted.resolve();
		}),
		cleanup: async () => {
			cleanupCalls += 1;
		},
		timeoutMs: 100,
	});

	const rejected = assert.rejects(startup, /stopped/);
	child.emit("message", { type: "runtime-ready", instanceId: "instance-1" });
	await verificationStarted.promise;
	child.emit("exit", 1, null);
	resolveVerification(true);

	await rejected;
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
