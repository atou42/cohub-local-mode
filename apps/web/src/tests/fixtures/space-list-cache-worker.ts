import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SpaceRecord } from "@neta-art/cohub";
import { PartialSpaceListError } from "../../lib/merged-space-list.ts";

const storage = new Map<string, string>();
let userKey = "partial-list-user";
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalContext = Object.getOwnPropertyDescriptor(globalThis, "__partialListTest");
Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => storage.set(key, value),
	removeItem: (key: string) => storage.delete(key),
	key: (index: number) => [...storage.keys()][index] ?? null,
	get length() { return storage.size; },
} });
globals.__partialListTest = { getKey: () => userKey };
const modules: Record<string, string> = {
	"$lib/cache/keys": "export const getCacheUserKey=()=>globalThis.__partialListTest.getKey(); export const canUseUserScopedCache=()=>true;",
	"$lib/stores/auth.svelte": "export const authStore={ensureLoaded:async()=>{}};",
	"$lib/stores/space-record-cache": "export const cacheSpaceRecordsSoon=()=>{};",
};
const hook = registerHooks({
	resolve(specifier, context, next) {
		if (modules[specifier]) return { url: `test-list:${specifier}`, shortCircuit: true };
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url.startsWith("test-list:")) return { format: "module", source: modules[url.slice(10)], shortCircuit: true };
		return next(url, context);
	},
});
const cache = await import("../../lib/stores/space-list-cache.ts");
const space = (id: string, origin: "local" | "cloud") => ({ id, name: id, origin }) as SpaceRecord;

test("partial reads remain visible without replacing a complete cache or marking it fresh", async () => {
	try {
		const original = [space("local-old", "local"), space("cloud-old", "cloud")];
		cache.setCachedSpaceList(original);
		const persisted = JSON.stringify([...storage]);
		const meta = cache.getCachedSpaceListMeta();
		const events: string[][] = [];
		const off = cache.onSpaceListCacheUpdated(({ spaces }) => events.push(spaces.map(({ id }) => id)));
		const error = new PartialSpaceListError([space("cloud-new", "cloud")], [{ origin: "local", error: new Error("offline") }]);
		const fail = async () => { throw error; };
		await assert.rejects(cache.fetchSpaceListWithCache(fail), (value) => value === error);
		assert.deepEqual(cache.getCachedSpaceList()?.map(({ id }) => id), ["local-old", "cloud-new"]);
		assert.equal(cache.getSpaceListLoadError(), error.message);
		assert.deepEqual(cache.getCachedSpaceListMeta(), { updatedAt: meta?.updatedAt, isStale: true });
		assert.equal(JSON.stringify([...storage]), persisted);
		assert.deepEqual(events, [["local-old", "cloud-new"]]);
		await assert.rejects(cache.fetchSpaceListWithCache(fail));
		assert.equal(events.length, 1, "unchanged failures must not trigger a refresh loop");
		cache.patchCachedSpaceList((spaces) => spaces.map((item) => ({ ...item, isPinned: item.id === "cloud-new" })));
		assert.equal(cache.getCachedSpaceList()?.find(({ id }) => id === "cloud-new")?.isPinned, true);
		assert.equal(JSON.stringify([...storage]), persisted, "patches must not persist an incomplete list as complete");
		assert.equal(cache.getCachedSpaceListMeta()?.isStale, true);
		userKey = "another-user";
		assert.equal(cache.getCachedSpaceList(), null);
		assert.equal(cache.getSpaceListLoadError(), null);
		userKey = "partial-list-user";
		const healthy = [space("local-new", "local"), space("cloud-final", "cloud")];
		await cache.fetchSpaceListWithCache(async () => healthy);
		assert.deepEqual(cache.getCachedSpaceList()?.map(({ id }) => id), ["local-new", "cloud-final"]);
		assert.equal(cache.getSpaceListLoadError(), null);
		assert.equal(cache.getCachedSpaceListMeta()?.isStale, false);
		off();
	} finally {
		cache.clearAllCachedSpaceLists();
	}
});

test("first partial read displays the healthy source without creating a full cache", async () => {
	const error = new PartialSpaceListError([space("first-local", "local")], [{ origin: "cloud", error: new Error("offline") }]);
	await assert.rejects(cache.fetchSpaceListWithCache(async () => { throw error; }));
	assert.deepEqual(cache.getCachedSpaceList()?.map(({ id }) => id), ["first-local"]);
	assert.equal(storage.size, 0);
	assert.equal(cache.getCachedSpaceListMeta()?.isStale, true);
	const bothFailed = new AggregateError([new Error("local"), new Error("cloud")], "Local and cloud spaces could not be loaded.");
	await assert.rejects(cache.fetchSpaceListWithCache(async () => { throw bothFailed; }), (error) => error === bothFailed);
	assert.equal(cache.getSpaceListLoadError(), bothFailed.message);
	assert.deepEqual(cache.getCachedSpaceList()?.map(({ id }) => id), ["first-local"]);
	assert.equal(storage.size, 0);
	cache.clearAllCachedSpaceLists();
});

test.after(() => {
	hook.deregister();
	for (const [key, descriptor] of [["window", originalWindow], ["localStorage", originalStorage], ["__partialListTest", originalContext]] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
