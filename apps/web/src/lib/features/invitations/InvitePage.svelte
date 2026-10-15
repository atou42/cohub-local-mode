<script lang="ts">
import { buildSpaceInvitePath, buildSpacePath } from "@neta-art/cohub";
import {
	ArrowRight,
	Check,
	Clock,
	Loader2,
	ShieldAlert,
	Users,
} from "lucide-svelte";
import { onMount } from "svelte";
import { goto, replaceState } from "$app/navigation";
import { ensureAuth } from "$lib/auth";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

const props = $props<{ token: string }>();

const token = $derived(props.token);

type InviteStatus = "loading" | "valid" | "expired" | "error";
type ActionStatus = "idle" | "joining" | "joined" | "error";

let inviteStatus = $state<InviteStatus>("loading");
let spaceName = $state("");
let spaceId = $state("");
let role = $state<"host" | "builder" | "guest">("builder");
let expiresInSeconds = $state<number | null>(null);
let ownerUsername = $state<string | null>(null);
let spaceSlug = $state<string | null>(null);
let invitePath = $state("");
let errorMessage = $state("");

let actionStatus = $state<ActionStatus>("idle");
let actionError = $state("");

// Auth check + load invite
onMount(async () => {
	try {
		const detail = await sdk.invite.get(token);
		spaceName = detail.spaceName;
		spaceId = detail.spaceId;
		role = detail.role;
		expiresInSeconds = detail.expiresInSeconds;
		ownerUsername = detail.ownerUsername;
		spaceSlug = detail.spaceSlug;
		invitePath = buildSpaceInvitePath({
			spaceId: detail.spaceId,
			ownerUsername: detail.ownerUsername,
			spaceSlug: detail.spaceSlug,
			inviteCode: token,
		});
		if (window.location.pathname !== invitePath) replaceState(invitePath, {});
		inviteStatus = "valid";
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Failed to load invitation";
		// 410 = expired/revoked
		if (
			message.includes("410") ||
			(err instanceof Error && (err as { status?: number }).status === 410)
		) {
			inviteStatus = "expired";
		} else {
			inviteStatus = "error";
			errorMessage = message;
		}
	}
});

const roleLabel = $derived(
	role === "host" ? "Host" : role === "builder" ? "Builder" : "Guest",
);

const expiresLabel = $derived(
	expiresInSeconds !== null ? formatExpires(expiresInSeconds) : null,
);

function formatExpires(seconds: number): string {
	if (seconds <= 0) return "Expired";
	if (seconds < 3600) return `${Math.ceil(seconds / 60)} minutes remaining`;
	if (seconds < 86400) return `${Math.ceil(seconds / 3600)} hours remaining`;
	return `${Math.ceil(seconds / 86400)} days remaining`;
}

async function handleAccept() {
	if (actionStatus !== "idle") return;
	actionError = "";
	actionStatus = "joining";

	try {
		await authStore.ensureLoaded();
		if (!authStore.isAuthenticated) {
			// Redirect to login, then come back
			await ensureAuth({ redirectPath: invitePath });
			return;
		}

		const result = await sdk.invite.accept(token);
		actionStatus = "joined";

		// Redirect to the space after a short delay
		setTimeout(() => {
			void goto(buildSpacePath(result));
		}, 1500);
	} catch (err: unknown) {
		actionStatus = "error";
		const message =
			err instanceof Error ? err.message : "Failed to accept invitation";
		// If already a member, redirect to space
		if (message.includes("409") || message.includes("already a member")) {
			actionStatus = "joined";
			actionError = "Already a member — redirecting to space...";
			setTimeout(() => {
				void goto(
					spaceId ? buildSpacePath({ spaceId, ownerUsername, spaceSlug }) : "/",
				);
			}, 1500);
			return;
		}
		actionError = message;
	}
}
</script>

<div class="min-h-screen flex items-center justify-center bg-bg-primary px-4">
	<div class="w-full max-w-md">
		<!-- Logo / Brand -->
		<div class="text-center mb-8">
			<div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand/10 mb-4">
				<Users class="w-7 h-7 text-brand" />
			</div>
			<h1 class="text-xl font-semibold text-text-primary">
				{#if inviteStatus === "loading"}
					Loading invitation...
				{:else if inviteStatus === "valid"}
					You're invited!
				{:else if inviteStatus === "expired"}
					Link expired
				{:else}
					Something went wrong
				{/if}
			</h1>
		</div>

		{#if inviteStatus === "loading"}
			<!-- Loading state -->
			<div class="flex flex-col items-center gap-3 text-text-tertiary py-8">
				<Loader2 class="w-6 h-6 animate-spin" />
				<p class="text-sm">Checking invitation...</p>
			</div>

		{:else if inviteStatus === "expired"}
			<!-- Expired state -->
			<div class="bg-bg-surface border border-border-subtle rounded-xl p-6 text-center">
				<div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-error-soft/20 mb-4">
					<Clock class="w-6 h-6 text-error-soft" />
				</div>
				<p class="text-sm text-text-secondary mb-2">
					This invitation link has expired or been revoked.
				</p>
				<p class="text-xs text-text-tertiary">
					Ask the space owner to send you a new invitation.
				</p>
			</div>

		{:else if inviteStatus === "error"}
			<!-- Error state -->
			<div class="bg-bg-surface border border-border-subtle rounded-xl p-6 text-center">
				<div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-error-soft/20 mb-4">
					<ShieldAlert class="w-6 h-6 text-error-soft" />
				</div>
				<p class="text-sm text-text-secondary mb-2">
					{errorMessage || "Unable to load this invitation."}
				</p>
			</div>

		{:else if inviteStatus === "valid"}
			<!-- Valid invitation card -->
			<div class="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
				<!-- Space info -->
				<div class="p-6 border-b border-border-subtle">
					<div class="flex items-center gap-3 mb-4">
						<div class="flex-1 min-w-0">
							<p class="text-xs text-text-tertiary uppercase tracking-wider mb-1">Space</p>
							<p class="text-base font-medium text-text-primary truncate">{spaceName}</p>
						</div>
					</div>

					<div class="flex items-center gap-4">
						<div class="flex-1">
							<p class="text-xs text-text-tertiary uppercase tracking-wider mb-1">Role</p>
							<span class="inline-flex items-center px-2.5 py-1 rounded-md bg-brand/10 text-brand text-xs font-medium">
								{roleLabel}
							</span>
						</div>
						{#if expiresLabel}
							<div class="flex-1">
								<p class="text-xs text-text-tertiary uppercase tracking-wider mb-1">Expires</p>
								<span class="text-xs text-text-secondary">{expiresLabel}</span>
							</div>
						{/if}
					</div>
				</div>

				<!-- Action area -->
				<div class="p-6">
					{#if actionStatus === "idle"}
						<button
							type="button"
							class="primary-key w-full gap-2 rounded-lg px-4 py-3 text-sm"
							onclick={() => void handleAccept()}
						>
							<ArrowRight class="w-4 h-4" />
							Accept & Join
						</button>

					{:else if actionStatus === "joining"}
						<button
							type="button"
							disabled
							class="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg bg-brand/50 text-brand-contrast-fg text-sm font-medium cursor-wait"
						>
							<Loader2 class="w-4 h-4 animate-spin" />
							Joining...
						</button>

					{:else if actionStatus === "joined"}
						<div class="flex flex-col items-center gap-2 py-2">
							<div class="flex items-center justify-center w-10 h-10 rounded-full bg-success-soft/20">
								<Check class="w-5 h-5 text-success-soft" />
							</div>
							<p class="text-sm text-text-secondary">Joined successfully!</p>
							<p class="text-xs text-text-tertiary">Redirecting to space...</p>
						</div>

					{:else if actionStatus === "error"}
						<div>
							<p class="text-sm text-error-soft text-center mb-3">{actionError}</p>
							<button
								type="button"
								class="primary-key w-full gap-2 rounded-lg px-4 py-3 text-sm"
								onclick={() => { actionStatus = "idle"; actionError = ""; }}
							>
								Try again
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Footer -->
		<div class="text-center mt-8">
			<a href="/" class="text-xs text-text-tertiary hover:text-text-secondary transition-colors">
				Back to home
			</a>
		</div>
	</div>
</div>
