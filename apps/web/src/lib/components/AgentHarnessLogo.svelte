<script lang="ts">
import type { AgentHarness } from "@neta-art/cohub";
import { getAgentHarnessLogoAssets } from "$lib/agent-harness-logo";

const {
	harness,
	class: className = "h-4 w-4",
}: {
	harness: AgentHarness;
	class?: string;
} = $props();

const assets = $derived(getAgentHarnessLogoAssets(harness));
const usesMonochromeMask = $derived(harness !== "codex");
</script>

<span class={`agent-harness-logo inline-flex shrink-0 items-center justify-center ${className}`} aria-hidden="true">
	{#if usesMonochromeMask}
		<span
			class="harness-logo-mask h-full w-full"
			style={`--harness-logo-mask: url("${assets.light}")`}
		></span>
	{:else}
		<img src={assets.light} alt="" class="h-full w-full object-contain harness-logo-on-light" draggable="false" />
		<img src={assets.dark} alt="" class="h-full w-full object-contain harness-logo-on-dark" draggable="false" />
	{/if}
</span>

<style>
	.harness-logo-mask {
		background: var(--text-secondary);
		-webkit-mask: var(--harness-logo-mask) center / contain no-repeat;
		mask: var(--harness-logo-mask) center / contain no-repeat;
	}

	.harness-logo-on-dark {
		display: none;
	}

	:global([data-theme="dark"]) .harness-logo-on-light,
	:global([data-theme="solarized-dark"]) .harness-logo-on-light,
	:global([data-theme="neta-studio"]) .harness-logo-on-light {
		display: none;
	}

	:global([data-theme="dark"]) .harness-logo-on-dark,
	:global([data-theme="solarized-dark"]) .harness-logo-on-dark,
	:global([data-theme="neta-studio"]) .harness-logo-on-dark {
		display: block;
	}
</style>
