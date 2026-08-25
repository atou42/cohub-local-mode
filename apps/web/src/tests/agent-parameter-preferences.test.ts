import assert from "node:assert/strict";
import test from "node:test";
import {
	createEmptyAgentParameterPreferences,
	getAgentModelParameterPreference,
	readAgentParameterPreferences,
	resetAgentParameterPreferences,
	resolveAgentParameterSelection,
	updateAgentParameterPreferences,
	writeAgentParameterPreferences,
} from "../lib/stores/agent-parameter-preferences";

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
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
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

test("preferences stay isolated by user, harness, and model", () => {
	withStorage(() => {
		let preferences = createEmptyAgentParameterPreferences();
		preferences = updateAgentParameterPreferences(preferences, {
			harness: "codex",
			model: { provider: "codex", id: "gpt-5.6-sol" },
			thinkingLevel: "ultra",
			serviceTier: "priority",
		});
		preferences = updateAgentParameterPreferences(preferences, {
			harness: "codex",
			model: { provider: "codex", id: "gpt-5.4-mini" },
			thinkingLevel: "medium",
		});
		preferences = updateAgentParameterPreferences(preferences, {
			harness: "grok_build",
			model: { provider: "grok_build", id: "grok-4.6" },
			thinkingLevel: "low",
		});

		writeAgentParameterPreferences(preferences, "user-a");
		const own = readAgentParameterPreferences("user-a");
		assert.equal(own.status, "ready");
		if (own.status !== "ready") assert.fail("preferences were not readable");
		assert.deepEqual(own.value.lastModelByHarness.codex, {
			provider: "codex",
			id: "gpt-5.4-mini",
		});
		assert.deepEqual(
			getAgentModelParameterPreference(own.value, "codex", {
				provider: "codex",
				id: "gpt-5.6-sol",
			}),
			{ thinkingLevel: "ultra", serviceTier: "priority" },
		);
		assert.deepEqual(
			getAgentModelParameterPreference(own.value, "grok_build", {
				provider: "grok_build",
				id: "grok-4.6",
			}),
			{ thinkingLevel: "low" },
		);
		assert.equal(readAgentParameterPreferences("user-b").status, "empty");
	});
});

test("stale model parameters are repaired against the live catalog with a notice", () => {
	let preferences = createEmptyAgentParameterPreferences();
	preferences = updateAgentParameterPreferences(preferences, {
		harness: "codex",
		model: { provider: "codex", id: "gpt-5.6-sol" },
		thinkingLevel: "ultra",
		serviceTier: "retired-tier",
	});
	const catalog = [
		{
			provider: "codex",
			id: "gpt-5.6-sol",
			model: {
				name: "GPT-5.6-Sol",
				reasoning: true,
				defaultThinkingLevel: "low",
				thinkingLevelMap: { low: "low", high: "high", ultra: null },
				serviceTiers: [{ id: "priority", name: "Fast" }],
			},
		},
	];
	const resolved = resolveAgentParameterSelection({
		harness: "codex",
		catalog,
		preferences,
	});
	assert.equal(resolved.thinkingLevel, "low");
	assert.equal(resolved.serviceTier, "priority");
	assert.equal(resolved.repaired, true);
	assert.match(resolved.notice ?? "", /no longer available/i);
	assert.deepEqual(
		getAgentModelParameterPreference(resolved.preferences, "codex", {
			provider: "codex",
			id: "gpt-5.6-sol",
		}),
		{ thinkingLevel: "low", serviceTier: "priority" },
	);
});

test("a Codex model without Fast removes a stale speed choice", () => {
	let preferences = createEmptyAgentParameterPreferences();
	preferences = updateAgentParameterPreferences(preferences, {
		harness: "codex",
		model: { provider: "codex", id: "gpt-5.4-mini" },
		thinkingLevel: "medium",
		serviceTier: "priority",
	});
	const resolved = resolveAgentParameterSelection({
		harness: "codex",
		catalog: [
			{
				provider: "codex",
				id: "gpt-5.4-mini",
				model: {
					name: "GPT-5.4-Mini",
					reasoning: true,
					defaultThinkingLevel: "medium",
					thinkingLevelMap: { medium: "medium" },
					serviceTiers: [],
				},
			},
		],
		preferences,
	});
	assert.equal(resolved.serviceTier, undefined);
	assert.equal(resolved.repaired, true);
	assert.match(resolved.notice ?? "", /no longer supports/i);
	assert.deepEqual(
		getAgentModelParameterPreference(resolved.preferences, "codex", {
			provider: "codex",
			id: "gpt-5.4-mini",
		}),
		{ thinkingLevel: "medium" },
	);
});

test("malformed preferences remain intact until an explicit reset", () => {
	withStorage((storage) => {
		storage.setItem("cohub:agent-parameter-preferences:v2:user-a", "{broken");
		const result = readAgentParameterPreferences("user-a");
		assert.equal(result.status, "invalid");
		assert.equal(
			storage.getItem("cohub:agent-parameter-preferences:v2:user-a"),
			"{broken",
		);
		resetAgentParameterPreferences("user-a");
		assert.equal(readAgentParameterPreferences("user-a").status, "empty");
	});
});
