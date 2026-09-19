<script lang="ts">
import { RefreshCw, TerminalSquare } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { getAuthToken, sanitizeRedirectPath } from "$lib/auth";

let checking = $state(false);
let error = $state("");

async function checkConnection() {
	if (checking) return;
	checking = true;
	error = "";
	try {
		const token = await getAuthToken({ forceRefresh: true });
		if (!token) {
			error = "Cloud account is not connected on this host.";
			return;
		}
		const destination = sanitizeRedirectPath(
			page.url.searchParams.get("redirect_path") ?? "/",
		);
		await goto(destination, { replaceState: true });
	} catch (cause) {
		error = cause instanceof Error ? cause.message : "Connection check failed";
	} finally {
		checking = false;
	}
}

onMount(() => {
	void checkConnection();
});
</script>

<svelte:head>
	<title>Connect Cohub</title>
</svelte:head>

<main class="mx-auto flex min-h-[100dvh] w-full max-w-xl flex-col justify-center px-6 py-16">
	<div class="flex items-center gap-3 text-text-secondary">
		<TerminalSquare class="h-5 w-5 text-brand" />
		<span class="font-mono text-[12px] font-medium uppercase">Local Mode</span>
	</div>
	<h1 class="mt-5 text-2xl font-semibold text-text-primary">Connect your Cohub account</h1>
	<p class="mt-3 max-w-md text-[14px] leading-6 text-text-tertiary">
		Run <code class="rounded-[4px] bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-secondary">cohub auth login</code> on the Mac mini, then check again.
	</p>
	{#if error}
		<p class="mt-4 text-[13px] text-error-soft" role="alert">{error}</p>
	{/if}
	<button
		type="button"
		class="mt-6 inline-flex min-h-9 w-fit items-center gap-2 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover disabled:opacity-50"
		disabled={checking}
		onclick={checkConnection}
	>
		<RefreshCw class={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
		{checking ? "Checking" : "Check again"}
	</button>
</main>
