import assert from "node:assert/strict";
import test from "node:test";

import {
	isTrustedLegacyRuntimeCommand,
	nextRuntimeRestart,
	statusPresentation,
	type ConnectorStatus,
} from "./connector-core.ts";

test("runtime recovery is bounded and exposes every retry", () => {
	assert.deepEqual(nextRuntimeRestart(1), { attempt: 1, delayMs: 1_000 });
	assert.deepEqual(nextRuntimeRestart(2), { attempt: 2, delayMs: 2_000 });
	assert.deepEqual(nextRuntimeRestart(3), { attempt: 3, delayMs: 4_000 });
	assert.deepEqual(nextRuntimeRestart(4), { attempt: 4, delayMs: 8_000 });
	assert.deepEqual(nextRuntimeRestart(5), { attempt: 5, delayMs: 15_000 });
	assert.equal(nextRuntimeRestart(6), null);
});

test("stale-process recovery cannot terminate an unrelated port owner", () => {
	const root = "/Users/me/Library/Application Support/Cohub Personal Node";
	assert.equal(
		isTrustedLegacyRuntimeCommand(
			`/Applications/Cohub.app/Contents/MacOS/Cohub ${root}/runtime/hash/manager.mjs`,
			root,
		),
		true,
	);
	assert.equal(
		isTrustedLegacyRuntimeCommand("/opt/homebrew/bin/postgres -D /tmp/other", root),
		false,
	);
});

test("menu presentation never calls a failed runtime online", () => {
	const recovering: ConnectorStatus = {
		state: "recovering",
		deviceId: "device-1",
		message: "postgres stopped unexpectedly",
		attempt: 2,
		maxAttempts: 5,
	};
	assert.deepEqual(statusPresentation(recovering), {
		label: "Recovering local services (2/5)",
		connected: false,
		detail: "postgres stopped unexpectedly",
	});

	const failed: ConnectorStatus = {
		state: "error",
		deviceId: "device-1",
		message: "postgres failed after 5 recovery attempts",
	};
	assert.deepEqual(statusPresentation(failed), {
		label: "Local services need attention",
		connected: false,
		detail: "postgres failed after 5 recovery attempts",
	});
});

test("connected and stopped states remain unambiguous", () => {
	assert.deepEqual(
		statusPresentation({ state: "connected", deviceId: "device-1", message: null }),
		{ label: "Online", connected: true, detail: null },
	);
	assert.deepEqual(
		statusPresentation({ state: "stopped", deviceId: "device-1", message: null }),
		{ label: "Stopped", connected: false, detail: null },
	);
});
