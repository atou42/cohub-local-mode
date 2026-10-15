<script lang="ts">
const { label, class: className = "" }: { label?: string; class?: string } =
	$props();
</script>

<span
	class="spinner {className}"
	role={label ? "status" : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : "true"}
></span>
