import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { HarnessCapabilityCatalog } from "@neta-art/cohub";

const target = { spaceId: "local-space", harness: "codex" } as const;
type Target = typeof target;

function catalog(name: string): HarnessCapabilityCatalog {
	return {
		version: 1,
		harness: "codex",
		fetchedAt: "2026-09-05T00:00:00.000Z",
		commands: [
			{ name, description: name, category: "Codex", insertionText: `/${name} ` },
		],
		skills: [],
	};
}

function deferred() {
	let resolve!: (value: HarnessCapabilityCatalog) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<HarnessCapabilityCatalog>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

let cached: HarnessCapabilityCatalog | null = null;
let requests: ReturnType<typeof deferred>[] = [];
let writes: HarnessCapabilityCatalog[] = [];
const dependencies = {
	readCachedHarnessCapabilities: () => cached,
	writeCachedHarnessCapabilities: (
		_spaceId: string,
		value: HarnessCapabilityCatalog,
	) => writes.push(value),
	resolveSpaceOrigin: () => "local",
	sdkForSpaceOrigin: () => ({
		harnessCapabilities: {
			list: (_target: Target) => {
				const request = deferred();
				requests.push(request);
				return request.promise;
			},
		},
	}),
};

// Only replace this controller's external boundaries; import its real source.
const controllerUrl = new URL(
	"../lib/features/space/modules/harness-capability-controller.svelte.ts",
	import.meta.url,
);
const dependencyKey = Symbol.for("harness-capability-controller-test");
Reflect.set(globalThis, dependencyKey, dependencies);
const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (
			context.parentURL === controllerUrl.href &&
			["$lib/harness-capability-cache", "$lib/sdk", "$lib/space-origin"].includes(
				specifier,
			)
		) {
			return {
				url: `data:text/javascript,${encodeURIComponent(
					'export const { readCachedHarnessCapabilities, writeCachedHarnessCapabilities, resolveSpaceOrigin, sdkForSpaceOrigin } = globalThis[Symbol.for("harness-capability-controller-test")];',
				)}`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});
const { createHarnessCapabilityController } = await import(controllerUrl.href)
	.finally(() => {
		hooks.deregister();
		Reflect.deleteProperty(globalThis, dependencyKey);
	});

function createController() {
	cached = null;
	requests = [];
	writes = [];
	const previousState = Object.getOwnPropertyDescriptor(globalThis, "$state");
	Object.defineProperty(globalThis, "$state", {
		value: <T>(value: T) => value,
		configurable: true,
	});
	try {
		return createHarnessCapabilityController();
	} finally {
		if (previousState)
			Object.defineProperty(globalThis, "$state", previousState);
		else Reflect.deleteProperty(globalThis, "$state");
	}
}

test("reset ignores an old successful refresh, including its cache write", async () => {
	const controller = createController();
	const pending = controller.refresh(target);
	controller.reset();
	requests[0].resolve(catalog("old"));
	await pending;
	assert.equal(controller.catalog, null);
	assert.equal(controller.loaded, true);
	assert.equal(controller.refreshError, null);
	assert.deepEqual(writes, []);
});

test("reset ignores an old failed refresh", async () => {
	const controller = createController();
	const pending = controller.refresh(target);
	controller.reset();
	requests[0].reject(new Error("old failure"));
	await pending;
	assert.equal(controller.catalog, null);
	assert.equal(controller.loaded, true);
	assert.equal(controller.refreshError, null);
});

for (const outcome of ["success", "failure"] as const) {
	test(`restore preserves the restored catalog after an old ${outcome}`, async () => {
		const controller = createController();
		const pending = controller.refresh(target);
		const restored = catalog("restored");
		cached = restored;
		controller.restore(target);
		if (outcome === "success") requests[0].resolve(catalog("old"));
		else requests[0].reject(new Error("old failure"));
		await pending;
		assert.equal(controller.catalog, restored);
		assert.equal(controller.loaded, true);
		assert.equal(controller.refreshError, null);
		assert.deepEqual(writes, []);
	});
}

for (const outcome of ["success", "failure"] as const) {
	test(`an obsolete same-target ${outcome} cannot change or clear a newer request`, async () => {
		const controller = createController();
		const oldPending = controller.refresh(target);
		controller.reset();
		const newPending = controller.refresh(target);
		assert.equal(requests.length, 2);
		if (outcome === "success") requests[0].resolve(catalog("old"));
		else requests[0].reject(new Error("old failure"));
		await oldPending;
		assert.equal(controller.catalog, null);
		assert.equal(controller.refreshError, null);
		const deduplicated = controller.refresh(target);
		assert.equal(requests.length, 2, "old finally must not clear the new request");
		const latest = catalog("latest");
		requests[1].resolve(latest);
		await Promise.all([newPending, deduplicated]);
		assert.equal(controller.catalog, latest);
		assert.deepEqual(writes, [latest]);
	});
}

test("an old response arriving last cannot overwrite a newer same-target result", async () => {
	const controller = createController();
	const oldPending = controller.refresh(target);
	controller.restore(target);
	const newPending = controller.refresh(target);
	assert.equal(requests.length, 2);
	const latest = catalog("latest");
	requests[1].resolve(latest);
	await newPending;
	requests[0].resolve(catalog("old"));
	await oldPending;
	assert.equal(controller.catalog, latest);
	assert.deepEqual(writes, [latest]);
});

test("normal same-target refresh and uncached load calls share one request", async () => {
	const controller = createController();
	const first = controller.load(target);
	const second = controller.load(target);
	const third = controller.refresh(target);
	assert.equal(requests.length, 1);
	const latest = catalog("latest");
	requests[0].resolve(latest);
	await Promise.all([first, second, third]);
	assert.equal(controller.catalog, latest);
	assert.equal(controller.loaded, true);
	assert.equal(controller.refreshError, null);
	assert.deepEqual(writes, [latest]);
});

test("a current failure is visible and can be retried", async () => {
	const controller = createController();
	const failed = controller.refresh(target);
	requests[0].reject(new Error("current failure"));
	await failed;
	assert.equal(controller.catalog, null);
	assert.equal(controller.loaded, true);
	assert.equal(controller.refreshError, "current failure");
	const retried = controller.refresh(target);
	assert.equal(requests.length, 2);
	const latest = catalog("recovered");
	requests[1].resolve(latest);
	await retried;
	assert.equal(controller.catalog, latest);
	assert.equal(controller.refreshError, null);
	assert.deepEqual(writes, [latest]);
});
