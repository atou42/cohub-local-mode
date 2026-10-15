<script lang="ts">
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { Code, Pause, Play, RotateCcw } from "lucide-svelte";
import { untrack } from "svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	stage,
	readonly = false,
}: {
	editor: BoardEditor;
	stage: BoardStage | null;
	readonly?: boolean;
} = $props();
const locale = $derived(getLocale());
const hasScripts = $derived(editor.hasScripts);
const selected = $derived(
	editor.selection.length === 1
		? editor.document.items[editor.selection[0] ?? ""]
		: null,
);
let mode = $state<"edit" | "interact" | "paused">("edit");
let error = $state<string | null>(null);
$effect(() => {
	if (hasScripts) stage?.setScriptMode(readonly ? "interact" : mode);
});
$effect(() => {
	if (!hasScripts) {
		error = null;
		return;
	}
	const id = editor.selection.length === 1 ? editor.selection[0] : undefined;
	const refresh = () => {
		error = id ? (stage?.scriptError(id) ?? null) : null;
	};
	untrack(refresh);
	return stage?.subscribeScripts(refresh);
});
</script>

{#if hasScripts}
  <div class="script-controls" role="group" aria-label={m.board_script_title({}, { locale })}>
    <span class:error title={error ?? selected?.script?.src ?? m.board_script_title({}, { locale })}>
      <Code size={14} /> {m.board_script_title({}, { locale })}
    </span>
    {#if !readonly}
      <button type="button" aria-pressed={mode === "interact"} title={m.board_script_preview({}, { locale })} onclick={() => { mode = mode === "interact" ? "edit" : "interact"; }}><Play size={14} /></button>
      <button type="button" aria-pressed={mode === "paused"} title={m.board_script_pause({}, { locale })} onclick={() => { mode = mode === "paused" ? "edit" : "paused"; }}><Pause size={14} /></button>
    {/if}
    <button type="button" title={m.common_reset({}, { locale })} onclick={() => stage?.resetScripts()}><RotateCcw size={14} /></button>
  </div>
{/if}

<style>
.script-controls { position:absolute; top:12px; right:12px; z-index:30; display:flex; align-items:center; gap:2px; padding:3px; color:var(--text-secondary); background:var(--bg-surface); border:1px solid var(--border-primary); border-radius:6px; }
span { display:flex; align-items:center; gap:5px; padding:0 7px; font-size:11px; }
span.error { color:var(--error-500); }
button { display:flex; align-items:center; justify-content:center; width:30px; height:30px; background:transparent; border:0; border-radius:4px; color:inherit; cursor:pointer; }
button:hover { background:var(--bg-hover); }
button[aria-pressed="true"] { color:var(--brand); background:var(--bg-hover); }
button:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
@media (pointer:coarse) { button { width:44px; height:44px; } }
</style>
