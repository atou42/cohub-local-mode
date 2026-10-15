<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  open?: boolean;
  label: string;
  triggerClass?: string;
  align?: "start" | "end";
  trigger: Snippet;
  children: Snippet;
  onopen?: () => void;
};
let {
  open = $bindable(false),
  label,
  triggerClass = "",
  align = "end",
  trigger,
  children,
  onopen,
}: Props = $props();

let root = $state<HTMLElement | null>(null);

function toggle() {
  open = !open;
  if (open) onopen?.();
}

$effect(() => {
  if (!open) return;
  const close = (event: PointerEvent) => {
    if (root && !root.contains(event.target as Node)) open = false;
  };
  const dismiss = (event: KeyboardEvent) => {
    if (event.key === "Escape") open = false;
  };
  window.addEventListener("pointerdown", close);
  window.addEventListener("keydown", dismiss);
  return () => {
    window.removeEventListener("pointerdown", close);
    window.removeEventListener("keydown", dismiss);
  };
});
</script>

<div class="relative" bind:this={root}>
  <button type="button" class={triggerClass} aria-expanded={open} aria-haspopup="true" aria-label={label} onclick={toggle}>{@render trigger()}</button>
  {#if open}
    <div class="absolute z-30 mt-1 w-[min(18rem,calc(100vw-2rem))] animate-fade-in overflow-hidden rounded-[6px] border border-border-subtle bg-bg-surface shadow-lg shadow-shadow-medium {align === 'end' ? 'right-0' : 'left-0'}">
      {@render children()}
    </div>
  {/if}
</div>
