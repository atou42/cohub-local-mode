import type { BoardSceneItem } from "@neta-art/cohub/board";

export function boardSelectionColor(
	items: readonly BoardSceneItem[],
): string | null | undefined {
	const colors = items.flatMap((item) => {
		const { fill, stroke } = item.style;
		const id = (value: unknown, fallback: string) =>
			typeof value === "string" ? value : value === undefined ? fallback : null;
		if (item.type === "text" || item.type === "effect")
			return [id(fill, "neutral")];
		if (item.type === "shape") return [id(stroke ?? fill, "brand")];
		if (item.type === "draw" || item.type === "arrow")
			return [id(stroke, "brand")];
		if (item.type === "frame") return [id(stroke ?? fill, "neutral")];
		return [];
	});
	if (colors.length === 0) return undefined;
	return colors.every((color) => color === colors[0])
		? (colors[0] ?? null)
		: null;
}
