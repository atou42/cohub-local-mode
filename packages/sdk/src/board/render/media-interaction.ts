import type { BoardSceneItem, } from "../model/scene.js";
import { degToRad, rotatePointAround, type WorldPoint, worldPoint } from "../model/geometry.js";
import { audioKeyCenter } from "./renderers/audio-card-renderer.js";
import { featuredTaskArtifact } from "@cohub/protocol";
import { boardCardDetailed } from "./text-resolution.js";

export type BoardMediaAction = {
	action: "play-media";
	itemId: string;
};

export function mediaPlayBadgeVisible(
	item: BoardSceneItem,
	zoom: number,
	options: { materialized: boolean; hasVideoPreview: boolean },
): boolean {
	if (!options.materialized) return false;
	if (item.type === "video" || item.type === "audio") return true;
	if (item.type !== "task" || !boardCardDetailed(zoom)) return false;
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	if (artifact?.type === "audio") return true;
	return artifact?.type === "video" &&
		(Boolean(artifact.previewUrl) || options.hasVideoPreview);
}

export function mediaPlayKeyCenter(item: BoardSceneItem): WorldPoint {
	const { x, y, width, height, rotation } = item.frame;
	const center = worldPoint(x + width / 2, y + height / 2);
	if (item.type !== "audio") return center;
	const key = audioKeyCenter(width, height);
	return rotatePointAround(worldPoint(x + key.x, y + key.y), center, degToRad(rotation || 0));
}

export function mediaPlayBadgeHit(
	item: BoardSceneItem,
	point: WorldPoint,
	zoom: number,
): boolean {
	const radius = 28 / Math.max(zoom, 0.05);
	const center = mediaPlayKeyCenter(item);
	return Math.hypot(point.x - center.x, point.y - center.y) <= radius;
}

export function boardMediaActionAt(
	item: BoardSceneItem,
	point: WorldPoint,
	zoom: number,
	options: { materialized: boolean; hasVideoPreview: boolean },
): BoardMediaAction | null {
	return mediaPlayBadgeVisible(item, zoom, options) &&
		mediaPlayBadgeHit(item, point, zoom)
		? { action: "play-media", itemId: item.id }
		: null;
}
