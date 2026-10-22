import { BOARD_TEXT_FONT_SIZE, clampBoardFontSize, layoutBoardText } from "@cohub/protocol";
import type { BoardSceneItem } from "../model/scene.js";

/** On-screen thresholds, in CSS pixels, below which a card draws on the far layer. */
export type BoardLod = {
	/** Long edge of images and video stills. */
	media: number;
	/** Font size of text. */
	text: number;
	/** Long edge of every other card. */
	card: number;
	/** Most live cards; beyond it the smallest draw on the far layer. */
	live: number;
};

export type BoardLodKind = Exclude<keyof BoardLod, "live">;

export const DEFAULT_BOARD_LOD: BoardLod = { media: 12, text: 4, card: 24, live: 1200 };
export const COMPACT_BOARD_LOD: BoardLod = { ...DEFAULT_BOARD_LOD, live: 400 };


export const BOARD_LOD_HYSTERESIS = 0.8;

const CARD_TEXT_SIZE = 12;

export function boardCardDetailed(zoom: number): boolean {
	return zoom * CARD_TEXT_SIZE >= DEFAULT_BOARD_LOD.text;
}

export function boardLongEdge(item: BoardSceneItem): number {
	return Math.max(item.frame.width, item.frame.height);
}


export function boardTextSize(item: BoardSceneItem): number {
	if (item.type !== "text") return boardLongEdge(item);
	const scale = item.frame.width / Math.max(0.0001, layoutBoardText(item.props).width);
	return clampBoardFontSize(item.props.fontSize ?? BOARD_TEXT_FONT_SIZE) * scale;
}
