import type { BoardSceneItem, SceneItem } from "../../model/scene.js";
import { Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { BoardImageItem } from "@cohub/protocol";
import { cardElevation, containRect, drawCardSurface, traceCardOutline } from "../surface.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type BoardCrop = NonNullable<BoardImageItem["props"]["crop"]>;

type ImageParts = {
	root: Container;
	sprite: Sprite;
	placeholder: Graphics;
	mask: Graphics;
	sig: string;
	cropped: Texture | null;
	cropSource: Texture | null;
	cropKey: string;
};

const partsByContainer = new WeakMap<Container, ImageParts>();

function cropRect(crop: BoardCrop | undefined) {
	if (!crop) return null;
	const w = Math.min(crop.w, 1 - crop.x);
	const h = Math.min(crop.h, 1 - crop.y);
	return w > 0 && h > 0 ? { x: crop.x, y: crop.y, w, h } : null;
}

function showTexture(parts: ImageParts, texture: Texture | null, crop: BoardCrop | undefined) {
	const rect = texture ? cropRect(crop) : null;
	const key = rect ? `${rect.x}|${rect.y}|${rect.w}|${rect.h}` : "";
	const previous = parts.cropped;
	const reusable = previous && parts.cropSource === texture && parts.cropKey === key;
	if (texture && rect && !reusable) {
		const { frame } = texture;
		const width = Math.max(1, frame.width * rect.w);
		const height = Math.max(1, frame.height * rect.h);
		const x = frame.x + Math.min(frame.width * rect.x, frame.width - width);
		const y = frame.y + Math.min(frame.height * rect.y, frame.height - height);
		parts.cropped = new Texture({ source: texture.source, frame: new Rectangle(x, y, width, height) });
	} else if (!rect) parts.cropped = null;
	parts.cropSource = rect ? texture : null;
	parts.cropKey = key;
	const display = parts.cropped ?? texture ?? Texture.EMPTY;
	if (parts.sprite.texture !== display) parts.sprite.texture = display;
	if (previous && previous !== parts.cropped) previous.destroy(false);
}

const PRINT_MARGIN = 6;

function sync(
	container: Container,
	item: SceneItem<BoardImageItem>,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const { width, height } = item.frame;
	const key = context.assetKey(item);
	const texture = key ? context.getTexture(key) : null;
	const failed = Boolean(key && !texture && context.hasError(key));
	const elevation = cardElevation(context, item.id);
	const sig = [
		key ?? "",
		width,
		height,
		texture ? `${texture.width}x${texture.height}` : "none",
		JSON.stringify(item.props.crop ?? null),
		failed,
		elevation,
		context.themeKey,
	].join("|");
	if (sig === parts.sig) return;
	parts.sig = sig;

	showTexture(parts, texture, item.props.crop);
	const display = parts.sprite.texture;
	const framed = context.style.media === "framed";
	const margin = framed ? Math.min(PRINT_MARGIN, width / 8, height / 8) : 0;
	const area = { x: margin, y: margin, width: width - margin * 2, height: height - margin * 2 };
	const fitted = texture ? containRect(area.width, area.height, display.width, display.height) : { ...area, x: 0, y: 0 };
	const picture = { x: area.x + fitted.x, y: area.y + fitted.y, width: fitted.width, height: fitted.height };
	const card = framed ? { x: picture.x - margin, y: picture.y - margin, width: picture.width + margin * 2, height: picture.height + margin * 2 } : picture;

	parts.sprite.visible = Boolean(texture);
	if (texture) {
		parts.sprite.position.set(picture.x, picture.y);
		parts.sprite.width = picture.width;
		parts.sprite.height = picture.height;
	}
	traceCardOutline(parts.mask.clear(), picture, framed ? { corner: "round", radius: 0 } : context.style).fill({ color: 0xffffff });

	parts.placeholder.clear();
	if (texture && !framed) return;
	drawCardSurface(parts.placeholder, card, context.style, {
		fill: context.palette.surface,
		border: texture ? null : failed ? context.palette.border : context.palette.hover,
		elevation,
	});
	if (texture) return;
	const cx = width / 2;
	const cy = height / 2;
	if (failed) {
		parts.placeholder
			.moveTo(cx - 10, cy - 10)
			.lineTo(cx + 10, cy + 10)
			.moveTo(cx + 10, cy - 10)
			.lineTo(cx - 10, cy + 10)
			.stroke({ color: context.palette.muted, width: 1.5, alpha: 0.8 });
	} else {
		parts.placeholder
			.circle(cx, cy, 6)
			.stroke({ color: context.palette.muted, width: 1.25, alpha: 0.55 });
	}
}

export const imageCardRenderer: BoardCardRenderer = {
	id: "image-card",
	canRender: (item) => item.type === "image",
	create: (item, context) => {
		const root = new Container();
		const sprite = new Sprite(Texture.EMPTY);
		const placeholder = new Graphics();
		const mask = new Graphics();
		root.addChild(placeholder, sprite, mask);
		sprite.mask = mask;
		partsByContainer.set(root, { root, sprite, placeholder, mask, sig: "", cropped: null, cropSource: null, cropKey: "" });
		if (item.type === "image") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "image") sync(container, item, context);
	},
	renderFar: (graphics, item, context) => {
		drawFarPlate(graphics, item.frame, {
			fill: context.palette.hover,
			fillAlpha: 0.9,
		});
	},
	destroy: (container) => {
		const parts = partsByContainer.get(container);
		parts?.root.destroy({ children: true });
		parts?.cropped?.destroy(false);
		partsByContainer.delete(container);
	},
};

export function isImageItem(item: BoardSceneItem): item is SceneItem<BoardImageItem> {
	return item.type === "image";
}
