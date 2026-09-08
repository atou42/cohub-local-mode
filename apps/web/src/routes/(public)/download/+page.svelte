<script lang="ts">
import { ArrowUpRight, Check, Copy, Download, RefreshCw } from "lucide-svelte";
import { onMount } from "svelte";
import { parseDev2Release, releaseDownloadPath, type Dev2Release } from "../../../../../desktop/distribution/release.mjs";

let release = $state<Dev2Release | null>(null);
let loading = $state(false);
let failure = $state("");
let copied = $state(false);
let copyFailure = $state("");
let controller: AbortController | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function loadRelease() {
	if (loading) return;
	loading = true;
	failure = "";
	controller = new AbortController();
	try {
		const response = await fetch("/downloads/latest.json", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
		if (!response.ok) throw new Error("The Mac installer is temporarily unavailable.");
		release = parseDev2Release(await response.json());
	} catch (error) {
		if (!controller.signal.aborted) failure = error instanceof Error ? error.message : "The release could not be loaded.";
	} finally {
		loading = false;
	}
}

async function copyChecksum() {
	if (!release) return;
	copyFailure = "";
	try {
		await navigator.clipboard.writeText(release.sha256);
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => { copied = false; }, 2500);
	} catch {
		copyFailure = "Could not copy the checksum.";
	}
}

onMount(() => {
	void loadRelease();
	return () => { controller?.abort(); clearTimeout(copyTimer); };
});
</script>

<svelte:head>
	<title>Cohub Dev2 for Mac</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="description" content="Download the Cohub Dev2 developer preview for Apple Silicon Macs." />
</svelte:head>

<div class="mx-auto w-full max-w-3xl px-5 sm:px-8">
	<header class="flex min-h-20 items-center justify-between gap-4 border-b border-border-subtle">
		<a href="/sessions" class="flex items-center gap-2.5 text-[14px] font-semibold text-text-primary">
			<img src="/pwa/app-icon-192x192.png" alt="" width="28" height="28" class="h-7 w-7 rounded-[6px]" />
			Cohub
		</a>
		<a href="/sessions" class="inline-flex min-h-10 items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
			Open Dev2 <ArrowUpRight class="h-4 w-4" />
		</a>
	</header>
	<main class="py-9 sm:py-12">
		<p class="text-[12px] font-medium text-brand">Developer preview</p>
		<h1 class="mt-2 text-[32px] font-semibold leading-tight text-text-primary">Cohub Dev2</h1>
		<p class="mt-3 text-[15px] text-text-secondary">Mac installer &middot; Apple Silicon</p>

		<section class="mt-8 border-y border-border-subtle py-6" aria-label="Current release">
			{#if release}
				<div class="flex flex-wrap items-center justify-between gap-5">
					<div>
						<p class="text-[14px] font-medium text-text-primary">{release.version}</p>
						<p class="mt-1 text-[12px] text-text-tertiary">{(release.bytes / 1_000_000).toFixed(1)} MB &middot; macOS {release.minimumSystemVersion} or later</p>
					</div>
					<a href={releaseDownloadPath(release)} download={release.filename} class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[6px] bg-brand px-4 text-[13px] font-medium text-brand-contrast-fg hover:bg-brand-hover sm:w-auto">
						<Download class="h-4 w-4" /> Download for Mac
					</a>
				</div>
				<p class="mt-5 text-[12px] leading-5 text-text-secondary">Not notarized. macOS may require approval in Privacy &amp; Security.</p>
			{:else if failure}
				<p class="text-[13px] text-error-soft" role="alert">{failure}</p>
				<button type="button" onclick={loadRelease} disabled={loading} class="mt-3 inline-flex min-h-10 items-center gap-2 rounded-[6px] border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-bg-hover">
					<RefreshCw class="h-3.5 w-3.5" /> Try again
				</button>
			{:else}
				<p class="py-6 text-[13px] text-text-tertiary" role="status">Checking the latest release...</p>
			{/if}
		</section>

		<p class="mt-5 text-[12px] leading-5 text-text-tertiary">Dev2 release only. Existing local data stays in place after an upgrade.</p>

		{#if release}
			<section class="mt-7 border-t border-border-subtle pt-5" aria-label="Installer verification">
				<div class="flex items-center justify-between gap-3">
					<h2 class="text-[12px] font-medium text-text-secondary">SHA-256</h2>
					<button type="button" onclick={copyChecksum} title={copied ? "Checksum copied" : "Copy checksum"} aria-label={copied ? "Checksum copied" : "Copy checksum"} class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary">
						{#if copied}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if}
					</button>
				</div>
				<code class="mt-1 block break-all font-mono text-[11px] leading-5 text-text-tertiary">{release.sha256}</code>
				<p class="mt-1 min-h-5 text-[11px] text-text-tertiary" aria-live="polite">{copyFailure || (copied ? "Checksum copied." : "")}</p>
			</section>
		{/if}
	</main>
</div>
