import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentHarnessReadinessView } from "../lib/agent-harness-readiness";

test("Pi remains selectable before local detection returns", () => {
	assert.deepEqual(
		resolveAgentHarnessReadinessView({ harness: "pi", entry: null }),
		{
			available: true,
			label: "Ready",
			detail: "Pi is included with Cohub Connector.",
		},
	);
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
