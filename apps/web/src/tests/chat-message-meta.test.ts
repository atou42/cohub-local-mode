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
		/data-chat-meta-group="model"[\s\S]*?class="inline-flex min-w-0 shrink-\[3\] items-center gap-0\.5 overflow-hidden"/,
	);
	assert.match(
		chatMessageBubble,
		/data-chat-meta-group="usage"[\s\S]*?class="inline-flex min-w-0 shrink items-center gap-1 overflow-hidden"/,
	);
});

test("model and effort share one compact frame while usage and duration share another", () => {
	const modelGroup = chatMessageBubble.slice(
		chatMessageBubble.indexOf('data-chat-meta-group="model"'),
		chatMessageBubble.indexOf(
			'data-chat-meta-group="usage"',
			chatMessageBubble.indexOf('data-chat-meta-group="model"'),
		),
	);
	assert.match(modelGroup, /modelDisplayName/);
	assert.match(modelGroup, /requestedThinkingLevelShort/);

	const usageGroup = chatMessageBubble.slice(
		chatMessageBubble.indexOf('data-chat-meta-group="usage"'),
		chatMessageBubble.indexOf(
			"{#if assistantAbortMessage}",
			chatMessageBubble.indexOf('data-chat-meta-group="usage"'),
		),
	);
	assert.match(usageGroup, /tokenDisplay/);
	assert.match(usageGroup, /durationDisplay/);
});

test("copy and fork keep one shared icon-button presentation", () => {
	assert.match(chatMessageBubble, /const metaActionButtonClass =/);
	assert.equal(
		chatMessageBubble.match(/class=\{metaActionButtonClass\}/g)?.length,
		2,
	);
	const forkMarkup = chatMessageBubble.slice(
		chatMessageBubble.indexOf("{#if forkState.visible}"),
		chatMessageBubble.indexOf(
			"{#if message.role === 'user'}",
			chatMessageBubble.indexOf("{#if forkState.visible}"),
		),
	);
	assert.match(forkMarkup, /handleForkClick\(\)/);
	assert.match(forkMarkup, /class=\{metaActionButtonClass\}/);
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
