<script lang="ts">
import { ChevronDown } from "lucide-svelte";

/**
 * Native `<select>` styled as a composer pill.
 *
 * Keeps the platform dropdown and keyboard behaviour while matching the
 * surrounding pill controls. The native select is an invisible overlay so the
 * visible label can truncate and carry a Runtime status dot.
 */
export type ComposerSelectOption = {
	value: string;
	label: string;
	disabled?: boolean;
};

const {
	value,
	options,
	onchange,
	onopen,
	ariaLabel,
	title,
	disabled = false,
	online,
}: {
	value: string;
	options: ComposerSelectOption[];
	onchange: (value: string) => void;
	onopen?: () => void;
	ariaLabel: string;
	title?: string;
	disabled?: boolean;
	/** Renders a Runtime status dot when defined. */
	online?: boolean;
} = $props();

const selectedLabel = $derived(
	options.find((option) => option.value === value)?.label ??
		options[0]?.label ??
		"",
);
</script>

<label class="composer-select" class:is-disabled={disabled}>
	{#if online !== undefined}
		<span class="composer-dot" data-online={online} aria-hidden="true"></span>
	{/if}
	<span class="composer-select-label" aria-hidden="true">{selectedLabel}</span>
	<span class="composer-chevron" aria-hidden="true">
		<ChevronDown class="h-3 w-3 shrink-0 opacity-40" />
	</span>
	<select
		class="composer-select-native"
		{disabled}
		{title}
		aria-label={ariaLabel}
		{value}
		onfocus={() => onopen?.()}
		onchange={(event) => onchange(event.currentTarget.value)}
	>
		{#each options as option (option.value)}
			<option value={option.value} disabled={option.disabled}>{option.label}</option>
		{/each}
	</select>
</label>

<style>
	.composer-select {
		position: relative;
		display: inline-flex;
		height: 28px;
		max-width: min(100%, 11rem);
		align-items: center;
		gap: 4px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0 8px;
		font-size: 11px;
		line-height: 1;
		color: var(--text-tertiary);
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease,
			border-color 120ms ease;
	}

	.composer-select:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.composer-select:has(.composer-select-native:focus-visible) {
		outline: 2px solid color-mix(in srgb, var(--brand) 38%, transparent);
		outline-offset: 1px;
	}

	.composer-select.is-disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.composer-select.is-disabled:hover {
		background: transparent;
		color: var(--text-tertiary);
	}

	.composer-select-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.composer-chevron {
		display: inline-flex;
		transition: opacity 120ms ease;
	}

	.composer-select:hover .composer-chevron {
		opacity: 0.65;
	}

	.composer-select-native {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
		background: transparent;
		appearance: none;
		opacity: 0;
		cursor: inherit;
	}

	.composer-dot {
		flex: 0 0 auto;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--text-placeholder);
	}

	.composer-dot[data-online="true"] {
		background: var(--status-running);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--status-running) 18%, transparent);
	}

	.composer-dot[data-online="false"] {
		opacity: 0.55;
	}
</style>
