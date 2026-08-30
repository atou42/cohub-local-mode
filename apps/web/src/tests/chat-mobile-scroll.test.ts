import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatTimeline = readFileSync(
	new URL("../lib/components/ChatTimeline.svelte", import.meta.url),
	"utf8",
);
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");

test("the chat timeline only scrolls vertically at its outer boundary", () => {
	assert.match(
		chatTimeline,
		/class="[^"]*chat-timeline-scroll[^"]*overflow-x-hidden[^"]*overflow-y-auto[^"]*"/,
	);
	assert.match(
		chatTimeline,
		/\.chat-timeline-scroll\s*{[^}]*overscroll-behavior-x:\s*none;/s,
	);
});

test("wide message content keeps its own horizontal interaction", () => {
	assert.match(
		appCss,
		/\.markdown-content table\s*{[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;[^}]*touch-action:\s*pan-x pan-y;/s,
	);
	assert.match(
		appCss,
		/\.markdown-content pre\s*{[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x pan-y;/s,
	);
});
