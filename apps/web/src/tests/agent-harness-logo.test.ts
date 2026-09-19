import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sessionComposer = readFileSync(
	new URL("../lib/components/SessionComposer.svelte", import.meta.url),
	"utf8",
);

test("the mobile agent harness trigger is logo-only", () => {
	assert.match(
		sessionComposer,
		/import AgentHarnessLogo from "\$lib\/components\/AgentHarnessLogo\.svelte"/,
	);
	assert.doesNotMatch(sessionComposer, /\bBot\b/);
	assert.match(
		sessionComposer,
		/class="flex h-7 w-7 items-center justify-center rounded-full[^"]*sm:w-auto/,
	);
	assert.match(
		sessionComposer,
		/<AgentHarnessLogo harness=\{agentHarness\} class="h-6 w-6 sm:h-5 sm:w-5" \/>/,
	);
	assert.match(
		sessionComposer,
		/<span class="hidden min-w-0 truncate sm:inline">\{agentHarnessLabel\}<\/span>/,
	);
});

test("the agent harness menu shows each harness logo", () => {
	assert.match(
		sessionComposer,
		/<AgentHarnessLogo harness=\{option\.value\} class="h-5 w-5" \/>/,
	);

	for (const asset of [
		"pi-auto.svg",
		"codex-on-light.png",
		"codex-on-dark.png",
		"grok-on-light.svg",
		"grok-on-dark.svg",
		"cursor-on-light.svg",
		"cursor-on-dark.svg",
	]) {
		assert.equal(
			existsSync(
				new URL(`../../static/agent-harness/${asset}`, import.meta.url),
			),
			true,
			`${asset} should be bundled`,
		);
	}
});
