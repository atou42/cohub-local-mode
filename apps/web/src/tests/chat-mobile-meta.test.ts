import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentHarnessLogoAssets } from "../lib/agent-harness-logo";
import {
	formatCompactControlMeta,
	formatCompactModelLabel,
	getCompactControlMetaTone,
} from "../lib/compact-control-labels";
import { formatDurationMs } from "../lib/format-duration";

test("compact chat durations stay distinct from clock times", () => {
	assert.equal(formatDurationMs(246_000, "en"), "4m6s");
	assert.equal(formatDurationMs(246_000, "zh-CN"), "4m6s");
	assert.equal(formatDurationMs(60_000, "zh-CN"), "1m");
});

test("mobile model controls preserve a dense one-line summary", () => {
	assert.equal(formatCompactModelLabel("GPT-5.6-Sol"), "GPT-5.6-Sol");
	assert.equal(formatCompactControlMeta("High"), "H");
	assert.equal(formatCompactControlMeta("Fast"), "F");
	assert.equal(formatCompactControlMeta("xHigh"), "xH");
	assert.equal(getCompactControlMetaTone("High"), "thinking");
	assert.equal(getCompactControlMetaTone("Fast"), "speed");
});

test("every composer harness has an official compact logo", () => {
	assert.deepEqual(getAgentHarnessLogoAssets("pi"), {
		light: "/agent-harness/pi-auto.svg",
		dark: "/agent-harness/pi-auto.svg",
	});
	for (const harness of ["codex", "cursor", "grok_build"] as const) {
		const assets = getAgentHarnessLogoAssets(harness);
		assert.match(
			assets.light,
			new RegExp(`/${harness === "grok_build" ? "grok" : harness}-on-light\\.`),
		);
		assert.match(
			assets.dark,
			new RegExp(`/${harness === "grok_build" ? "grok" : harness}-on-dark\\.`),
		);
	}
});
