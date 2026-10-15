<script lang="ts">
import type { Snippet } from "svelte";
import { CircleAlert, Info } from "lucide-svelte";

type Props = { tone?: "error" | "info"; title?: string; children: Snippet; action?: Snippet; class?: string };
let { tone = "error", title, children, action, class: className = "" }: Props = $props();
</script>

<div class="flex items-start gap-2.5 rounded-[7px] px-3 py-2.5 text-[12px] leading-5 {tone === 'error' ? 'bg-error-bg text-error-soft' : 'bg-bg-elevated/40 text-text-secondary'} {className}" role={tone === "error" ? "alert" : "status"}>
  {#if tone === "error"}<CircleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />{:else}<Info class="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />{/if}
  <div class="min-w-0 flex-1 break-words">
    {#if title}<div class="text-[11px] font-medium uppercase tracking-wider">{title}</div>{/if}
    <div class={title ? "mt-1 whitespace-pre-wrap" : ""}>{@render children()}</div>
  </div>
  {#if action}<div class="-my-1 shrink-0">{@render action()}</div>{/if}
</div>
