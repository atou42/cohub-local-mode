import assert from "node:assert/strict";
import test from "node:test";
import type { ModelStatusResponse } from "@cohub/protocol/model/status";
import {
	readModelsStatusCache,
	writeModelsStatusCache,
} from "../lib/stores/models-status-cache";

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

const status: ModelStatusResponse = {
	generatedAt: "2026-08-27T00:00:00.000Z",
	overallStatus: "operational",
	models: {
		"grok-4.6": {
			status: "operational",
			successRate5m: 100,
			successRate2h: 100,
			successRate24h: 100,
			latencyAvgMs: 50,
			latencyP90Ms: 80,
			checkedAt: null,
			probeIntervalSeconds: 60,
			history: null,
			heartbeats8h: null,
			heartbeatsWindowMinutes: null,
		},
	},
};

test("model status cache restores a valid snapshot", () => {
	const storage = new MemoryStorage();
	const updatedAt = 1_000;
	writeModelsStatusCache(storage, status, updatedAt);
	assert.deepEqual(
		readModelsStatusCache(storage, updatedAt + 1)?.status,
		status,
	);
});

test("model status cache rejects malformed and expired snapshots", () => {
	const storage = new MemoryStorage();
	storage.setItem(
		"cohub:model-status:v1",
		JSON.stringify({ version: 1, updatedAt: 1_000, status: null }),
	);
	assert.equal(readModelsStatusCache(storage, 1_001), null);
	writeModelsStatusCache(storage, status, 1_000);
	assert.equal(
		readModelsStatusCache(storage, 1_000 + 24 * 60 * 60 * 1000 + 1),
		null,
	);
});
