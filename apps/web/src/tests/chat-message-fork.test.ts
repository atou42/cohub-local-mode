import assert from "node:assert/strict";
import { test } from "node:test";
import { getChatMessageForkState } from "../lib/chat-message-fork";
import type { ChatMessage } from "../lib/session-tree";

function message(
	role: ChatMessage["role"],
	meta: ChatMessage["meta"],
): ChatMessage {
	return {
		id: "message-1",
		role,
		content: [],
		text: "",
		sequence: 1,
		createdAt: "2026-08-29T00:00:00.000Z",
		meta,
	};
}

test("terminal assistant messages keep the Fork action visible without a checkpoint", () => {
	assert.deepEqual(
		getChatMessageForkState(
			message("assistant", { messageKind: "assistant_final" }),
			false,
		),
		{ visible: true, available: false },
	);
});

test("terminal assistant messages with a checkpoint can be forked", () => {
	const turn = {
		status: "completed",
		meta: { agentSessionEntryId: "entry-1" },
	} as unknown as NonNullable<NonNullable<ChatMessage["meta"]>["turn"]>;
	assert.deepEqual(
		getChatMessageForkState(
			message("assistant", { messageKind: "assistant_final", turn }),
			true,
		),
		{ visible: true, available: true },
	);
});

test("streaming and user messages do not expose Fork", () => {
	assert.deepEqual(
		getChatMessageForkState(
			message("assistant", {
				messageKind: "assistant_final",
				streaming: true,
			}),
			true,
		),
		{ visible: false, available: false },
	);
	assert.deepEqual(
		getChatMessageForkState(
			message("user", { messageKind: "turn_user" }),
			true,
		),
		{ visible: false, available: false },
	);
});
