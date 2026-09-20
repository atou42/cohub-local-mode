<script lang="ts">
import { Monitor, RefreshCw, Settings2, X } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { floatNear, portal } from "$lib/actions/portal";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	cachedRuntimeStatus,
	cachedRuntimeStatusFetchedAt,
	refreshRuntimeStatus,
} from "../runtime-status.svelte";
import {
	freshWatcher,
	harnessModelCounts,
	runtimeTone,
} from "../runtime-status-view";

const { spaceId, canManage = false }: { spaceId: string; canManage?: boolean } =
	$props();

const HARNESS_LABELS = { pi: "Pi", codex: "Codex" } as const;

const locale = $derived(getLocale());
const status = $derived(cachedRuntimeStatus(spaceId));

let open = $state(false);
let now = $state(Date.now());
let refreshing = $state(false);
let lastErrorAt = $state<number | null>(null);
let rootEl: HTMLDivElement | null = $state(null);
let popoverEl: HTMLDivElement | null = $state(null);
let lastOpen = false;

const tone = $derived(runtimeTone(status, now));
const fetchedAt = $derived(cachedRuntimeStatusFetchedAt(spaceId));
const failed = $derived(
	lastErrorAt !== null && (fetchedAt ?? 0) <= lastErrorAt,
);
const watcher = $derived(freshWatcher(status, now));
const label = $derived(
	status?.online
		? m.runtime_online({}, { locale })
		: m.runtime_offline({}, { locale }),
);
const harnessSummary = $derived(
	(() => {
		const counts = harnessModelCounts(status);
		return (status?.capabilities?.harnesses ?? [])
			.map((harness) => `${HARNESS_LABELS[harness]} ${counts[harness]}`)
			.join(" · ");
	})(),
);
const watcherLabel = $derived(
	watcher?.state === "running"
		? m.runtime_watcher_running({}, { locale })
		: watcher?.state === "degraded"
			? m.runtime_watcher_degraded({}, { locale })
			: watcher?.state === "unavailable"
				? m.runtime_watcher_unavailable({}, { locale })
				: m.runtime_watcher_unknown({}, { locale }),
);
const watcherDetail = $derived(
	watcher
		? [watcherLabel, watcher.backend, ageLabel(Date.parse(watcher.observedAt))]
				.filter(Boolean)
				.join(" · ")
		: watcherLabel,
);
const updatedLabel = $derived(
	fetchedAt
		? m.runtime_last_updated({ time: ageLabel(fetchedAt) }, { locale })
		: "",
);

function ageLabel(at: number) {
	const ms = now - at;
	if (!Number.isFinite(ms) || ms < 45_000)
		return m.time_just_now({}, { locale });
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return m.time_ago_min({ n: minutes }, { locale });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return m.time_ago_hour({ n: hours }, { locale });
	return m.time_ago_day({ n: Math.round(hours / 24) }, { locale });
}

async function refresh() {
	if (refreshing) return;
	refreshing = true;
	try {
		await refreshRuntimeStatus(spaceId, { force: true });
	} catch {
		lastErrorAt = Date.now();
	} finally {
		refreshing = false;
		now = Date.now();
	}
}

function show() {
	open = true;
	now = Date.now();
	void refresh();
}

$effect(() => {
	const target = spaceId;
	open = false;
	const tick = () => {
		now = Date.now();
		if (document.visibilityState === "visible")
			void refreshRuntimeStatus(target).catch(() => {
				lastErrorAt = Date.now();
			});
	};
	tick();
	const timer = setInterval(tick, 30_000);
	window.addEventListener("focus", tick);
	return () => {
		clearInterval(timer);
		window.removeEventListener("focus", tick);
	};
});

onMount(() => {
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") open = false;
	};
	window.addEventListener("keydown", onKeyDown);
	return () => window.removeEventListener("keydown", onKeyDown);
});

// Move focus into the popover on open and return it to the chip on close.
$effect(() => {
	if (open === lastOpen) return;
	lastOpen = open;
	if (open) popoverEl?.focus();
	else rootEl?.querySelector<HTMLButtonElement>(".runtime-chip")?.focus();
});
</script>

{#snippet StatusDot()}
	<span class="runtime-dot" data-tone={tone} aria-hidden="true"></span>
{/snippet}

{#if status?.kind === "local"}
	<div class="runtime-root" bind:this={rootEl}>
		<button
			type="button"
			class="runtime-chip"
			data-tone={tone}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-label={`${m.runtime_title({}, { locale })} · ${label}`}
			onclick={() => (open ? (open = false) : show())}
		>
			<Monitor class="h-4 w-4 shrink-0 lg:hidden" aria-hidden="true" />
			{@render StatusDot()}
			<span class="runtime-chip-label hidden lg:inline"
				>{m.runtime_local({}, { locale })}</span
			>
		</button>

		{#if open}
			<button
				class="runtime-backdrop"
				type="button"
				aria-hidden="true"
				tabindex="-1"
				use:portal
				onclick={() => (open = false)}
			></button>
			<div
				class="runtime-popover"
				role="dialog"
				aria-modal="true"
				aria-label={m.runtime_title({}, { locale })}
				tabindex="-1"
				bind:this={popoverEl}
				use:floatNear={{
					getAnchor: () => rootEl,
					placement: "bottom-end",
					gap: 8,
					width: 288,
					zIndex: 90,
				}}
			>
				<div class="runtime-header">
					<span class="runtime-header-title"
						>{m.runtime_title({}, { locale })}</span
					>
					<div class="runtime-header-meta">
						<span class="runtime-header-state" data-tone={tone}
							>{@render StatusDot()}{label}</span
						>
						<button
							type="button"
							class="runtime-action"
							title={m.common_close({}, { locale })}
							aria-label={m.common_close({}, { locale })}
							onclick={() => (open = false)}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<div class="runtime-body">
					<div class="runtime-row">
						<span class="runtime-row-label"
							>{m.runtime_harnesses({}, { locale })}</span
						>
						<span class="runtime-row-value">{harnessSummary || "—"}</span>
					</div>
					<div class="runtime-row">
						<span class="runtime-row-label"
							>{m.runtime_file_watcher({}, { locale })}</span
						>
						<span class="runtime-row-value">{watcherDetail}</span>
					</div>
					{#if status.runtimeId}
						<div class="runtime-row">
							<span class="runtime-row-label"
								>{m.runtime_id({}, { locale })}</span
							>
							<code class="runtime-row-value runtime-row-code" title={status.runtimeId}
								>{status.runtimeId}</code
							>
						</div>
					{/if}
					{#if !status.online}
						<p class="runtime-hint">
							{m.runtime_offline_hint({}, { locale })}
							<code>cohub runtime up</code>
						</p>
					{/if}
				</div>
				<div class="runtime-footer">
					<span class="runtime-footer-meta" class:is-failed={failed}
						>{failed
							? m.runtime_refresh_failed({}, { locale })
							: updatedLabel}</span
					>
					<div class="runtime-footer-actions">
						<button
							type="button"
							class="runtime-action"
							title={m.runtime_refresh({}, { locale })}
							aria-label={m.runtime_refresh({}, { locale })}
							disabled={refreshing}
							onclick={refresh}
						>
							<RefreshCw
								class={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
							/>
						</button>
						{#if canManage}
							<button
								type="button"
								class="runtime-action"
								title={m.runtime_manage({}, { locale })}
								aria-label={m.runtime_manage({}, { locale })}
								onclick={() => {
									open = false;
									void goto(`/spaces/${spaceId}/settings`);
								}}
							>
								<Settings2 class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.runtime-root {
		position: relative;
		flex: 0 0 auto;
	}

	.runtime-chip {
		display: inline-flex;
		height: 32px;
		align-items: center;
		gap: 6px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		padding: 0 8px;
		color: var(--text-tertiary);
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.runtime-chip:hover,
	.runtime-chip[aria-expanded="true"] {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.runtime-chip:active {
		transform: translateY(0.5px);
	}

	.runtime-chip:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--brand) 38%, transparent);
		outline-offset: 1px;
	}

	.runtime-chip-label {
		font-size: 13px;
		font-weight: 500;
		line-height: 1;
	}

	.runtime-dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: var(--text-placeholder);
		transition: background-color 160ms ease;
	}

	.runtime-dot[data-tone="online"] {
		background: var(--status-running);
	}

	.runtime-dot[data-tone="attention"] {
		background: var(--warning-400);
	}

	.runtime-dot[data-tone="offline"] {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--text-placeholder);
	}

	.runtime-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-workspace-popover);
		border: 0;
		background: transparent;
		padding: 0;
		cursor: default;
	}

	.runtime-popover {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 14px;
		background: var(--bg-elevated);
		box-shadow: 0 18px 32px
			color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
	}

	.runtime-popover:focus {
		outline: none;
	}

	.runtime-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-bottom: 1px solid var(--border-subtle);
		padding: 6px 8px 6px 10px;
	}

	.runtime-header-meta {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.runtime-header-title {
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.runtime-header-state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: var(--text-tertiary);
	}

	.runtime-body {
		display: grid;
		gap: 2px;
		padding: 6px;
	}

	.runtime-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		border-radius: 8px;
		padding: 6px 8px;
	}

	.runtime-row-label {
		font-size: 12px;
		color: var(--text-tertiary);
	}

	.runtime-row-value {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.runtime-row-code {
		font-family: var(--font-mono);
		font-size: 11px;
	}

	.runtime-hint {
		margin: 6px 8px 2px;
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-tertiary);
	}

	.runtime-hint code {
		border-radius: 5px;
		background: var(--bg-hover-strong);
		padding: 1px 5px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--text-secondary);
	}

	.runtime-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-top: 1px solid var(--border-subtle);
		padding: 6px 8px;
	}

	.runtime-footer-meta {
		font-size: 11px;
		color: var(--text-tertiary);
	}

	.runtime-footer-meta.is-failed {
		color: var(--color-error-soft);
	}

	.runtime-footer-actions {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.runtime-action {
		display: inline-flex;
		height: 26px;
		width: 26px;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.runtime-action:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.runtime-action:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.runtime-action:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--brand) 38%, transparent);
		outline-offset: 1px;
	}

	@media (max-width: 640px) {
		.runtime-backdrop {
			z-index: var(--z-workspace-popover-open);
			background: var(--overlay-scrim);
		}

		.runtime-popover {
			position: fixed !important;
			left: 8px !important;
			right: 8px !important;
			top: auto !important;
			bottom: 8px !important;
			width: auto !important;
			max-width: none !important;
			border-radius: 18px 18px 14px 14px;
		}
	}
</style>
