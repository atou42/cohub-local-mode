<script lang="ts">
import { ChevronDown, LoaderCircle } from "lucide-svelte";
import {
	formatCompactControlMeta,
	formatCompactModelLabel,
	getCompactControlMetaTone,
} from "$lib/compact-control-labels";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	label,
	meta = [],
	ariaLabel,
	disabled = false,
	expanded,
	loading = false,
	onclick,
}: {
	label: string;
	meta?: string[];
	ariaLabel?: string;
	disabled?: boolean;
	expanded?: boolean;
	loading?: boolean;
	onclick: () => void;
} = $props();

const locale = $derived(getLocale());
const effectiveAriaLabel = $derived(
	ariaLabel ?? m.composer_model_label({ model: label }, { locale }),
);
const compactLabel = $derived(formatCompactModelLabel(label));
const compactMeta = $derived(
	meta
		.map((value) => ({
			label: formatCompactControlMeta(value),
			tone: getCompactControlMetaTone(value),
		}))
		.filter((item) => Boolean(item.label)),
);

function compactMetaClass(tone: "thinking" | "speed" | "neutral"): string {
	if (tone === "thinking") return "text-warning-soft";
	if (tone === "speed") return "text-success-soft";
	return "text-text-placeholder";
}
</script>

	<button
	type="button"
	class="group flex h-7 max-w-[min(100%,17rem)] items-center gap-0.5 overflow-hidden rounded-full border border-border-subtle px-1.5 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 sm:gap-1 sm:px-2"
	{disabled}
	aria-label={effectiveAriaLabel}
	aria-expanded={expanded}
	{onclick}
>
	{#if loading}<LoaderCircle class="h-3 w-3 shrink-0 animate-spin" />{/if}
	<span class="flex min-w-0 items-baseline gap-0.5 truncate text-text-tertiary transition-colors group-hover:text-text-secondary sm:hidden">
		<span class="min-w-0 shrink-0 truncate">{compactLabel}</span>
		{#each compactMeta as item}
			<span class={`shrink-0 text-[10px] font-semibold ${compactMetaClass(item.tone)}`} aria-hidden="true">{item.label}</span>
		{/each}
	</span>
	<span class="hidden min-w-0 shrink truncate text-text-tertiary transition-colors group-hover:text-text-secondary sm:inline">
		{label}
	</span>
	{#each meta as item}
		<span class="hidden min-w-0 max-w-[6.5rem] shrink-[3] items-baseline gap-0.5 text-[10px] leading-none text-text-placeholder/80 transition-colors group-hover:text-text-placeholder sm:flex" aria-hidden="true">
			<span class="shrink-0 opacity-40">·</span>
			<span class="min-w-0 truncate tabular-nums">{item}</span>
		</span>
	{/each}
	<ChevronDown class="hidden h-3 w-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-65 sm:block" />
</button>
