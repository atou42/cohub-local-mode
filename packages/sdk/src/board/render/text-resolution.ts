import type { Text } from "pixi.js";

const MAX_BOARD_RESOLUTION = 3;
const MAX_BOARD_PIXELS = 8_000_000;
const MAX_TEXT_RESOLUTION = 6;

export function getBoardResolution(
	size?: { width: number; height: number },
	devicePixelRatio = globalThis.devicePixelRatio,
) {
	const density = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
	const pixels = size ? size.width * size.height : 0;
	const budget = pixels > 0 ? Math.sqrt(MAX_BOARD_PIXELS / pixels) : MAX_BOARD_RESOLUTION;
	return Math.min(density, MAX_BOARD_RESOLUTION, budget);
}

/**
 * Zoom buckets for text re-rasterisation. Pixi Text is a bitmap: at high zoom it
 * looks soft unless we raise its resolution. We quantise zoom into a few
 * buckets so small zoom changes don't thrash texture regeneration.
 */
const TEXT_ZOOM_BUCKETS = [0.5, 1, 1.5, 2, 3, 4] as const;

export function textZoomBucket(zoom: number): number {
	const clamped = Math.max(0.1, Math.min(4, zoom));
	for (const bucket of TEXT_ZOOM_BUCKETS) {
		if (clamped <= bucket) return bucket;
	}
	return TEXT_ZOOM_BUCKETS[TEXT_ZOOM_BUCKETS.length - 1] ?? 4;
}

export function boardCardDetailed(zoom: number): boolean {
	return textZoomBucket(zoom) >= 1;
}

/** Effective text resolution for a given camera zoom. */
export function textResolutionForZoom(zoom: number): number {
	const bucket = textZoomBucket(zoom);
	return Math.min(
		getBoardResolution() * Math.max(1, bucket),
		MAX_TEXT_RESOLUTION,
	);
}

/** Update a Pixi text texture only when zoom crosses a resolution bucket. */
export function syncTextResolution(
	text: Text,
	state: { resolution: number },
	zoom: number,
) {
	const resolution = textResolutionForZoom(zoom);
	if (resolution === state.resolution && resolution === text.resolution) return;
	text.resolution = resolution;
	state.resolution = resolution;
}

/** Defer expensive Pixi word-wrap rasterisation during a live resize. */
export function syncTextWrapWidth(
	text: Text,
	state: { wrapWidth: number },
	width: number,
	defer: boolean,
) {
	if (defer || width === state.wrapWidth) return;
	text.style.wordWrapWidth = width;
	state.wrapWidth = width;
}
