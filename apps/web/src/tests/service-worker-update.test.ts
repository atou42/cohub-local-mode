import assert from "node:assert/strict";
import test from "node:test";
import {
	clearFailedDynamicImportRecovery,
	FAILED_DYNAMIC_IMPORT_STORAGE_KEY,
} from "../lib/asset-import-recovery.ts";
import {
	createThrottledWorkerUpdateCheck,
	registerCohubServiceWorker,
} from "../lib/service-worker-update.ts";

type Listener = () => void;

function eventTarget() {
	const listeners = new Map<string, Listener[]>();
	return {
		addEventListener(type: string, listener: Listener) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		emit(type: string) {
			for (const listener of listeners.get(type) ?? []) listener();
		},
	};
}

test("an existing Cohub client activates a waiting worker and reloads once", async () => {
	const containerEvents = eventTarget();
	const registrationEvents = eventTarget();
	const activationMessages: unknown[] = [];
	let updates = 0;
	let reloads = 0;
	const waiting = {
		postMessage(message: unknown) {
			activationMessages.push(message);
		},
	};
	const registration = {
		waiting,
		installing: null,
		addEventListener: registrationEvents.addEventListener,
		async update() {
			updates += 1;
		},
	};
	const registrations: Array<{
		scriptUrl: string;
		options?: RegistrationOptions;
	}> = [];
	const container = {
		controller: {},
		addEventListener: containerEvents.addEventListener,
		async register(scriptUrl: string, options?: RegistrationOptions) {
			registrations.push({ scriptUrl, options });
			return registration;
		},
	};

	await registerCohubServiceWorker({
		container: container as unknown as ServiceWorkerContainer,
		reload: () => {
			reloads += 1;
		},
	});
	containerEvents.emit("controllerchange");
	containerEvents.emit("controllerchange");

	assert.deepEqual(registrations, [
		{ scriptUrl: "/sw.js", options: { updateViaCache: "none" } },
	]);
	assert.equal(updates, 1);
	assert.deepEqual(activationMessages, [{ type: "SKIP_WAITING" }]);
	assert.equal(reloads, 1);
});

test("a first service-worker install does not reload an uncontrolled page", async () => {
	const containerEvents = eventTarget();
	let reloads = 0;
	const container = {
		controller: null,
		addEventListener: containerEvents.addEventListener,
		async register() {
			return {
				waiting: null,
				installing: null,
				addEventListener() {},
				async update() {},
			};
		},
	};

	await registerCohubServiceWorker({
		container: container as unknown as ServiceWorkerContainer,
		reload: () => {
			reloads += 1;
		},
	});
	containerEvents.emit("controllerchange");

	assert.equal(reloads, 0);
});

test("a worker that finishes installing is asked to activate", async () => {
	const containerEvents = eventTarget();
	const registrationEvents = eventTarget();
	const installingEvents = eventTarget();
	const activationMessages: unknown[] = [];
	const installing = {
		state: "installing",
		addEventListener: installingEvents.addEventListener,
	};
	const waiting = {
		postMessage(message: unknown) {
			activationMessages.push(message);
		},
	};
	const registration = {
		waiting: null as typeof waiting | null,
		installing,
		addEventListener: registrationEvents.addEventListener,
		async update() {},
	};
	const container = {
		controller: {},
		addEventListener: containerEvents.addEventListener,
		async register() {
			return registration;
		},
	};

	await registerCohubServiceWorker({
		container: container as unknown as ServiceWorkerContainer,
		reload() {},
	});
	registrationEvents.emit("updatefound");
	registration.waiting = waiting;
	installing.state = "installed";
	installingEvents.emit("statechange");

	assert.deepEqual(activationMessages, [{ type: "SKIP_WAITING" }]);
});

test("service-worker update failures remain visible to the caller", async () => {
	const container = {
		controller: {},
		addEventListener() {},
		async register() {
			throw new Error("offline during service-worker update");
		},
	};

	await assert.rejects(
		registerCohubServiceWorker({
			container: container as unknown as ServiceWorkerContainer,
			reload() {},
		}),
		/offline during service-worker update/,
	);
});

test("successful recovery clears only the stale-import retry marker", () => {
	const values = new Map([
		[FAILED_DYNAMIC_IMPORT_STORAGE_KEY, "/_app/immutable/nodes/stale.js"],
		["cohub_token", "keep-auth"],
		["cohub:draft", "keep-draft"],
	]);

	clearFailedDynamicImportRecovery({
		removeItem(key: string) {
			values.delete(key);
		},
	});

	assert.deepEqual(
		[...values],
		[
			["cohub_token", "keep-auth"],
			["cohub:draft", "keep-draft"],
		],
	);
});

test("worker checks triggered by lifecycle events are throttled", async () => {
	let now = 1_000;
	let checks = 0;
	const check = createThrottledWorkerUpdateCheck({
		check: async () => {
			checks += 1;
		},
		now: () => now,
		minimumIntervalMs: 30_000,
	});

	check();
	check();
	await Promise.resolve();
	assert.equal(checks, 1);

	now += 30_000;
	check();
	await Promise.resolve();
	assert.equal(checks, 2);
});
