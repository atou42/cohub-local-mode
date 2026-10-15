import type { Rect } from "./geometry.js";

export type BoardPlacement = "right" | "left" | "bottom" | "top";

export function placeBoardOverlay(input: {
  anchor: Rect;
  size: { width: number; height: number };
  safeRect: Rect;
  placements?: readonly BoardPlacement[];
  gap?: number;
}) {
  const { anchor: a, size, safeRect: safe, gap = 12 } = input;
  const placements = input.placements?.length ? input.placements : ["right", "left", "bottom", "top"] as const;
  const width = Math.min(size.width, safe.width);
  const height = Math.min(size.height, safe.height);
  const candidates = placements.map((placement) => {
    const x = placement === "right" ? a.x + a.width + gap : placement === "left" ? a.x - width - gap : a.x + (a.width - width) / 2;
    const y = placement === "bottom" ? a.y + a.height + gap : placement === "top" ? a.y - height - gap : a.y + (a.height - height) / 2;
    const overflow = Math.max(0, safe.x - x) + Math.max(0, x + width - safe.x - safe.width) + Math.max(0, safe.y - y) + Math.max(0, y + height - safe.y - safe.height);
    return { placement, x, y, overflow };
  });
  const best = candidates.reduce((best, next) => next.overflow < best.overflow ? next : best);
  return {
    placement: best.placement,
    position: { x: Math.max(safe.x, Math.min(best.x, safe.x + safe.width - width)), y: Math.max(safe.y, Math.min(best.y, safe.y + safe.height - height)) },
    availableSize: { width, height },
  };
}
