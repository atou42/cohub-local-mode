<script lang="ts">
type Props = { variant: "detail" | "rows"; rows?: number };
let { variant, rows = 6 }: Props = $props();
const bar = "animate-pulse rounded bg-bg-elevated/70";
</script>

{#if variant === "detail"}
  <div class="space-y-8 px-4 py-5 sm:px-6" aria-hidden="true">
    <div class="space-y-3 border-b border-border-subtle/70 pb-5">
      <div class="h-7 w-2/3 max-w-sm {bar}"></div>
      <div class="flex gap-3"><div class="h-3 w-16 {bar}"></div><div class="h-3 w-40 {bar}"></div></div>
    </div>
    <div class="space-y-2"><div class="h-3 w-20 {bar}"></div><div class="h-28 {bar} opacity-60"></div></div>
    <div class="grid gap-4 sm:grid-cols-2">{#each Array(4) as _}<div class="space-y-1.5"><div class="h-2.5 w-16 {bar}"></div><div class="h-3.5 w-28 {bar}"></div></div>{/each}</div>
  </div>
{:else}
  <div class="divide-y divide-border-subtle/50" aria-hidden="true">
    {#each Array(rows) as _, index}
      <div class="flex h-[58px] items-center gap-3 px-2" style:opacity={1 - index * 0.12}>
        <div class="h-1.5 w-1.5 rounded-full bg-bg-elevated"></div>
        <div class="min-w-0 flex-1 space-y-2"><div class="h-3.5 w-1/2 {bar}"></div><div class="h-2.5 w-1/3 {bar}"></div></div>
        <div class="h-2.5 w-12 {bar}"></div>
      </div>
    {/each}
  </div>
{/if}
