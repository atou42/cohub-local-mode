import type { Graphics } from "pixi.js";
import { tracePixelRect } from "../surface.js";
import type { BoardRenderContext } from "./board-renderer-registry.js";

const MEDIA_SCRIM = 0x000000;
const MEDIA_INK = 0xffffff;

export function drawMediaPlayKey(
	graphics: Graphics,
	cx: number,
	cy: number,
	radius: number,
	context: BoardRenderContext,
	solid = false,
) {
	const face = solid ? context.palette.text : MEDIA_SCRIM;
	const ink = solid ? context.palette.surface : MEDIA_INK;
	if (context.style.corner === "pixel") {
		const size = Math.round(radius * 1.6);
		tracePixelRect(graphics, Math.round(cx - size / 2), Math.round(cy - size / 2), size, size, 2).fill({ color: face, alpha: solid ? 1 : 0.62 });
		const cell = Math.max(1, Math.round(size / 14));
		const x = Math.round(cx - cell * 1.5);
		const y = Math.round(cy - cell * 3.5);
		for (let row = 0; row < 7; row += 1) graphics.rect(x, y + row * cell, (4 - Math.abs(row - 3)) * cell, cell);
		graphics.fill({ color: ink });
		return;
	}
	graphics.circle(cx, cy, radius).fill({ color: face, alpha: solid ? 1 : 0.45 });
	const size = radius * 0.5;
	graphics
		.poly([cx - size * 0.45, cy - size * 0.75, cx + size * 0.8, cy, cx - size * 0.45, cy + size * 0.75])
		.fill({ color: ink, alpha: 0.96 });
}
