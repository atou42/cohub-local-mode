<script lang="ts">
import "../../app.css";
import { onMount } from "svelte";
import { page } from "$app/state";
import { markCohubClientHealthy } from "$lib/asset-import-recovery";

const { children } = $props();

/** Public App routes set icons via AppPageHead; others use shell defaults. */
const isPublicAppPath = $derived.by(() => {
	const segments = page.url.pathname.split("/").filter(Boolean);
	return segments.length === 4 && segments[2] === "w";
});

onMount(() => {
	if (page.status < 400) markCohubClientHealthy();
});
</script>

<svelte:head>
	{#if !isPublicAppPath}
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
		<link rel="apple-touch-icon" href="/pwa/icon-192x192.png" />
	{/if}
</svelte:head>

<div class="min-h-screen overflow-x-clip bg-bg-primary text-text-primary">
	{@render children?.()}
</div>
