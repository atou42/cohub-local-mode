<script lang="ts">
const {
	checked,
	label,
	disabled = false,
	onchange,
}: {
	checked: boolean;
	label: string;
	disabled?: boolean;
	onchange: (checked: boolean) => void;
} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	title={label}
	{disabled}
	class="inline-flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center disabled:cursor-default"
	onclick={() => onchange(!checked)}
>
	<span class="toggle-track"><span class="toggle-thumb"></span></span>
</button>
