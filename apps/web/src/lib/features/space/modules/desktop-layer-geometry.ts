/**
 * Pure geometry helpers for the overlay layer. Kept free of runtime imports so
 * tests exercise the production math without dragging in the SDK.
 */
import type { AppRuntimeConfigureRequest } from "@cohub/protocol/app-runtime";

export type OverlayGeometry = NonNullable<
	AppRuntimeConfigureRequest["geometry"]
>;
export type OverlayInputRegion = NonNullable<
	AppRuntimeConfigureRequest["inputRegion"]
>;

type Viewport = { width: number; height: number };

/** Structural equality for geometry: every field is a primitive. */
export function sameGeometry(a: OverlayGeometry, b: OverlayGeometry): boolean {
	return (
		a.anchor === b.anchor &&
		a.x === b.x &&
		a.y === b.y &&
		a.width === b.width &&
		a.height === b.height
	);
}

/** Structural equality for input regions; rect lists compare element-wise. */
export function sameInputRegion(
	a: OverlayInputRegion,
	b: OverlayInputRegion,
): boolean {
	if (a === b) return true;
	if (typeof a === "string" || typeof b === "string") return false;
	return (
		a.length === b.length &&
		a.every((rect, i) => {
			const other = b[i];
			return (
				rect.x === other.x &&
				rect.y === other.y &&
				rect.width === other.width &&
				rect.height === other.height
			);
		})
	);
}

type Axis = { size: number; offset: number };

const clamp = (value: number, min: number, max: number) =>
	Math.max(min, Math.min(value, max));

/**
 * Resolves one axis: a missing size fills that axis; a given size is clamped
 * to the viewport and the offset is kept inside `[0, viewport - size]` so no
 * part of the overlay can end up off-screen. `anchorEnd` measures the offset
 * from the far edge, `anchorCenter` from the middle.
 */
function resolveAxis(
	size: number | undefined,
	offset: number,
	extent: number,
	anchor: "start" | "end" | "center",
): Axis {
	if (size == null) return { size: extent, offset: 0 };
	const clampedSize = clamp(size, 1, extent);
	const room = extent - clampedSize;
	const start =
		anchor === "start"
			? offset
			: anchor === "end"
				? room - offset
				: room / 2 + offset;
	return { size: clampedSize, offset: clamp(start, 0, room) };
}

export type OverlayRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * Where one overlay sits in the layer. Each axis is resolved independently: an
 * axis without a size fills the layer, an axis with a size is clamped so the
 * overlay always stays fully on-screen regardless of anchor.
 */
export function resolveOverlayRect(
	geometry: OverlayGeometry,
	viewport: Viewport,
): OverlayRect {
	const anchor = geometry.anchor ?? "top-left";
	const horizontal =
		anchor === "center" ? "center" : anchor.endsWith("right") ? "end" : "start";
	const vertical =
		anchor === "center"
			? "center"
			: anchor.startsWith("bottom")
				? "end"
				: "start";
	const x = resolveAxis(
		geometry.width,
		geometry.x ?? 0,
		viewport.width,
		horizontal,
	);
	const y = resolveAxis(
		geometry.height,
		geometry.y ?? 0,
		viewport.height,
		vertical,
	);
	return { left: x.offset, top: y.offset, width: x.size, height: y.size };
}

/** Inline style for one overlay. */
export function resolveOverlayStyle(
	geometry: OverlayGeometry,
	viewport: Viewport,
): string {
	const rect = resolveOverlayRect(geometry, viewport);
	return `left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px`;
}

/** Whether the region needs the pointer tracked to know if it is inside. */
export function isTrackedInputRegion(region: OverlayInputRegion): boolean {
	return Array.isArray(region) && region.length > 0;
}

type PointerOverlay = {
	appId: string;
	geometry: OverlayGeometry;
	inputRegion: OverlayInputRegion;
};

/**
 * Whether a tracked overlay currently owns the pointer. Only a rect region can
 * be hot: `"all"` is always interactive and `"none"`/empty never is, so a stale
 * hot flag on an overlay that just opted out must not keep it interactive.
 */
export function ownsInput(
	overlay: PointerOverlay,
	hotAppIds: ReadonlySet<string>,
): boolean {
	return (
		isTrackedInputRegion(overlay.inputRegion) && hotAppIds.has(overlay.appId)
	);
}

/** App ids whose declared rect contains a layer-local point. */
export function hotAppIdsAt(
	overlays: readonly PointerOverlay[],
	point: { x: number; y: number },
	viewport: Viewport,
	origin: { left: number; top: number },
): Set<string> {
	const hot = new Set<string>();
	for (const overlay of overlays) {
		if (!isTrackedInputRegion(overlay.inputRegion)) continue;
		const rect = resolveOverlayRect(overlay.geometry, viewport);
		const x = point.x - origin.left - rect.left;
		const y = point.y - origin.top - rect.top;
		if (inputRegionContains(overlay.inputRegion, x, y)) hot.add(overlay.appId);
	}
	return hot;
}

/**
 * Drops hot ids that are gone or left the rect-region family (closed, or
 * switched to `"none"`/`"all"`). Opting out must revoke interaction at once,
 * even mid-press — the App stops reporting, so the host has nothing to wait for.
 */
export function pruneHotAppIds(
	hotAppIds: ReadonlySet<string>,
	overlays: readonly PointerOverlay[],
): Set<string> {
	const tracked = new Set<string>();
	for (const overlay of overlays) {
		if (isTrackedInputRegion(overlay.inputRegion)) tracked.add(overlay.appId);
	}
	if ([...hotAppIds].every((id) => tracked.has(id))) return new Set(hotAppIds);
	return new Set([...hotAppIds].filter((id) => tracked.has(id)));
}

/**
 * Whether an overlay-local point falls inside the declared input region.
 * `all` accepts everything, `none` (and an empty list) nothing; a rect list
 * accepts points on or inside any of its rectangles.
 */
export function inputRegionContains(
	region: OverlayInputRegion,
	x: number,
	y: number,
): boolean {
	if (region === "all") return true;
	if (region === "none") return false;
	return region.some(
		(rect) =>
			x >= rect.x &&
			x <= rect.x + rect.width &&
			y >= rect.y &&
			y <= rect.y + rect.height,
	);
}
