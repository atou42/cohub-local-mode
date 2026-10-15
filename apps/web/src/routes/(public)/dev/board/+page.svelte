<script lang="ts">
import type { BoardAssetSource } from "@neta-art/cohub/board";
import { page } from "$app/state";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import { getTheme, setTheme, type ThemeMode } from "$lib/theme.svelte";
import { RESOLVED_THEMES } from "$lib/theme-registry";
import { boardGalleryDocument, GALLERY_ASSET_PREFIX } from "./gallery";

const assetOrigin = page.url.searchParams.get("assets");
const bench = Number(page.url.searchParams.get("bench") ?? 0) || undefined;
const isMobile = page.url.searchParams.has("mobile");
const document = boardGalleryDocument({ bench });

const resolve = async (path: string) =>
	assetOrigin && path.startsWith(GALLERY_ASSET_PREFIX)
		? new URL(path.slice(GALLERY_ASSET_PREFIX.length), assetOrigin).toString()
		: null;
const assetSource: BoardAssetSource = {
	resolveFileUrl: resolve,
	resolvePlaybackUrl: resolve,
};
const runtime = cohubPixiRuntime.load();
</script>

<div class="dev-board">
	<select
		class="dev-theme"
		aria-label="Theme"
		value={getTheme()}
		onchange={(event) => setTheme(event.currentTarget.value as ThemeMode)}
	>
		{#each RESOLVED_THEMES as theme (theme)}<option value={theme}>{theme}</option>{/each}
	</select>
	{#await runtime then module}
		<module.default
			path="dev/gallery.board"
			boardId="dev-gallery"
			{document}
			playback={null}
			spaceId="dev-gallery"
			{assetSource}
			{isMobile}
			onCommit={() => {
			}}
		/>
	{/await}
</div>

<style>
	.dev-board {
		position: fixed;
		inset: 0;
		background: var(--bg-primary);
	}
	.dev-theme {
		position: absolute;
		top: 8px;
		left: 50%;
		z-index: 50;
		transform: translateX(-50%);
		font-size: 12px;
	}
</style>
