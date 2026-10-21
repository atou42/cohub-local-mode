<script lang="ts">
import { fade, scale, slide } from "svelte/transition";
import {
	DURATION_MODAL_IN,
	DURATION_MODAL_OUT,
	svelteEaseIn,
	svelteEaseOut,
} from "$lib/motion.svelte";

function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

const {
	open,
	onClose,
	maxWidth = "480px",
	mobile = true,
	children,
}: {
	open: boolean;
	onClose: () => void;
	maxWidth?: string;
	mobile?: boolean;
	children: import("svelte").Snippet;
} = $props();

const FADE_IN = { duration: DURATION_MODAL_IN, easing: svelteEaseOut };
const FADE_OUT = { duration: DURATION_MODAL_OUT, easing: svelteEaseIn };
const SCALE_IN = { ...FADE_IN, start: 0.96 };
const SCALE_OUT = { ...FADE_OUT, start: 0.96 };

function onKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && !event.defaultPrevented) {
		event.preventDefault();
		onClose();
	}
}
</script>

{#if open}
	<div
		use:portal
		class="dialog-backdrop fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center lg:items-center lg:p-4"
		in:fade={FADE_IN}
		out:fade={FADE_OUT}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onkeydown={onKeydown}
	>
		<div
			class="absolute inset-0"
			onclick={onClose}
			aria-hidden="true"
		></div>

		{#if mobile}
			<!-- Desktop: centered panel -->
			<div
				class="dialog-surface relative hidden w-full lg:flex lg:flex-col"
				style="max-width: {maxWidth}; max-height: 88vh"
				in:scale|local={SCALE_IN}
				out:scale|local={SCALE_OUT}
			>
				{@render children()}
			</div>

			<!-- Mobile: bottom sheet -->
			<div
				class="dialog-surface is-sheet relative w-full max-w-[480px] lg:hidden"
				in:slide|local={{ axis: "y", ...FADE_IN }}
				out:slide|local={{ axis: "y", ...FADE_OUT }}
			>
				<div class="flex justify-center pt-2.5" aria-hidden="true">
					<div class="h-1 w-9 rounded-full bg-border-subtle"></div>
				</div>
				{@render children()}
			</div>
		{:else}
			<!-- Desktop-only centered panel -->
			<div
				class="dialog-surface relative w-full"
				style="max-width: {maxWidth}; max-height: 88vh"
				in:scale|local={SCALE_IN}
				out:scale|local={SCALE_OUT}
			>
				{@render children()}
			</div>
		{/if}
	</div>
{/if}
