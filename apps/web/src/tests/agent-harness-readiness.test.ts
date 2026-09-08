import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentHarnessReadinessView } from "../lib/agent-harness-readiness";

test("Pi waits for local detection instead of treating bundled as ready", () => {
	assert.deepEqual(
		resolveAgentHarnessReadinessView({ harness: "pi", entry: null }),
		{
			available: false,
			label: "Checking…",
			detail: "Local Agent status is still loading.",
		},
	);
});

test("Pi without provider configuration is visible but unavailable", () => {
	const view = resolveAgentHarnessReadinessView({
		harness: "pi",
		entry: {
			harness: "pi", label: "Pi", state: "setup_required", bundled: true,
			detail: "No local model provider is configured.",
		},
	});
	assert.equal(view.available, false);
	assert.equal(view.label, "Setup required");
});

test("missing and unauthenticated host harnesses remain visible but locked", () => {
	const missing = resolveAgentHarnessReadinessView({
		harness: "grok_build",
		entry: {
			harness: "grok_build",
			label: "Grok Build",
			state: "not_installed",
			bundled: false,
			detail: "Grok Build is not installed on this Mac.",
			action: { kind: "install", label: "Install Grok Build" },
		},
	});
	assert.equal(missing.available, false);
	assert.equal(missing.label, "Not installed");

	const auth = resolveAgentHarnessReadinessView({
		harness: "cursor",
		entry: {
			harness: "cursor",
			label: "Cursor",
			state: "sign_in_required",
			bundled: false,
			detail: "Cursor is installed but not signed in.",
			action: { kind: "sign_in", label: "Sign in", command: "agent login" },
		},
	});
	assert.equal(auth.available, false);
	assert.equal(auth.label, "Sign in required");
});

test("readiness transport failure locks external harnesses without hiding the error", () => {
	assert.deepEqual(
		resolveAgentHarnessReadinessView({
			harness: "codex",
			entry: null,
			error: "Local Mac is offline",
		}),
		{
			available: false,
			label: "Status unavailable",
			detail: "Local Mac is offline",
		},
	);
});
