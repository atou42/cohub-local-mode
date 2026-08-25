<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import {
	Check,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	Loader2,
	Terminal,
} from "lucide-svelte";

type RuntimeEventBlock = Extract<ContentBlock, { type: "system_note" }>;
type RuntimeEvent = {
	kind?: string;
	eventType?: string;
	at?: string;
	raw?: unknown;
};

type Props = {
	blocks: RuntimeEventBlock[];
	isStreaming?: boolean;
};

const { blocks, isStreaming = false }: Props = $props();
let expanded = $state<Record<number, boolean>>({});

function cleanTerminalText(value: string) {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		const isCsi =
			code === 0x9b || (code === 0x1b && value.charCodeAt(index + 1) === 0x5b);
		if (!isCsi) {
			result += value[index];
			continue;
		}
		if (code === 0x1b) index += 1;
		while (index + 1 < value.length) {
			index += 1;
			const next = value.charCodeAt(index);
			if (next >= 0x40 && next <= 0x7e) break;
		}
	}
	return result;
}

function runtimeEvent(block: RuntimeEventBlock): RuntimeEvent {
	const value = block._meta?.runtimeEvent;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RuntimeEvent)
		: {};
}

function rawText(block: RuntimeEventBlock) {
	const raw = runtimeEvent(block).raw;
	if (raw === undefined || raw === null || raw === "") return "";
	if (typeof raw === "string") return cleanTerminalText(raw);
	try {
		return cleanTerminalText(JSON.stringify(raw, null, 2));
	} catch {
		return cleanTerminalText(String(raw));
	}
}

function toggle(index: number) {
	expanded[index] = !expanded[index];
}

function isRunning(kind: string | undefined) {
	return isStreaming && ["starting", "status"].includes(kind ?? "");
}
</script>

<div class="flex flex-col gap-1.5" data-runtime-events>
	{#each blocks as block, index (`${runtimeEvent(block).at ?? "event"}:${index}`)}
		{@const event = runtimeEvent(block)}
		{@const details = rawText(block)}
		<div class="min-w-0 text-[12px] leading-[1.45] text-text-tertiary">
			<div class="flex min-h-6 min-w-0 items-start gap-2 py-0.5">
				<span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
					{#if isRunning(event.kind)}
						<Loader2 class="h-3.5 w-3.5 animate-spin text-status-running motion-reduce:animate-none" />
					{:else if event.kind === "warning"}
						<CircleAlert class="h-3.5 w-3.5 text-warning-soft" />
					{:else if event.kind === "stderr"}
						<Terminal class="h-3.5 w-3.5 text-warning-soft" />
					{:else if event.kind === "completed" || event.kind === "recovery"}
						<Check class="h-3.5 w-3.5 text-status-running" />
					{:else}
						<span class="h-1.5 w-1.5 rounded-full bg-text-placeholder"></span>
					{/if}
				</span>
				<span class="min-w-0 flex-1 break-words" class:text-warning-soft={event.kind === "warning" || event.kind === "stderr"}>{cleanTerminalText(block.text)}</span>
				{#if details}
					<button
						type="button"
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
						title={expanded[index] ? "Hide event details" : "Show event details"}
						aria-label={expanded[index] ? "Hide event details" : "Show event details"}
						aria-expanded={expanded[index] ?? false}
						onclick={() => toggle(index)}
					>
						{#if expanded[index]}
							<ChevronDown class="h-3.5 w-3.5" />
						{:else}
							<ChevronRight class="h-3.5 w-3.5" />
						{/if}
					</button>
				{/if}
			</div>
			{#if details && expanded[index]}
				<pre class="ml-6 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-surface px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-text-secondary">{details}</pre>
			{/if}
		</div>
	{/each}
</div>
