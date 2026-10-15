import type { Graphics } from "pixi.js";

const DEFAULT_BARS = 44;
const BAR_GAP = 2;

/** Stable placeholder amplitudes without reading or decoding the audio file. */
export function audioWaveformBars(seed: string, count: number): number[] {
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	const bars: number[] = [];
	for (let index = 0; index < count; index += 1) {
		hash ^= hash << 13;
		hash ^= hash >>> 17;
		hash ^= hash << 5;
		bars.push(0.2 + ((hash >>> 0) / 0xffffffff) * 0.8);
	}
	return bars;
}

export function drawAudioWaveform(
	graphics: Graphics,
	seed: string,
	rect: { x: number; y: number; width: number; height: number },
	color: number,
	alpha = 0.72,
	square = false,
) {
	const count = Math.max(
		8,
		Math.min(DEFAULT_BARS, Math.floor(rect.width / (BAR_GAP + 2))),
	);
	const step = rect.width / count;
	const barWidth = Math.max(1.5, step - BAR_GAP);
	const centerY = rect.y + rect.height / 2;
	const maxHeight = Math.max(2, rect.height * 0.72);
	const bars = audioWaveformBars(seed, count);
	for (let index = 0; index < count; index += 1) {
		const height = Math.max(2, (bars[index] ?? 0.4) * maxHeight);
		const x = rect.x + index * step;
		if (square) graphics.rect(x, centerY - height / 2, barWidth, height);
		else graphics.roundRect(x, centerY - height / 2, barWidth, height, barWidth / 2);
	}
	graphics.fill({ color, alpha });
}
