<script lang="ts">
import type { Snippet } from "svelte";

/**
 * Shared grouped container for header controls. Keeps every control cluster
 * visually identical instead of one-off borders per component.
 */
const {
	label,
	children,
}: {
	label: string;
	children: Snippet;
} = $props();
</script>

<div class="preview-control-group" role="group" aria-label={label}>
	{@render children()}
</div>

<style>
	.preview-control-group {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-input);
		padding: 2px;
	}
</style>
