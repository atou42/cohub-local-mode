import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { transformSync } from "esbuild";
import { personalNodeId } from "./connector-core.ts";

const require = createRequire(import.meta.url);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const state = { version: 2, installationId: "installation", accountId: "a".repeat(64), deviceId: "device" };

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

class Child extends EventEmitter {
	pid: number | undefined;
	exitCode: number | null = null;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	constructor(pid: number) { super(); this.pid = pid; }
	kill(_signal?: NodeJS.Signals) {
		this.killed = true;
		queueMicrotask(() => { this.exitCode = 0; this.emit("exit", 0); this.emit("close", 0); });
		return true;
	}
}

function harness(realRelay = false) {
	const windows: any[] = [];
	const children: Array<{ child: Child; env: NodeJS.ProcessEnv }> = [];
	const timers = new Map<object, { fn: () => void; ms: number }>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let spawnError: Error | null = null;
	const app = Object.assign(new EventEmitter(), {
		setName() {}, setPath() {}, getPath: () => "/isolated-desktop-test",
		getAppPath: () => resolve(sourceDirectory, ".."), isPackaged: false,
		requestSingleInstanceLock: () => true,
		whenReady: () => new Promise(() => {}), quit() {},
		getLoginItemSettings: () => ({ openAtLogin: false }),
	});
	class Window extends EventEmitter {
		destroyed = false;
		visible = true;
		url = "";
		loads: string[] = [];
		webContents = Object.assign(new EventEmitter(), {
			session: { webRequest: { onBeforeSendHeaders() {} } },
			mainFrame: {}, setWindowOpenHandler() {}, send() {},
			getURL: () => this.url,
		});
		constructor(_options: unknown) { super(); windows.push(this); }
		isDestroyed() { return this.destroyed; }
		show() { this.visible = true; }
		focus() {}
		isMinimized() { return false; }
		restore() {}
		async loadURL(url: string) { this.url = url; this.loads.push(url); this.webContents.emit("did-finish-load"); }
		async loadFile(path: string) { return this.loadURL(`file://${path}`); }
		close() { this.destroyed = true; this.emit("closed"); }
	}
	const fakeRequire = (id: string) => {
		if (id === "electron") return {
			app, BrowserWindow: Window, ipcMain: { handle: (key: string, handler: (...args: any[]) => any) => handlers.set(key, handler) },
		};
		if (id === "node:fs/promises") return { ...require(id), access: async () => {} };
		if (id === "node:child_process") return { ...require(id), spawn: (_exe: string, _args: string[], options: any) => {
			if (realRelay) {
				const child = require(id).spawn(process.execPath, ["-e", `
					const status = () => process.send({ type: "relay-status", nodeId: process.env.COHUB_LOCAL_RELAY_NODE_ID, pid: process.pid, state: "connected" });
					status();
					process.on("SIGTERM", () => { status(); setTimeout(() => process.exit(0), 20); });
					setInterval(() => {}, 1000);
				`], options);
				children.push({ child, env: options.env });
				return child;
			}
			const child = new Child(900_000 + children.length);
			children.push({ child, env: options.env });
			const error = spawnError;
			spawnError = null;
			if (error) child.pid = undefined;
			queueMicrotask(() => {
				if (error) { child.emit("error", error); child.emit("close", -1); }
				else child.emit("spawn");
			});
			return child;
		} };
		if (id.startsWith("./")) return require(resolve(sourceDirectory, id.replace(/\.js$/, ".ts")));
		return require(id);
	};
	const compiled = transformSync(readFileSync(resolve(sourceDirectory, "main.ts"), "utf8"), {
		loader: "ts", format: "cjs", target: "es2022",
	}).code;
	// Run the real main-process functions with only OS, Electron and identity I/O replaced.
	const expose = `
		const stopOwnedRuntimeWithOs = stopOwnedRuntime;
		const osProcessGroupAlive = processGroupAlive;
		const osTerminateProcessGroup = terminateProcessGroup;
		readState = async () => suppliedState;
		readCredential = async () => "test-credential";
		stopOwnedRuntime = async () => {};
		cleanupLegacyRuntime = async () => {};
		resolveRuntimeScript = async () => "/isolated/manager.mjs";
		writeRuntimeOwner = async () => {};
		clearRuntimeOwner = async () => {};
		processGroupAlive = () => false;
		terminateProcessGroup = async (pid) => { const entry = children.find(entry => entry.child.pid === pid); entry?.child.kill(); };
		localApiReady = async () => true;
		logMessage = () => {};
		queueRemoteStatus = () => {};
		return {
			openLocalCohub, startRuntime, startRelay, stopRelay, stopRuntime, ensureRuntimeAndRelay, prepareLocalAccountChange,
			reconnectConnector, quitConnector, publishStatus, publishConnectorError, scheduleRuntimeRecovery,
			stopOwnedRuntimeWithOs,
			useRealOwnership: (owner) => {
				readRuntimeOwner = async () => owner;
				processGroupAlive = osProcessGroupAlive;
				terminateProcessGroup = osTerminateProcessGroup;
				delay = (ms) => new Promise(resolve => require("node:timers").setTimeout(resolve, ms));
			},
			status: () => currentStatus,
			identity: () => runtimeIdentity,
			setReady: (identity) => { runtimeIdentity = identity; localRuntimeReady = true; },
			blockCredentials: (promise) => { readCredential = () => promise; },
			blockRuntime: (promise) => { startRuntime = () => promise; },
			blockRegistration: (promise) => { registrationPromise = promise; },
			setStoredState: (value) => { readState = async () => value; },
		};`;
	const connector = new Function("require", "exports", "setTimeout", "clearTimeout", "children", "suppliedState", compiled + expose)(
		fakeRequire, {},
		(fn: () => void, ms: number) => { const handle = {}; timers.set(handle, { fn, ms }); return handle; },
		(handle: object) => timers.delete(handle), children, state,
	);
	return { connector, windows, children, app, handlers, timers,
		failNextSpawn(error: Error) { spawnError = error; },
		fireTimer(ms: number) {
			const found = [...timers].find(([, timer]) => timer.ms === ms);
			assert.ok(found, `timer ${ms} must exist`);
			timers.delete(found[0]); found[1].fn();
		},
	};
}

test("the window appears before backend startup resolves or fails", async () => {
	const h = harness();
	const startup = deferred();
	h.connector.blockRuntime(startup.promise);
	const opening = h.connector.openLocalCohub().catch(() => {});
	await flush();
	const countBeforeReady = h.windows.length;
	startup.reject(new Error("backend unavailable"));
	await opening;
	assert.equal(countBeforeReady, 1);
	assert.equal(h.windows[0].visible, true);
});

test("stopping during a pending credential read prevents a late relay spawn", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "first-secret" });
	const credentials = deferred<string>();
	h.connector.blockCredentials(credentials.promise);
	const starting = h.connector.startRelay(state).catch(() => {});
	await flush();
	const stopping = h.connector.stopRelay();
	credentials.resolve("credential");
	await Promise.all([starting, stopping]);
	assert.equal(h.children.length, 0);
});

test("old relay IPC cannot overwrite stopped status", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "first-secret" });
	await h.connector.startRelay(state, "credential");
	const { child, env } = h.children[0];
	const stopping = h.connector.stopRelay();
	h.connector.publishStatus({ state: "stopped", deviceId: state.deviceId, message: null });
	child.emit("message", { type: "relay-status", nodeId: env.COHUB_LOCAL_RELAY_NODE_ID, pid: child.pid, state: "connected" });
	await stopping;
	assert.equal(h.connector.status().state, "stopped");
});

test("changing runtime identity replaces a living relay before reuse", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "first-secret" });
	await h.connector.startRelay(state, "credential");
	h.connector.setReady({ id: "second", secret: "second-secret" });
	await h.connector.startRelay(state, "credential");
	assert.equal(h.children.length, 2);
	assert.equal(h.children[0].child.killed, true);
	assert.equal(h.children[1].env.COHUB_DESKTOP_INSTANCE_SECRET, "second-secret");
});

test("changing the registered account replaces its relay even when the runtime is unchanged", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "first-secret" });
	await h.connector.startRelay(state, "first-credential");
	const next = { ...state, accountId: "b".repeat(64), deviceId: "next-device" };
	await h.connector.startRelay(next, "next-credential");
	assert.equal(h.children.length, 2);
	assert.equal(h.children[0].child.killed, true);
	assert.equal(h.children[1].env.COHUB_LOCAL_RELAY_NODE_ID, personalNodeId(next));
});

test("account replacement stops the old relay and invalidates the local instance before returning", async () => {
	const h = harness();
	h.connector.setReady({ id: "old-instance", secret: "old-secret" });
	await h.connector.openLocalCohub();
	await h.connector.startRelay(state, "credential");
	const next = { ...state, accountId: "b".repeat(64), deviceId: "new-device" };
	await h.connector.prepareLocalAccountChange(state, next);
	assert.equal(h.children[0].child.exitCode, 0);
	assert.equal(h.connector.identity(), null);
	assert.equal(h.windows.length, 1);
	assert.match(h.windows[0].url, /^data:/);
});

test("an unchanged account does not unnecessarily restart its local runtime", async () => {
	const h = harness();
	const identity = { id: "same-instance", secret: "same-secret" };
	h.connector.setReady(identity);
	await h.connector.startRelay(state, "credential");
	await h.connector.prepareLocalAccountChange(state, { ...state });
	assert.equal(h.children[0].child.killed, false);
	assert.equal(h.connector.identity(), identity);
	await h.connector.stopRelay();
});

test("runtime opening waits until an account registration finishes", async () => {
	const h = harness();
	h.connector.setReady({ id: "instance", secret: "secret" });
	const registration = deferred();
	h.connector.blockRegistration(registration.promise);
	let completed = false;
	const opening = h.connector.startRuntime().then(() => { completed = true; });
	await flush();
	assert.equal(completed, false);
	registration.resolve();
	await opening;
	assert.equal(completed, true);
});

test("automatic runtime recovery opens the existing window with a fresh relay", async () => {
	const h = harness();
	const startup = h.connector.ensureRuntimeAndRelay(state);
	const opening = h.connector.openLocalCohub().catch(h.connector.publishConnectorError);
	await flush();
	assert.equal(h.windows.length, 1);
	assert.equal(h.children.length, 1);
	h.children[0].child.exitCode = 7;
	h.children[0].child.emit("exit", 7, null);
	await Promise.all([startup, opening]);
	assert.equal(h.connector.status().state, "recovering");
	h.fireTimer(1_000);
	await flush();
	const runtime = h.children[1];
	assert.ok(runtime.env.COHUB_DESKTOP_INSTANCE_ID);
	runtime.child.emit("message", { type: "runtime-ready", instanceId: runtime.env.COHUB_DESKTOP_INSTANCE_ID });
	await flush();
	assert.equal(h.windows.length, 1);
	assert.match(h.windows[0].url, /\/sessions$/);
	assert.equal(h.children.length, 3);
	assert.equal(h.children[2].env.COHUB_DESKTOP_INSTANCE_SECRET, runtime.env.COHUB_DESKTOP_INSTANCE_SECRET);
	await h.connector.stopRelay();
	await h.connector.stopRuntime();
});

test("a delayed window-open failure cannot overwrite automatic recovery", async () => {
	const h = harness();
	const startup = deferred();
	const error = new Error("Runtime startup failed");
	h.connector.blockRuntime(startup.promise);
	const opening = h.connector.openLocalCohub().catch(h.connector.publishConnectorError);
	await flush();
	await h.connector.scheduleRuntimeRecovery(error);
	assert.equal(h.connector.status().state, "recovering");
	startup.reject(error);
	await opening;
	assert.equal(h.connector.status().state, "recovering");
});

test("closing the window does not stop services or reopen it on readiness", async () => {
	const h = harness();
	const starting = h.connector.openLocalCohub();
	await flush();
	h.windows[0].close();
	const runtime = h.children[0];
	runtime.child.emit("message", { type: "runtime-ready", instanceId: runtime.env.COHUB_DESKTOP_INSTANCE_ID });
	await starting;
	assert.equal(runtime.child.killed, false);
	assert.equal(h.windows.length, 1);
	await h.connector.openLocalCohub();
	assert.equal(h.windows.length, 2);
	assert.match(h.windows[1].url, /\/sessions$/);
	await h.connector.stopRuntime();
});

test("privileged startup actions reject other pages and subframes", async () => {
	const h = harness();
	const waiting = deferred();
	h.connector.blockRuntime(waiting.promise);
	const opening = h.connector.openLocalCohub();
	await flush();
	const window = h.windows[0];
	const frame = window.webContents.mainFrame;
	frame.url = window.url;
	const status = h.handlers.get("cohub-desktop:status")!;
	assert.equal(status({ sender: window.webContents, senderFrame: frame }).state, "signed-out");
	assert.throws(() => status({ sender: window.webContents, senderFrame: { url: window.url } }), /local Cohub window/);
	frame.url = "data:text/html,not-the-startup-page";
	assert.throws(() => status({ sender: window.webContents, senderFrame: frame }), /local Cohub window/);
	frame.url = "https://dev2-cohub.atou.cc/sessions";
	assert.throws(() => status({ sender: window.webContents, senderFrame: frame }), /local Cohub window/);
	waiting.resolve();
	await opening;
});

test("quit cannot resume a connector that was blocked on credentials", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "secret" });
	const credentials = deferred<string>();
	h.connector.blockCredentials(credentials.promise);
	const starting = h.connector.ensureRuntimeAndRelay(state);
	await flush();
	const quitting = h.connector.quitConnector();
	credentials.resolve("credential");
	await Promise.all([quitting, starting]);
	assert.equal(h.children.length, 0);
	assert.equal(h.connector.status().state, "stopped");
	assert.equal(h.timers.size, 0);
});

test("a relay that cannot stop retains ownership and blocks its replacement", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "secret" });
	await h.connector.startRelay(state, "credential");
	const child = h.children[0].child;
	child.kill = () => true;
	const stopped = assert.rejects(h.connector.stopRelay(), /did not exit/);
	h.fireTimer(5_000);
	h.fireTimer(5_000);
	await stopped;
	const restarting = h.connector.startRelay(state, "credential");
	await flush();
	const countBeforeExit = h.children.length;
	child.exitCode = 0;
	child.emit("exit", 0);
	child.emit("close", 0);
	await restarting;
	assert.equal(countBeforeExit, 1);
	assert.equal(h.children.length, 2);
	await h.connector.stopRelay();
});

test("a relay spawn error rejects startup without keeping an unusable child", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "secret" });
	h.failNextSpawn(new Error("spawn EAGAIN"));
	await assert.rejects(h.connector.startRelay(state, "credential"), /EAGAIN/);
	await h.connector.startRelay(state, "credential");
	assert.equal(h.children.length, 2);
	await h.connector.stopRelay();
});

test("automatic recovery reports a relay shutdown failure without replacing it", async () => {
	const h = harness();
	h.connector.setReady({ id: "first", secret: "secret" });
	await h.connector.startRelay(state, "credential");
	const child = h.children[0].child;
	child.kill = () => true;
	const recovering = h.connector.scheduleRuntimeRecovery(new Error("Runtime exited"));
	h.fireTimer(5_000);
	h.fireTimer(5_000);
	await recovering;
	assert.equal(h.connector.status().state, "error");
	assert.match(h.connector.status().message, /Relay process did not exit/);
	assert.equal(h.children.length, 1);
	assert.equal(h.timers.size, 0);
});

test("exhausted automatic recovery can retry once despite repeated Retry requests", async () => {
	const h = harness();
	const initial = h.connector.ensureRuntimeAndRelay(state);
	await flush();
	const failLatest = async () => {
		const child = h.children.at(-1)!.child;
		child.exitCode = 7;
		child.emit("exit", 7, null);
		await flush();
	};
	await failLatest();
	await initial;
	for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
		h.fireTimer(delay);
		await flush();
		await failLatest();
	}
	assert.equal(h.connector.status().state, "error");
	assert.equal(h.children.length, 6);
	assert.equal(h.timers.size, 0);
	const retry = h.connector.reconnectConnector();
	const repeated = h.connector.reconnectConnector();
	await flush();
	assert.equal(h.children.length, 7);
	const runtime = h.children.at(-1)!;
	runtime.child.emit("message", { type: "runtime-ready", instanceId: runtime.env.COHUB_DESKTOP_INSTANCE_ID });
	await Promise.all([retry, repeated]);
	assert.equal(h.children.length, 8);
	await h.connector.stopRelay();
	await h.connector.stopRuntime();
});

test("an unsigned local installation can retry services without contacting sign-in", async () => {
	const h = harness();
	h.connector.setStoredState(null);
	const retrying = h.connector.reconnectConnector();
	await flush();
	assert.equal(h.children.length, 1);
	const runtime = h.children[0];
	runtime.child.emit("message", { type: "runtime-ready", instanceId: runtime.env.COHUB_DESKTOP_INSTANCE_ID });
	await retrying;
	assert.equal(h.children.length, 1);
	await h.connector.stopRuntime();
});

test("real relay children rotate with the runtime and cannot publish after stop", async () => {
	const h = harness(true);
	try {
		h.connector.setReady({ id: "first", secret: "first-secret" });
		await h.connector.startRelay(state, "credential");
		const deadline = Date.now() + 5_000;
		while (h.connector.status().state !== "connected" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(h.connector.status().state, "connected");
		const first = h.children[0].child;
		h.connector.setReady({ id: "second", secret: "second-secret" });
		await h.connector.startRelay(state, "credential");
		assert.throws(() => process.kill(first.pid!, 0), { code: "ESRCH" });
		assert.equal(h.children.length, 2);
		assert.equal(h.children[1].env.COHUB_DESKTOP_INSTANCE_SECRET, "second-secret");
		const second = h.children[1].child;
		const stopping = h.connector.stopRelay();
		h.connector.publishStatus({ state: "stopped", deviceId: state.deviceId, message: null });
		await stopping;
		assert.equal(h.connector.status().state, "stopped");
		assert.throws(() => process.kill(second.pid!, 0), { code: "ESRCH" });
	} finally {
		for (const { child } of h.children) if (child.exitCode === null) child.kill("SIGKILL");
	}
});

test("recorded descendants can be stopped after their runtime group leader dies", async () => {
	const { spawn, execFileSync } = require("node:child_process");
	const parent = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		console.log(child.pid);
		setInterval(() => {}, 1000);
	`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
	try {
		const childPid = await new Promise<number>((resolve, reject) => {
			parent.once("error", reject);
			parent.stdout.once("data", (value: Buffer) => resolve(Number(value.toString().trim())));
		});
		assert.ok(Number.isInteger(childPid) && childPid > 1);
		const fingerprint = (pid: number) => execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim();
		const owner = {
			schemaVersion: 3, pid: parent.pid, startedAt: new Date().toISOString(),
			processFingerprint: fingerprint(parent.pid),
			members: [{ pid: childPid, processFingerprint: fingerprint(childPid) }],
		};
		parent.kill("SIGKILL");
		await exited;
		process.kill(childPid, 0);
		const h = harness();
		h.connector.useRealOwnership(owner);
		await h.connector.stopOwnedRuntimeWithOs();
		assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
	} finally {
		try { process.kill(-parent.pid, "SIGKILL"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		await exited;
	}
});
