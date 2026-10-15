<script lang="ts">
import type { Snippet } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { slide } from "svelte/transition";

const {
	title,
	tooltip,
	badge,
	meta,
	lead,
	subtitle,
	status,
}: {
	title: string | Snippet;
	tooltip?: string;
	badge?: Snippet;
	meta?: Snippet;
	lead?: Snippet;
	subtitle?: Snippet;
	status?: Snippet;
} = $props();
</script>

<span class="flex min-w-0 flex-1 flex-col justify-center gap-[var(--list-text-gap)] self-stretch overflow-hidden text-start">
	<span class="list-row-title flex min-w-0 items-center gap-2">
		<span class="flex min-w-0 flex-1 items-center gap-1.5">
			<span class="list-row-title-text min-w-0 truncate" title={tooltip}>{#if typeof title === "string"}{title}{:else}{@render title()}{/if}</span>
			{@render badge?.()}
		</span>
		{#if meta}
			<span class="list-row-meta inline-flex shrink-0 items-center gap-1.5 tabular-nums">{@render meta()}</span>
		{/if}
	</span>
	{#if lead || subtitle || status}
		<span class="list-row-subtitle flex min-w-0 items-center gap-2" transition:slide={{ duration: prefersReducedMotion.current ? 0 : 180 }}>
			{@render lead?.()}
			<span class="min-w-0 flex-1 truncate">{@render subtitle?.()}</span>
			{#if status}
				<span class="inline-flex shrink-0 items-center">{@render status()}</span>
			{/if}
		</span>
	{/if}
</span>

<style>
	.list-row-title {
		font-size: var(--list-title-size);
		line-height: var(--list-title-leading);
	}

	.list-row-title-text {
		color: var(--list-title-color);
		font-weight: var(--list-title-weight);
		transition: color 100ms;
	}

	.list-row-meta {
		color: var(--list-meta-color);
		font-size: var(--list-meta-size);
	}

	.list-row-subtitle {
		height: var(--list-subtitle-leading);
		color: var(--list-subtitle-color);
		font-size: var(--list-subtitle-size);
		line-height: var(--list-subtitle-leading);
	}
</style>
