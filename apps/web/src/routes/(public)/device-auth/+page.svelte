<script lang="ts">
import { ArrowRight, Check, Copy, Loader2 } from "lucide-svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { env } from "$env/dynamic/public";
import {
	markAuthJustCompleted,
	sanitizeRedirectPath,
	setAuthToken,
} from "$lib/auth";
import {
	beginPersonalNodeDeviceAuthorization,
	type PersonalNodeDeviceAuthorization,
	persistPersonalNodeToken,
	pollPersonalNodeDeviceAuthorization,
} from "$lib/personal-node-auth";

let authorization = $state<PersonalNodeDeviceAuthorization | null>(null);
let error = $state("");
let copied = $state(false);
let cancelled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const apiOrigin = (env.PUBLIC_API_ORIGIN ?? "").trim();

const redirectPath = $derived(
	sanitizeRedirectPath(page.url.searchParams.get("redirect_path") ?? "/"),
);

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
}

async function validateToken(accessToken: string) {
	const response = await fetch(`${apiOrigin}/api/alpha/v1/account`, {
		headers: { authorization: `Bearer ${accessToken}` },
		credentials: "omit",
		cache: "no-store",
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			message?: unknown;
		} | null;
		throw new Error(
			typeof body?.message === "string"
				? body.message
				: `Cohub rejected the sign-in (${response.status})`,
		);
	}
}

async function start() {
	try {
		authorization = await beginPersonalNodeDeviceAuthorization(apiOrigin);
		let intervalMs = authorization.intervalSeconds * 1_000;
		const expiresAt = Date.now() + authorization.expiresInSeconds * 1_000;
		while (!cancelled && Date.now() < expiresAt) {
			await delay(intervalMs);
			if (cancelled) return;
			const result = await pollPersonalNodeDeviceAuthorization(
				apiOrigin,
				authorization.deviceCode,
			);
			if (result.status === "pending") continue;
			if (result.status === "slow_down") {
				intervalMs += 5_000;
				continue;
			}
			await validateToken(result.accessToken);
			persistPersonalNodeToken(result);
			setAuthToken(result.accessToken);
			markAuthJustCompleted();
			window.location.replace(
				new URL(redirectPath, window.location.origin).toString(),
			);
			return;
		}
		if (!cancelled) error = "Sign-in expired. Start again.";
	} catch (caught) {
		if (!cancelled) {
			error = caught instanceof Error ? caught.message : "Sign-in failed";
		}
	}
}

async function copyCode() {
	if (!authorization) return;
	await navigator.clipboard.writeText(authorization.userCode);
	copied = true;
	setTimeout(() => {
		copied = false;
	}, 1_500);
}

onMount(() => {
	void start();
	return () => {
		cancelled = true;
		if (timer) clearTimeout(timer);
	};
});
</script>

<svelte:head>
	<title>Sign in - Cohub</title>
</svelte:head>

<main class="device-auth-page">
	<section class="device-auth-panel" aria-live="polite">
		<div class="brand-mark">C</div>
		<h1>Sign in to Cohub</h1>

		{#if error}
			<p class="error-message">{error}</p>
			<button type="button" class="secondary-button" onclick={() => location.reload()}>
				Try again
			</button>
		{:else if authorization}
			<p class="instruction">Open Cohub sign-in and confirm this code.</p>
			<button type="button" class="device-code" onclick={copyCode} aria-label="Copy sign-in code">
				<span>{authorization.userCode}</span>
				{#if copied}
					<Check class="h-4 w-4" />
				{:else}
					<Copy class="h-4 w-4" />
				{/if}
			</button>
			<a
				class="primary-button"
				href={authorization.verificationUriComplete}
				target="_blank"
				rel="noopener noreferrer"
			>
				Continue to sign in
				<ArrowRight class="h-4 w-4" />
			</a>
			<p class="waiting"><Loader2 class="h-4 w-4 animate-spin" /> Waiting for confirmation</p>
		{:else}
			<p class="waiting"><Loader2 class="h-4 w-4 animate-spin" /> Preparing sign-in</p>
		{/if}
	</section>
</main>

<style>
	.device-auth-page {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
		background: var(--color-bg-page);
		color: var(--color-text-primary);
	}

	.device-auth-panel {
		width: min(100%, 24rem);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		padding: 2rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-surface);
		box-shadow: var(--shadow-lg);
		text-align: center;
	}

	.brand-mark {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 7px;
		background: var(--color-brand);
		color: var(--color-brand-contrast-fg);
		font-weight: 650;
	}

	h1 {
		font-size: 1.25rem;
		font-weight: 650;
		line-height: 1.4;
	}

	.instruction,
	.waiting {
		color: var(--color-text-tertiary);
		font-size: 0.875rem;
	}

	.waiting {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.device-code {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		width: 100%;
		min-height: 3rem;
		border: 1px solid var(--color-border-strong);
		border-radius: 6px;
		background: var(--color-bg-page);
		font-family: var(--font-mono);
		font-size: 1.125rem;
		font-weight: 600;
		letter-spacing: 0;
	}

	.primary-button,
	.secondary-button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		width: 100%;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.primary-button {
		background: var(--color-brand);
		color: var(--color-brand-contrast-fg);
	}

	.secondary-button {
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg-surface);
	}

	.error-message {
		color: var(--color-error-soft);
		font-size: 0.875rem;
		line-height: 1.5;
	}
</style>
