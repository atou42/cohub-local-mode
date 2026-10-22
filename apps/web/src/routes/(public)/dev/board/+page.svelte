<script lang="ts">
import type { BoardAssetSource } from "@neta-art/cohub/board";
import {
	type BoardLod,
	COMPACT_BOARD_LOD,
	DEFAULT_BOARD_LOD,
} from "@neta-art/cohub/board/render";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { page } from "$app/state";
import { cohubPixiRuntime } from "$lib/board/runtime/board-runtime";
import { getTheme, setTheme, type ThemeMode } from "$lib/theme.svelte";
import { RESOLVED_THEMES } from "$lib/theme-registry";
import {
	BENCH_SCENARIOS,
	type BenchScenario,
	boardGalleryDocument,
	GALLERY_ASSET_PREFIX,
} from "./gallery";
import LodTuner from "./LodTuner.svelte";

const assetOrigin = page.url.searchParams.get("assets");
const bench = Number(page.url.searchParams.get("bench") ?? 0) || undefined;
const isMobile = page.url.searchParams.has("mobile");
const requested = page.url.searchParams.get("scenario");
const scenario = BENCH_SCENARIOS.find((name) => name === requested) as
	| BenchScenario
	| undefined;
const document = boardGalleryDocument({ bench, scenario });

const base = isMobile ? COMPACT_BOARD_LOD : DEFAULT_BOARD_LOD;
const param = (key: keyof BoardLod) => {
	const value = Number(page.url.searchParams.get(key));
	return page.url.searchParams.has(key) && Number.isFinite(value)
		? value
		: base[key];
};
let lod = $state<BoardLod>({
	media: param("media"),
	text: param("text"),
	card: param("card"),
	live: param("live"),
});
let stage = $state.raw<BoardStage | null>(null);

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
			{lod}
			onStageReady={(next) => {
				stage = next;
			}}
			onCommit={() => {
			}}
		/>
	{/await}
	<LodTuner bind:lod {stage} />
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
