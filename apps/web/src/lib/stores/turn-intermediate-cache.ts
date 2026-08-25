import type { ContentBlock } from "@cohub/protocol/core";
import type {
	MessageToolCallsFile,
	StoredIntermediateMessage,
	StoredToolCall,
	TurnIntermediateMessagesFile,
} from "@cohub/protocol/model";
import { sdk } from "$lib/sdk";

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`Failed to fetch turn object ${response.status}`);
	return response.json() as Promise<T>;
}

function extractToolCalls(content: ContentBlock[]): StoredToolCall[] {
	const byId = new Map<string, StoredToolCall>();
	for (const block of content) {
		if (block.type !== "tool_use") continue;
		byId.set(block.id, {
			id: block.id,
			name: block.name,
			input: block.input,
			meta: block._meta ?? null,
			result: null,
		});
	}
	for (const block of content) {
		if (block.type !== "tool_result") continue;
		const existing = byId.get(block.tool_use_id);
		if (!existing) continue;
		byId.set(block.tool_use_id, {
			...existing,
			result: {
				content: block.content,
				isError: Boolean(block.is_error),
				meta: block._meta ?? null,
			},
		});
	}
	return [...byId.values()];
}

export async function loadTurnIntermediate(input: {
	spaceId: string;
	sessionId: string;
	turnId: string;
	messagesObjectKey: string | null;
}): Promise<StoredIntermediateMessage[]> {
	const loadPersistedMessages = async () => {
		const { messages } = await sdk
			.space(input.spaceId)
			.session(input.sessionId)
			.turns.intermediate(input.turnId);
		return messages;
	};
	if (!input.messagesObjectKey) return loadPersistedMessages();
	const { urls } = await sdk
		.space(input.spaceId)
		.session(input.sessionId)
		.turns.signedUrls(input.turnId, [input.messagesObjectKey]);
	const url = urls[input.messagesObjectKey];
	if (!url) throw new Error("Missing signed URL for intermediate messages");
	let file: TurnIntermediateMessagesFile;
	try {
		file = await fetchJson<TurnIntermediateMessagesFile>(url);
	} catch {
		return loadPersistedMessages();
	}
	return file.messages.map((message) => ({
		...message,
		durationMs:
			typeof message.durationMs === "number" &&
			Number.isFinite(message.durationMs)
				? message.durationMs
				: null,
	}));
}

export async function loadMessageToolCalls(input: {
	spaceId: string;
	sessionId: string;
	turnId: string;
	message: StoredIntermediateMessage;
}): Promise<MessageToolCallsFile | null> {
	if (!input.message.toolCallsObjectKey) {
		const toolCalls = extractToolCalls(input.message.content);
		if (toolCalls.length === 0) return null;
		return {
			version: 1,
			spaceId: input.spaceId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			messageId: input.message.id,
			toolCalls,
		};
	}
	const { urls } = await sdk
		.space(input.spaceId)
		.session(input.sessionId)
		.turns.signedUrls(input.turnId, [input.message.toolCallsObjectKey]);
	const url = urls[input.message.toolCallsObjectKey];
	if (!url) throw new Error("Missing signed URL for tool calls");
	return fetchJson<MessageToolCallsFile>(url);
}
