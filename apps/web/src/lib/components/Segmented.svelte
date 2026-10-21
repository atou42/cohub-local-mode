<script lang="ts" generics="T extends string">
type Option = { value: T; label: string; disabled?: boolean; note?: string };

const {
	options,
	value,
	label,
	role = "radiogroup",
	onchange,
}: {
	options: readonly Option[];
	value: T;
	label: string;
	role?: "radiogroup" | "tablist";
	onchange: (value: T) => void;
} = $props();

const index = $derived(options.findIndex((option) => option.value === value));
const tabStop = $derived(
	options[index] && !options[index].disabled
		? index
		: options.findIndex((option) => !option.disabled),
);

function step(event: KeyboardEvent) {
	const delta =
		event.key === "ArrowRight" || event.key === "ArrowDown"
			? 1
			: event.key === "ArrowLeft" || event.key === "ArrowUp"
				? -1
				: 0;
	if (!delta) return;
	event.preventDefault();
	const items = (
		event.currentTarget as HTMLElement
	).querySelectorAll<HTMLElement>(".segmented-item");
	for (let i = 1; i < options.length; i++) {
		const target = (tabStop + delta * i + options.length) % options.length;
		const next = options[target];
		if (next && !next.disabled) {
			onchange(next.value);
			items[target]?.focus();
			return;
		}
	}
}
</script>

<div
	class="segmented"
	{role}
	aria-label={label}
	style:--segmented-count={options.length}
	style:--segmented-index={index}
	onkeydown={step}
>
	{#if index >= 0}<span class="segmented-thumb" aria-hidden="true"></span>{/if}
	{#each options as option, i (option.value)}
		{@const selected = option.value === value}
		<button
			type="button"
			class="segmented-item"
			role={role === "tablist" ? "tab" : "radio"}
			aria-checked={role === "radiogroup" ? selected : undefined}
			aria-selected={role === "tablist" ? selected : undefined}
			tabindex={i === tabStop ? 0 : -1}
			disabled={option.disabled}
			onclick={() => onchange(option.value)}
		>
			{option.label}
			{#if option.note}<span class="segmented-note">{option.note}</span>{/if}
		</button>
	{/each}
</div>
