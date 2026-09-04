import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessReadinessResponse } from "@cohub/protocol";
import {
	HARNESS_READINESS_MAX_AGE_MS,
	readHarnessReadinessCache,
	writeHarnessReadinessCache,
} from "../lib/stores/harness-readiness-cache-core";

class MemoryStorage implements Storage {
	private data = new Map<string, string>();
	get length() {
		return this.data.size;
	}
	clear() {
		this.data.clear();
	}
	getItem(key: string) {
		return this.data.get(key) ?? null;
	}
	key(index: number) {
		return [...this.data.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.data.delete(key);
	}
	setItem(key: string, value: string) {
		this.data.set(key, value);
	}
}

const response: HarnessReadinessResponse = {
	checkedAt: "2026-09-04T00:00:00.000Z",
	harnesses: [
		{
			harness: "pi",
			label: "Pi",
			state: "ready",
			bundled: true,
			detail: "Included",
		},
		{
			harness: "codex",
			label: "Codex",
			state: "ready",
			bundled: false,
			detail: "Ready",
		},
		{
			harness: "grok_build",
			label: "Grok Build",
			state: "not_installed",
			bundled: false,
			detail: "Missing",
			action: { kind: "install", label: "Install" },
		},
		{
			harness: "cursor",
			label: "Cursor",
			state: "sign_in_required",
			bundled: false,
			detail: "Sign in",
			action: { kind: "sign_in", label: "Sign in", command: "agent login" },
		},
	],
};

test("harness readiness cache preserves unavailable rows for instant rendering", () => {
	const storage = new MemoryStorage();
	writeHarnessReadinessCache(storage, "user-1", response, 1_000);
	assert.deepEqual(readHarnessReadinessCache(storage, "user-1", 2_000), {
		response,
		updatedAt: 1_000,
	});
	assert.equal(
		readHarnessReadinessCache(
			storage,
			"user-1",
			1_000 + HARNESS_READINESS_MAX_AGE_MS + 1,
		),
		null,
	);
});

test("harness readiness cache rejects incomplete or cross-user state", () => {
	const storage = new MemoryStorage();
	writeHarnessReadinessCache(storage, "user-1", response, 1_000);
	assert.equal(readHarnessReadinessCache(storage, "user-2", 2_000), null);
	assert.throws(
		() =>
			writeHarnessReadinessCache(storage, "user-1", {
				...response,
				harnesses: response.harnesses.slice(0, 3),
			}),
		/invalid/,
	);
});
