import type { BoardDocument } from "@cohub/protocol";
import { createBoardAnimationSampler } from "../model/sampling.js";
import { buildFallbackShapeColors, type BoardShapeColors } from "../model/palette.js";
import { defaultBoardPalette, itemAlpha, itemColor } from "./palette.js";
import type { BoardRenderPalette } from "./renderers/board-renderer-registry.js";

export function createBoardRenderSampler(
  document: BoardDocument,
  animation: string | null,
  options: { colorScheme?: "dark" | "light"; colors?: BoardShapeColors; palette?: Partial<BoardRenderPalette> } = {},
) {
  const colorScheme = options.colorScheme ?? "dark";
  const context = {
    colorScheme,
    colors: options.colors ?? buildFallbackShapeColors(colorScheme),
    palette: { ...defaultBoardPalette(colorScheme), ...options.palette },
  };
  return createBoardAnimationSampler(document, animation, {
    resolveColor: (color) => ({ color: itemColor(context, color, "brand", "fill"), alpha: itemAlpha(context, color) }),
  });
}
