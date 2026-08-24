import type { AgentHarness } from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";

export type AccessMode = "read_only" | "full_access";

type ToolSnapshot = {
	id: string;
	name: string;
	input: Record<string, unknown>;
	result?: unknown;
	isError?: boolean;
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

export class HarnessEventReducer {
	readonly harness: Exclude<AgentHarness, "pi">;
	readonly model: string;
	readonly thinkingLevel: string;
	private assistantText = "";
	private thinkingText = "";
	private tools = new Map<string, ToolSnapshot>();
	private toolOrder: string[] = [];
	private fatalError: string | null = null;
	private completed = false;
	private sessionId: string | null = null;
	private usage: Usage | null = null;

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

	push(value: unknown) {
		const event = record(value);
		if (!event) return;
		if (this.harness === "codex") this.pushCodex(event);
		else this.pushGrok(event);
	}

	private upsertTool(tool: ToolSnapshot) {
		if (!this.tools.has(tool.id)) this.toolOrder.push(tool.id);
		this.tools.set(tool.id, { ...this.tools.get(tool.id), ...tool });
	}

	private pushCodex(event: Record<string, unknown>) {
		const eventType = text(event.type);
		if (eventType === "thread.started") {
			this.sessionId = text(event.thread_id) || this.sessionId;
			return;
		}
		if (eventType === "error" || eventType === "turn.failed") {
			const error = record(event.error);
			this.fatalError = text(event.message) || text(error?.message) || eventType;
			return;
		}
		if (eventType === "turn.completed") {
			this.completed = true;
			this.usage = normalizedUsage(event.usage);
			return;
		}
		if (eventType !== "item.completed") return;
		const item = record(event.item);
		if (!item) return;
		const itemType = text(item.type);
		const id = text(item.id) || `codex-${this.toolOrder.length + 1}`;
		if (itemType === "agent_message") {
			this.assistantText += text(item.text);
			return;
		}
		if (itemType === "reasoning") {
			this.thinkingText += text(item.text);
			return;
		}
		if (itemType === "command_execution") {
			this.upsertTool({
				id,
				name: "bash",
				input: { command: item.command ?? item.commands ?? "" },
				result: item.aggregated_output ?? item.output ?? "",
				isError: typeof item.exit_code === "number" && item.exit_code !== 0,
			});
			return;
		}
		if (itemType === "file_change") {
			this.upsertTool({
				id,
				name: "apply_patch",
				input: { changes: item.changes ?? [] },
				result: item.status ?? "completed",
				isError: item.status === "failed",
			});
			return;
		}
		if (itemType === "mcp_tool_call") {
			this.upsertTool({
				id,
				name: text(item.tool) || text(item.name) || "mcp",
				input: record(item.arguments) ?? record(item.input) ?? {},
				result: item.result ?? item.output ?? "",
				isError: item.status === "failed" || Boolean(item.error),
			});
		}
	}

	private pushGrok(event: Record<string, unknown>) {
		const update = record(record(event.params)?.update) ?? record(event.update) ?? event;
		const eventType = text(update.sessionUpdate) || text(update.type) || text(event.type);
		const content = record(update.content);
		const chunk = text(content?.text) || text(update.data) || text(update.text);
		const observedSessionId =
			text(update.sessionId) || text(event.sessionId) || text(update.session_id);
		if (observedSessionId) this.sessionId = observedSessionId;

		if (eventType === "agent_message_chunk" || eventType === "text") {
			this.assistantText += chunk;
			return;
		}
		if (eventType === "agent_thought_chunk" || eventType === "thought") {
			this.thinkingText += chunk;
			return;
		}
		if (eventType === "tool_call") {
			const id =
				text(update.toolCallId) || text(update.tool_call_id) ||
				`grok-${this.toolOrder.length + 1}`;
			this.upsertTool({
				id,
				name:
					text(update.toolName) || text(update.tool) || text(update.title) ||
					"tool",
				input: record(update.rawInput) ?? record(update.input) ?? {},
			});
			return;
		}
		if (eventType === "tool_call_update") {
			const id = text(update.toolCallId) || text(update.tool_call_id);
			if (!id) return;
			this.upsertTool({
				id,
				name:
					this.tools.get(id)?.name || text(update.toolName) || text(update.title) ||
					"tool",
				input:
					this.tools.get(id)?.input ?? record(update.rawInput) ??
					record(update.input) ?? {},
				result: update.rawOutput ?? update.content ?? update.output ?? "",
				isError: update.status === "failed" || Boolean(update.error),
			});
			return;
		}
		if (eventType === "error") {
			this.fatalError = text(update.message) || "Grok Build failed";
			return;
		}
		if (eventType === "end" || eventType === "turn_completed") {
			this.completed = true;
			this.usage = normalizedUsage(update.usage);
		}
	}

	result(): ExternalHarnessResult {
		if (this.fatalError) throw new Error(this.fatalError);
		if (!this.completed) throw new Error(`${this.harness} stream ended without completion`);
		const blocks: ContentBlock[] = [];
		if (this.thinkingText.trim()) {
			blocks.push({ type: "thinking", thinking: this.thinkingText });
		}
		for (const id of this.toolOrder) {
			const tool = this.tools.get(id);
			if (!tool) continue;
			blocks.push({ type: "tool_use", id, name: tool.name, input: tool.input });
			if (tool.result !== undefined) {
				blocks.push({
					type: "tool_result",
					tool_use_id: id,
					content: toolResultContent(tool.result),
					is_error: tool.isError,
				});
			}
		}
		if (this.assistantText.trim()) blocks.push({ type: "text", text: this.assistantText });
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
}): string[] {
	if (!input.model.trim()) throw new Error("external harness model is required");
	if (!input.thinkingLevel.trim()) {
		throw new Error("external harness thinking level is required");
	}
	if (input.harness === "codex") {
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
			"--sandbox",
			input.accessMode === "read_only" ? "read-only" : "workspace-write",
			input.prompt,
		];
	}

	const common = [
		"grok",
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
