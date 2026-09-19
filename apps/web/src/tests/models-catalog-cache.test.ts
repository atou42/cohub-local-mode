import assert from "node:assert/strict";
import test from "node:test";
import {
	MODEL_CATALOG_CACHE_VERSION,
	readModelsCatalogCache,
	writeModelsCatalogCache,
} from "../lib/stores/models-catalog-cache-core";

class MemoryStorage {
	readonly values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
}

function withStorage(run: (storage: MemoryStorage) => void) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const storage = new MemoryStorage();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	try {
		run(storage);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else delete (globalThis as { localStorage?: Storage }).localStorage;
	}
}

const item = {
	provider: "cursor",
	id: "grok-4.6[effort=high,fast=true]",
	model: {
		name: "grok-4.6",
		reasoning: true,
		thinkingLevelMap: { high: "high" },
	},
};

test("model catalog cache is partitioned by origin and harness", () => {
	withStorage((storage) => {
		writeModelsCatalogCache(
			storage,
			"guest",
			"local",
			"cursor",
			[item],
			Date.now(),
		);
		assert.deepEqual(
			readModelsCatalogCache(storage, "guest", "local", "cursor")?.items,
			[item],
		);
		assert.equal(
			readModelsCatalogCache(storage, "guest", "cloud", "cursor"),
			null,
		);
		assert.equal(
			readModelsCatalogCache(storage, "guest", "local", "codex"),
			null,
		);
		const raw = [...storage.values.values()][0];
		assert.equal(JSON.parse(raw).version, MODEL_CATALOG_CACHE_VERSION);
	});
});

test("invalid and expired model catalog cache entries are ignored", () => {
	withStorage((storage) => {
		writeModelsCatalogCache(
			storage,
			"guest",
			"local",
			"cursor",
			[item],
			Date.now() - 25 * 60 * 60 * 1000,
		);
		assert.equal(
			readModelsCatalogCache(storage, "guest", "local", "cursor"),
			null,
		);
		storage.setItem(
			"cohub:model-catalog:v2:guest:local:cursor",
			JSON.stringify({
				version: 2,
				origin: "local",
				harness: "cursor",
				updatedAt: Date.now(),
				items: [{}],
			}),
		);
		assert.equal(
			readModelsCatalogCache(storage, "guest", "local", "cursor"),
			null,
		);
	});
});

test("Cursor cache does not restore a model outside the configured allowlist", () => {
	const storage = new MemoryStorage();
	writeModelsCatalogCache(
		storage,
		"guest",
		"local",
		"cursor",
		[item],
		Date.now(),
	);
	const key = [...storage.values.keys()][0];
	const parsed = JSON.parse(storage.getItem(key) ?? "null");
	parsed.items.push({
		provider: "cursor",
		id: "gpt-5.6-sol[reasoning=medium]",
		model: { name: "gpt-5.6-sol" },
	});
	storage.setItem(key, JSON.stringify(parsed));
	assert.equal(
		readModelsCatalogCache(storage, "guest", "local", "cursor"),
		null,
	);
});
