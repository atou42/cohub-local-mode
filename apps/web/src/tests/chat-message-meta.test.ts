import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatMessageBubble = readFileSync(
	new URL("../lib/components/ChatMessageBubble.svelte", import.meta.url),
	"utf8",
);

test("assistant message metadata stays inside the message width", () => {
	assert.match(
		chatMessageBubble,
		/class="[^"]*w-full[^"]*min-w-0[^"]*max-w-full[^"]*overflow-hidden[^"]*"/,
	);
	assert.match(
		chatMessageBubble,
		/class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"/,
	);
	assert.match(
		chatMessageBubble,
		/class="min-w-0 flex-1 truncate cursor-default"/,
	);
});

test("copy and fork keep one shared icon-button presentation", () => {
	assert.match(chatMessageBubble, /const metaActionButtonClass =/);
	assert.equal(
		chatMessageBubble.match(/class=\{metaActionButtonClass\}/g)?.length,
		2,
	);
	const forkMarkup = chatMessageBubble.slice(
		chatMessageBubble.indexOf("{#if canFork}"),
		chatMessageBubble.indexOf(
			"{/if}",
			chatMessageBubble.indexOf("{#if canFork}"),
		) + 6,
	);
	assert.match(forkMarkup, /if \(!forkDisabled\) onForkTurn\?\.\(\)/);
	assert.match(forkMarkup, /disabled=\{forkDisabled\}/);
	assert.doesNotMatch(forkMarkup, /\bhidden\b/);
});

test("visible cached usage uses parentheses without a localized word", () => {
	const visibleUsage = chatMessageBubble.slice(
		chatMessageBubble.indexOf("const tokenDisplay ="),
		chatMessageBubble.indexOf("const tokenDetailText ="),
	);
	assert.match(
		visibleUsage,
		/`\$\{inputLabel\} \(\$\{formatTokenCount\(cachedInputTokens\)\}\)`/,
	);
	assert.doesNotMatch(visibleUsage, /m\.chat_cached/);

	const usageDetail = chatMessageBubble.slice(
		chatMessageBubble.indexOf("const tokenDetailText ="),
		chatMessageBubble.indexOf("const modelContextWindow ="),
	);
	assert.match(usageDetail, /m\.chat_input_label/);
	assert.match(usageDetail, /cached/);
});
