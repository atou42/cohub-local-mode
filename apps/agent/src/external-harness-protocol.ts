import type { AgentHarness } from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import {
	redactExternalHarnessText,
	redactExternalHarnessValue,
} from "./external-harness-redaction.js";

export type AccessMode = "read_only" | "full_access";

type ToolSnapshot = {
	id: string;
	name: string;
	input: Record<string, unknown>;
	result?: unknown;
	isError?: boolean;
	status?: "running" | "done" | "failed";
	runtimeEvent?: ExternalHarnessRuntimeEventMeta;
};

export type ExternalHarnessProgressKind =
	| "starting"
	| "status"
	| "thinking"
	| "assistant"
	| "tool"
	| "warning"
	| "recovery"
	| "stderr"
	| "completed";

export type ExternalHarnessRuntimeEventMeta = {
	kind: ExternalHarnessProgressKind;
	eventType: string;
	at: string;
	raw?: unknown;
};

export type ExternalHarnessProgress = ExternalHarnessRuntimeEventMeta & {
	message: string | null;
	content: ContentBlock[];
};

export type ExternalHarnessResult = {
	content: ContentBlock[];
	externalSessionId: string | null;
	model: string;
	provider: string;
	stopReason: string;
	usage: Usage | null;
	thinkingLevel: string;
};

export function splitExternalHarnessContent(content: ContentBlock[]): {
	intermediate: ContentBlock[];
	final: ContentBlock[];
} {
	const intermediate = content.filter((block) => block.type !== "text");
	const final = content.filter(
		(block): block is Extract<ContentBlock, { type: "text" }> =>
			block.type === "text" && block.text.trim().length > 0,
	);
	if (final.length === 0) {
		throw new Error("external harness completed without a final assistant message");
	}
	return { intermediate, final };
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function normalizedUsage(value: unknown): Usage | null {
	const input = record(value);
	if (!input) return null;
	const number = (...keys: string[]) => {
		for (const key of keys) {
			const candidate = input[key];
			if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
		}
		return undefined;
	};
	const usage: Usage = {
		input: number("input_tokens", "inputTokens"),
		output: number("output_tokens", "outputTokens"),
		cacheRead: number(
			"cached_input_tokens",
			"cache_read_input_tokens",
			"cachedReadTokens",
		),
		totalTokens: number("total_tokens", "totalTokens"),
	};
	return Object.values(usage).some((item) => typeof item === "number") ? usage : null;
}

function toolResultContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function grokContentText(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const chunks: string[] = [];
	for (const item of value) {
		const outer = record(item);
		const inner = record(outer?.content);
		const chunk = text(inner?.text) || text(outer?.text);
		if (chunk) chunks.push(chunk);
	}
	return chunks.length > 0 ? chunks.join("") : null;
}

function grokToolResult(update: Record<string, unknown>): unknown {
	const content = grokContentText(update.content);
	if (content !== null) return content;

	const rawOutput = record(update.rawOutput);
	if (rawOutput && Array.isArray(rawOutput.output)) {
		if (
			!rawOutput.output.every(
				(value) =>
					typeof value === "number" &&
					Number.isInteger(value) &&
					value >= 0 &&
					value <= 255,
			)
		) {
			throw new Error("Grok Build tool output contains invalid byte data");
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Uint8Array.from(rawOutput.output),
		);
	}

	return update.rawOutput ?? update.content ?? update.output ?? "";
}

function mergeStreamText(current: string, next: string): string {
	if (!next) return current;
	if (!current) return next;
	if (next === current || current.endsWith(next)) return current;
	if (next.startsWith(current)) return next;
	return current + next;
}

export class HarnessEventReducer {
	readonly harness: Exclude<AgentHarness, "pi">;
	readonly model: string;
	readonly thinkingLevel: string;
	private assistantText = "";
	private thinkingText = "";
	private tools = new Map<string, ToolSnapshot>();
	private toolOrder: string[] = [];
	private terminalError: string | null = null;
	private streamError: string | null = null;
	private completed = false;
	private sessionId: string | null = null;
	private usage: Usage | null = null;
	private runtimeNotes: ContentBlock[] = [];
	private streamIndexByKey = new Map<string, number>();
	private nextStreamIndex = 0;
	private thinkingRuntimeEvent: ExternalHarnessRuntimeEventMeta | null = null;
	private assistantRuntimeEvent: ExternalHarnessRuntimeEventMeta | null = null;
	private assistantSegment = 0;
	private latestProgress: Omit<ExternalHarnessProgress, "content"> | null = null;

	constructor(
		harness: Exclude<AgentHarness, "pi">,
		selection: { model: string; thinkingLevel: string },
	) {
		this.harness = harness;
		this.model = selection.model;
		this.thinkingLevel = selection.thinkingLevel;
	}

	get externalSessionId() {
		return this.sessionId;
	}

	push(value: unknown): ExternalHarnessProgress | null {
		const event = record(redactExternalHarnessValue(value));
		if (!event) return null;
		this.latestProgress = null;
		if (this.harness === "codex") this.pushCodex(event);
		else if (this.harness === "grok_build") this.pushGrok(event);
		else this.pushCursor(event);
		if (!this.latestProgress) {
			const eventType = text(event.type) || text(event.method) || "event";
			const message = `Received ${eventType}`;
			this.addRuntimeNote("status", eventType, message, event);
			this.setProgress("status", eventType, message, event);
		}
		const progress = this.latestProgress as Omit<
			ExternalHarnessProgress,
			"content"
		> | null;
		if (!progress) return null;
		return { ...progress, content: this.snapshotContent() };
	}

	pushRuntimeEvent(input: {
		kind: ExternalHarnessProgressKind;
		eventType: string;
		message: string;
		raw?: unknown;
	}): ExternalHarnessProgress {
		const raw = redactExternalHarnessValue(input.raw);
		const message = redactExternalHarnessText(input.message);
		this.addRuntimeNote(input.kind, input.eventType, message, raw);
		const progress = this.setProgress(
			input.kind,
			input.eventType,
			message,
			raw,
		);
		return { ...progress, content: this.snapshotContent() };
	}

	private runtimeEvent(
		kind: ExternalHarnessProgressKind,
		eventType: string,
		raw?: unknown,
	): ExternalHarnessRuntimeEventMeta {
		return {
			kind,
			eventType,
			at: new Date().toISOString(),
			...(raw === undefined ? {} : { raw }),
		};
	}

	private setProgress(
		kind: ExternalHarnessProgressKind,
		eventType: string,
		message: string | null,
		raw?: unknown,
	) {
		const progress = {
			...this.runtimeEvent(kind, eventType, raw),
			message,
		};
		this.latestProgress = progress;
		return progress;
	}

	private addRuntimeNote(
		kind: ExternalHarnessProgressKind,
		eventType: string,
		message: string,
		raw?: unknown,
	) {
		const runtimeEvent = this.runtimeEvent(kind, eventType, raw);
		const streamIndex = this.ensureStreamIndex(
			`runtime-note:${this.runtimeNotes.length}`,
		);
		this.runtimeNotes.push({
			type: "system_note",
			note_type: "info",
			text: message,
			_meta: { runtimeEvent, streamIndex },
		});
	}

	private ensureStreamIndex(key: string) {
		const existing = this.streamIndexByKey.get(key);
		if (existing !== undefined) return existing;
		const assigned = this.nextStreamIndex;
		this.nextStreamIndex += 1;
		this.streamIndexByKey.set(key, assigned);
		return assigned;
	}

	private upsertTool(tool: ToolSnapshot) {
		if (!this.tools.has(tool.id)) {
			this.toolOrder.push(tool.id);
			this.ensureStreamIndex(`tool-use:${tool.id}`);
			this.ensureStreamIndex(`tool-result:${tool.id}`);
		}
		this.tools.set(tool.id, { ...this.tools.get(tool.id), ...tool });
	}

	private assistantStreamKey() {
		return `assistant:${this.assistantSegment}`;
	}

	private archiveAssistantSegment(event: Record<string, unknown>) {
		const message = this.assistantText.trim();
		if (!message) return;
		this.addRuntimeNote(
			"assistant",
			"agent_message_intermediate",
			message,
			event,
		);
		this.assistantText = "";
		this.assistantRuntimeEvent = null;
		this.assistantSegment += 1;
	}

	private pushCodex(event: Record<string, unknown>) {
		const eventType = text(event.type);
		if (eventType === "assistant.message.delta") {
			const chunk = text(event.text) || text(event.delta);
			this.assistantText = mergeStreamText(this.assistantText, chunk);
			this.ensureStreamIndex(this.assistantStreamKey());
			this.assistantRuntimeEvent = this.runtimeEvent(
				"assistant",
				eventType,
				event,
			);
			this.setProgress("assistant", eventType, chunk || null, event);
			return;
		}
		if (eventType === "reasoning.delta" || eventType === "reasoning.summary") {
			const chunk = text(event.text) || text(event.delta);
			this.thinkingText = mergeStreamText(this.thinkingText, chunk);
			this.ensureStreamIndex("thinking");
			this.thinkingRuntimeEvent = this.runtimeEvent(
				"thinking",
				eventType,
				event,
			);
			this.setProgress("thinking", eventType, chunk || null, event);
			return;
		}
		if (eventType === "turn.plan.updated") {
			const message = "Codex updated its plan";
			this.addRuntimeNote("status", eventType, message, event);
			this.setProgress("status", eventType, message, event);
			return;
		}
		if (eventType === "turn.attention.required") {
			const message = "Codex needs approval or input";
			this.addRuntimeNote("warning", eventType, message, event);
			this.setProgress("warning", eventType, message, event);
			return;
		}
		if (eventType === "command.output.delta") {
			const id = text(event.item_id) || text(event.itemId);
			if (!id) return;
			const previous = this.tools.get(id);
			const chunk = text(event.delta) || text(event.text);
			this.upsertTool({
				id,
				name: previous?.name || "bash",
				input: previous?.input ?? {},
				result: mergeStreamText(toolResultContent(previous?.result), chunk),
				isError: false,
				status: "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress("tool", eventType, chunk || "Command output", event);
			return;
		}
		if (eventType === "thread.started") {
			this.sessionId = text(event.thread_id) || this.sessionId;
			const message = "Codex session connected";
			this.addRuntimeNote("status", eventType, message, event);
			this.setProgress("status", eventType, message, event);
			return;
		}
		if (eventType === "turn.started") {
			const message = "Codex started working";
			this.addRuntimeNote("status", eventType, message, event);
			this.setProgress("status", eventType, message, event);
			return;
		}
		if (eventType === "error" || eventType === "turn.failed") {
			const error = record(event.error);
			const message = text(event.message) || text(error?.message) || eventType;
			if (eventType === "turn.failed") this.terminalError = message;
			else this.streamError = message;
			this.addRuntimeNote("warning", eventType, message, event);
			this.setProgress("warning", eventType, message, event);
			return;
		}
		if (eventType === "turn.completed") {
			this.completed = true;
			this.usage = normalizedUsage(event.usage);
			if (this.streamError) {
				this.addRuntimeNote(
					"recovery",
					"turn.recovered",
					"Codex recovered from the stream interruption",
					event,
				);
			}
			const message = "Codex completed";
			this.addRuntimeNote("completed", eventType, message, event);
			this.setProgress("completed", eventType, message, event);
			return;
		}
		if (eventType !== "item.started" && eventType !== "item.completed") return;
		const item = record(event.item);
		if (!item) return;
		const itemType = text(item.type)
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replace(/[./-]/g, "_")
			.toLowerCase();
		const id = text(item.id) || `codex-${this.toolOrder.length + 1}`;
		if (itemType === "agent_message") {
			const chunk = text(item.text);
			this.assistantText = mergeStreamText(this.assistantText, chunk);
			this.ensureStreamIndex(this.assistantStreamKey());
			this.assistantRuntimeEvent = this.runtimeEvent(
				"assistant",
				eventType,
				event,
			);
			this.setProgress("assistant", eventType, chunk || null, event);
			return;
		}
		if (itemType === "reasoning") {
			const chunk = text(item.text);
			this.thinkingText = mergeStreamText(this.thinkingText, chunk);
			this.ensureStreamIndex("thinking");
			this.thinkingRuntimeEvent = this.runtimeEvent(
				"thinking",
				eventType,
				event,
			);
			this.setProgress("thinking", eventType, chunk || null, event);
			return;
		}
		if (itemType === "command_execution") {
			const completed = eventType === "item.completed";
			const exitCode = item.exit_code ?? item.exitCode;
			const failed =
				completed &&
				((typeof exitCode === "number" && exitCode !== 0) ||
					item.status === "failed");
			this.upsertTool({
				id,
				name: "bash",
				input: { command: item.command ?? item.commands ?? "" },
				...(completed
					? {
							result:
								item.aggregated_output ?? item.aggregatedOutput ??
								item.output ?? "",
						}
					: {}),
				isError: failed,
				status: completed ? (failed ? "failed" : "done") : "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress("tool", eventType, text(item.command) || "Command", event);
			return;
		}
		if (itemType === "file_change") {
			const completed = eventType === "item.completed";
			const failed = completed && item.status === "failed";
			this.upsertTool({
				id,
				name: "apply_patch",
				input: { changes: item.changes ?? [] },
				...(completed ? { result: item.status ?? "completed" } : {}),
				isError: failed,
				status: completed ? (failed ? "failed" : "done") : "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress("tool", eventType, "File change", event);
			return;
		}
		if (itemType === "mcp_tool_call") {
			const completed = eventType === "item.completed";
			const failed = completed && (item.status === "failed" || Boolean(item.error));
			this.upsertTool({
				id,
				name: text(item.tool) || text(item.name) || "mcp",
				input: record(item.arguments) ?? record(item.input) ?? {},
				...(completed ? { result: item.result ?? item.output ?? "" } : {}),
				isError: failed,
				status: completed ? (failed ? "failed" : "done") : "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress(
				"tool",
				eventType,
				text(item.tool) || text(item.name) || "MCP tool",
				event,
			);
			return;
		}
		const statusItemTypes = new Set([
			"context_compaction",
			"entered_review_mode",
			"exited_review_mode",
			"hook_prompt",
			"plan",
		]);
		if (statusItemTypes.has(itemType)) {
			const message =
				itemType === "context_compaction"
					? "Codex compacted its context"
					: itemType === "plan"
						? "Codex updated its plan"
						: `Codex ${itemType.replaceAll("_", " ")}`;
			this.addRuntimeNote("status", `${eventType}:${itemType}`, message, event);
			this.setProgress("status", `${eventType}:${itemType}`, message, event);
			return;
		}
		if (itemType !== "user_message") {
			const completed = eventType === "item.completed";
			const failed = completed && (item.status === "failed" || Boolean(item.error));
			this.upsertTool({
				id,
				name: text(item.name) || text(item.tool) || itemType || "codex_item",
				input:
					record(item.input) ?? record(item.arguments) ?? {
						query: item.query ?? item.action ?? "",
					},
				...(completed
					? { result: item.result ?? item.output ?? item.status ?? "completed" }
					: {}),
				isError: failed,
				status: completed ? (failed ? "failed" : "done") : "running",
				runtimeEvent: this.runtimeEvent("tool", `${eventType}:${itemType}`, event),
			});
			this.setProgress(
				"tool",
				`${eventType}:${itemType}`,
				text(item.name) || text(item.tool) || itemType.replaceAll("_", " "),
				event,
			);
		}
	}

	private pushGrok(event: Record<string, unknown>) {
		const params = record(event.params);
		const update = record(params?.update) ?? record(event.update) ?? event;
		const eventType = text(update.sessionUpdate) || text(update.type) || text(event.type);
		const content = record(update.content);
		const chunk = text(content?.text) || text(update.data) || text(update.text);
		const observedSessionId =
			text(params?.sessionId) || text(update.sessionId) || text(event.sessionId) ||
			text(update.session_id);
		if (observedSessionId) this.sessionId = observedSessionId;

		if (eventType === "retry_state") {
			const retryType = text(update.type) || "retrying";
			const reason = text(update.reason) || text(update.message) || "Grok Build request failed";
			const attempt =
				typeof update.attempt === "number" ? update.attempt : update.attempts;
			const maximum = update.max_retries;
			const suffix =
				typeof attempt === "number"
					? ` (${attempt}${typeof maximum === "number" ? `/${maximum}` : ""})`
					: "";
			const message =
				retryType === "retrying"
					? `Grok Build is retrying${suffix}: ${reason}`
					: `Grok Build ${retryType}: ${reason}`;
			this.streamError = reason;
			this.addRuntimeNote("warning", eventType, message, event);
			this.setProgress("warning", eventType, message, event);
			return;
		}
		if (eventType === "plan") {
			const message = "Grok Build updated its plan";
			this.addRuntimeNote("status", eventType, message, event);
			this.setProgress("status", eventType, message, event);
			return;
		}
		if (eventType === "user_message_chunk") {
			this.setProgress("status", eventType, "Grok Build received the prompt", event);
			return;
		}

		if (eventType === "agent_message_chunk" || eventType === "text") {
			this.assistantText = mergeStreamText(this.assistantText, chunk);
			this.ensureStreamIndex(this.assistantStreamKey());
			this.assistantRuntimeEvent = this.runtimeEvent(
				"assistant",
				eventType,
				event,
			);
			this.setProgress("assistant", eventType, chunk || null, event);
			return;
		}
		if (eventType === "agent_thought_chunk" || eventType === "thought") {
			this.thinkingText = mergeStreamText(this.thinkingText, chunk);
			this.ensureStreamIndex("thinking");
			this.thinkingRuntimeEvent = this.runtimeEvent(
				"thinking",
				eventType,
				event,
			);
			this.setProgress("thinking", eventType, chunk || null, event);
			return;
		}
		if (eventType === "tool_call") {
			this.archiveAssistantSegment(event);
			const id =
				text(update.toolCallId) || text(update.tool_call_id) ||
				`grok-${this.toolOrder.length + 1}`;
			this.upsertTool({
				id,
				name:
					text(update.toolName) || text(update.tool) || text(update.title) ||
					"tool",
				input: record(update.rawInput) ?? record(update.input) ?? {},
				status: "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress(
				"tool",
				eventType,
				text(update.toolName) || text(update.title) || "Tool started",
				event,
			);
			return;
		}
		if (eventType === "tool_call_update") {
			const id = text(update.toolCallId) || text(update.tool_call_id);
			if (!id) return;
			const failed = update.status === "failed" || Boolean(update.error);
			this.upsertTool({
				id,
				name:
					this.tools.get(id)?.name || text(update.toolName) || text(update.title) ||
					"tool",
				input:
					this.tools.get(id)?.input ?? record(update.rawInput) ??
					record(update.input) ?? {},
				result: grokToolResult(update),
				isError: failed,
				status: failed ? "failed" : update.status === "completed" ? "done" : "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress(
				"tool",
				eventType,
				text(update.toolName) || text(update.title) || "Tool updated",
				event,
			);
			return;
		}
		if (eventType === "error") {
			this.streamError = text(update.message) || "Grok Build failed";
			this.addRuntimeNote("warning", eventType, this.streamError, event);
			this.setProgress("warning", eventType, this.streamError, event);
			return;
		}
		if (eventType === "end" || eventType === "turn_completed") {
			if (this.completed) {
				this.setProgress("completed", eventType, "Grok Build completed", event);
				return;
			}
			this.completed = true;
			this.usage = normalizedUsage(update.usage);
			if (this.streamError) {
				this.addRuntimeNote(
					"recovery",
					"turn.recovered",
					"Grok Build recovered from the stream interruption",
					event,
				);
			}
			const message = "Grok Build completed";
			this.addRuntimeNote("completed", eventType, message, event);
			this.setProgress("completed", eventType, message, event);
		}
	}

	private pushCursor(event: Record<string, unknown>) {
		const params = record(event.params);
		const update = record(params?.update) ?? record(event.update) ?? event;
		const eventType = text(update.sessionUpdate) || text(update.type) || text(event.method) || text(event.type);
		const content = record(update.content);
		const chunk = text(content?.text) || text(update.text) || text(update.data);
		const observedSessionId = text(params?.sessionId) || text(update.sessionId) || text(event.sessionId);
		if (observedSessionId) this.sessionId = observedSessionId;
		if (eventType === "agent_message_chunk" || eventType === "text") {
			this.assistantText = mergeStreamText(this.assistantText, chunk);
			this.ensureStreamIndex(this.assistantStreamKey());
			this.assistantRuntimeEvent = this.runtimeEvent("assistant", eventType, event);
			this.setProgress("assistant", eventType, chunk || null, event);
			return;
		}
		if (eventType === "agent_thought_chunk" || eventType === "thought") {
			this.thinkingText = mergeStreamText(this.thinkingText, chunk);
			this.ensureStreamIndex("thinking");
			this.thinkingRuntimeEvent = this.runtimeEvent("thinking", eventType, event);
			this.setProgress("thinking", eventType, chunk || null, event);
			return;
		}
		if (eventType === "tool_call" || eventType === "tool_call_update") {
			this.archiveAssistantSegment(event);
			const id = text(update.toolCallId) || text(update.tool_call_id) || `cursor-${this.toolOrder.length + 1}`;
			const failed = update.status === "failed" || Boolean(update.error);
			this.upsertTool({
				id,
				name: this.tools.get(id)?.name || text(update.toolName) || text(update.name) || text(update.title) || "tool",
				input: record(update.rawInput) ?? record(update.input) ?? record(update.arguments) ?? this.tools.get(id)?.input ?? {},
				...(eventType === "tool_call_update" ? { result: update.result ?? update.output ?? update.rawOutput ?? update.content ?? "" } : {}),
				isError: failed,
				status: failed ? "failed" : update.status === "completed" ? "done" : "running",
				runtimeEvent: this.runtimeEvent("tool", eventType, event),
			});
			this.setProgress("tool", eventType, text(update.toolName) || text(update.title) || "Cursor tool", event);
			return;
		}
		if (eventType === "session_info_update" || eventType === "available_commands_update" || eventType === "current_mode_update" || eventType === "config_option_update") {
			const message = eventType === "available_commands_update" ? "Cursor commands loaded" : `Cursor ${eventType.replaceAll("_", " ")}`;
			this.addRuntimeNote("status", eventType, message, event);
			this.setProgress("status", eventType, message, event);
			return;
		}
		if (eventType === "error" || update.error) {
			const message = text(update.message) || text(record(update.error)?.message) || "Cursor failed";
			this.streamError = message;
			this.addRuntimeNote("warning", eventType || "error", message, event);
			this.setProgress("warning", eventType || "error", message, event);
			return;
		}
		if (eventType === "end" || eventType === "turn_completed") {
			this.completed = true;
			this.usage = normalizedUsage(update.usage);
			const message = "Cursor completed";
			this.addRuntimeNote("completed", eventType, message, event);
			this.setProgress("completed", eventType, message, event);
		}
	}

	snapshotContent(): ContentBlock[] {
		const blocks: ContentBlock[] = this.runtimeNotes.map((block) => ({
			...block,
			...(block._meta ? { _meta: structuredClone(block._meta) } : {}),
		}));
		if (this.thinkingText.trim()) {
			const streamIndex = this.ensureStreamIndex("thinking");
			blocks.push({
				type: "thinking",
				thinking: this.thinkingText,
				...(this.thinkingRuntimeEvent
					? {
							_meta: {
								runtimeEvent: this.thinkingRuntimeEvent,
								streamIndex,
							},
						}
					: { _meta: { streamIndex } }),
			});
		}
		for (const id of this.toolOrder) {
			const tool = this.tools.get(id);
			if (!tool) continue;
			const timing = tool.runtimeEvent?.at
				? tool.status === "running"
					? { startedAt: tool.runtimeEvent.at }
					: { completedAt: tool.runtimeEvent.at }
				: undefined;
			blocks.push({
				type: "tool_use",
				id,
				name: tool.name,
				input: tool.input,
				_meta: {
					streamIndex: this.ensureStreamIndex(`tool-use:${id}`),
					toolStatus: tool.status ?? (tool.result === undefined ? "running" : "done"),
					...(timing ? { timing } : {}),
					...(tool.runtimeEvent ? { runtimeEvent: tool.runtimeEvent } : {}),
				},
			});
			blocks.push({
				type: "tool_result",
				tool_use_id: id,
				content: toolResultContent(tool.result),
				is_error: tool.isError,
				_meta: {
					streamIndex: this.ensureStreamIndex(`tool-result:${id}`),
					toolStatus:
						tool.status ?? (tool.result === undefined ? "running" : tool.isError ? "failed" : "done"),
					...(timing ? { timing } : {}),
					...(tool.runtimeEvent ? { runtimeEvent: tool.runtimeEvent } : {}),
				},
			});
		}
		if (this.assistantText.trim()) {
			const streamIndex = this.ensureStreamIndex(this.assistantStreamKey());
			blocks.push({
				type: "text",
				text: this.assistantText,
				...(this.assistantRuntimeEvent
					? {
							_meta: {
								runtimeEvent: this.assistantRuntimeEvent,
								streamIndex,
							},
						}
					: { _meta: { streamIndex } }),
			});
		}
		return blocks.sort((left, right) => {
			const leftIndex = Number(left._meta?.streamIndex ?? 0);
			const rightIndex = Number(right._meta?.streamIndex ?? 0);
			return leftIndex - rightIndex;
		});
	}

	result(): ExternalHarnessResult {
		if (this.terminalError) throw new Error(this.terminalError);
		if (!this.completed) {
			if (this.streamError) throw new Error(this.streamError);
			throw new Error(`${this.harness} stream ended without completion`);
		}
		const blocks = this.snapshotContent();
		if (blocks.length === 0) throw new Error(`${this.harness} returned no content`);
		return {
			content: blocks,
			externalSessionId: this.sessionId,
			provider: this.harness,
			model: this.model,
			stopReason: "stop",
			usage: this.usage,
			thinkingLevel: this.thinkingLevel,
		};
	}
}

export function buildHarnessArgv(input: {
	harness: Exclude<AgentHarness, "pi">;
	prompt: string;
	externalSessionId: string | null;
	cohubSessionId: string;
	accessMode: AccessMode;
	model: string;
	thinkingLevel: string;
	serviceTier?: string | null;
	writableRoots?: readonly string[];
	grokSandboxProfile?: string;
}): string[] {
	if (!input.model.trim()) throw new Error("external harness model is required");
	if (!input.thinkingLevel.trim()) {
		throw new Error("external harness thinking level is required");
	}
	if (input.harness === "codex") {
		const writableRootArgs = input.writableRoots?.length
			? [
					"-c",
					`sandbox_workspace_write.writable_roots=${JSON.stringify(input.writableRoots)}`,
				]
			: [];
		const serviceTierArgs = input.serviceTier
			? ["-c", `service_tier="${input.serviceTier}"`]
			: [];
		if (input.externalSessionId) {
			return [
				"codex",
				"exec",
				"resume",
				"-m",
				input.model,
				"-c",
				`sandbox_mode="${input.accessMode === "read_only" ? "read-only" : "workspace-write"}"`,
				"-c",
				`model_reasoning_effort="${input.thinkingLevel}"`,
				...writableRootArgs,
				...serviceTierArgs,
				"--json",
				"--skip-git-repo-check",
				input.externalSessionId,
				input.prompt,
			];
		}
		return [
			"codex",
			"exec",
			"--json",
			"--skip-git-repo-check",
			"-m",
			input.model,
			"-c",
			`model_reasoning_effort="${input.thinkingLevel}"`,
			...writableRootArgs,
			...serviceTierArgs,
			"--sandbox",
			input.accessMode === "read_only" ? "read-only" : "workspace-write",
			input.prompt,
		];
	}
	if (input.harness === "cursor") {
		if (input.serviceTier) throw new Error("Cursor does not support a service tier");
		return [
			"agent",
			"--sandbox",
			"enabled",
			...(input.writableRoots ?? []).flatMap((root) => ["--add-dir", root]),
			"acp",
		];
	}
	if (input.serviceTier) {
		throw new Error("Grok Build does not support a service tier");
	}

	const common = [
		"grok",
		"--sandbox",
		input.accessMode === "read_only"
			? "read-only"
			: input.grokSandboxProfile ?? "workspace",
		"--model",
		input.model,
		"--reasoning-effort",
		input.thinkingLevel,
		"--output-format",
		"streaming-json",
		"--no-alt-screen",
	];
	if (input.accessMode === "read_only") {
		common.push("--tools", "read_file,grep,list_dir,web_search,web_fetch");
	} else {
		common.push("--always-approve");
	}
	if (input.externalSessionId) common.push("--resume", input.externalSessionId);
	else common.push("--session-id", input.cohubSessionId);
	common.push("-p", input.prompt);
	return common;
}
