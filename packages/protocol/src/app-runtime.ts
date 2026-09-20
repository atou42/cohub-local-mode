export const APP_RUNTIME_PROTOCOL = "cohub.app.runtime";
export const APP_RUNTIME_VERSION = 1;

type RuntimeEnvelope = {
	protocol: typeof APP_RUNTIME_PROTOCOL;
	version: typeof APP_RUNTIME_VERSION;
};

export type AppRuntimeReadyMessage = RuntimeEnvelope & {
	type: "ready";
};

/** The App asks its host to close the surface it runs in. */
export type AppRuntimeCloseRequestMessage = RuntimeEnvelope & {
	type: "close.request";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

export const parseAppRuntimeReady = (
	value: unknown,
): AppRuntimeReadyMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "ready"
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "ready",
	};
};

export const buildAppRuntimeReady = (): AppRuntimeReadyMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "ready",
});

export const parseAppRuntimeCloseRequest = (
	value: unknown,
): AppRuntimeCloseRequestMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "close.request"
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "close.request",
	};
};

export const buildAppRuntimeCloseRequest = (): AppRuntimeCloseRequestMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "close.request",
});

/** Axis-aligned rectangle in CSS pixels, overlay-local (top-left origin). */
export type AppRuntimeRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

/** Which corner of the overlay `geometry.x` / `geometry.y` are measured from. */
export type AppRuntimeAnchor =
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "center";

/**
 * The App asks its overlay host to change where it sits or where it accepts
 * pointer events. The host clamps geometry to the viewport; an axis without a
 * size fills the layer.
 *
 * `inputRegion`: `"none"` (default) makes the overlay click-through, `"all"`
 * makes it fully interactive, and a rect list limits interaction to those
 * overlay-local rectangles.
 *
 * `geometry` is the complete shape: a present object replaces the current one
 * (absent axes fall back to the default — `{}` fills the layer), and omitting
 * the field leaves the current geometry untouched.
 */
export type AppRuntimeConfigureRequest = RuntimeEnvelope & {
	type: "configure.request";
	geometry?: {
		anchor?: AppRuntimeAnchor;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
	inputRegion?: "all" | "none" | AppRuntimeRect[];
};

const ANCHORS: readonly AppRuntimeAnchor[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"center",
];

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const positive = (value: unknown): value is number => finite(value) && value > 0;

const parseRect = (value: unknown): AppRuntimeRect | null =>
	isRecord(value) &&
	finite(value.x) &&
	finite(value.y) &&
	positive(value.width) &&
	positive(value.height)
		? { x: value.x, y: value.y, width: value.width, height: value.height }
		: null;

export const parseAppRuntimeConfigureRequest = (
	value: unknown,
): AppRuntimeConfigureRequest | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "configure.request"
	) {
		return null;
	}
	const message: AppRuntimeConfigureRequest = {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "configure.request",
	};
	if (isRecord(value.geometry)) {
		const { anchor, x, y, width, height } = value.geometry;
		const valid =
			(anchor === undefined || ANCHORS.includes(anchor as AppRuntimeAnchor)) &&
			(x === undefined || finite(x)) &&
			(y === undefined || finite(y)) &&
			(width === undefined || positive(width)) &&
			(height === undefined || positive(height));
		// A malformed present field invalidates the whole shape. Dropping just
		// the bad axis would turn an invalid size into `{}` — i.e. a fill — and
		// could grow a fixed panel to the whole, interactive layer.
		if (valid) {
			message.geometry = {
				...(anchor !== undefined
					? { anchor: anchor as AppRuntimeAnchor }
					: {}),
				...(x !== undefined ? { x: x as number } : {}),
				...(y !== undefined ? { y: y as number } : {}),
				...(width !== undefined ? { width: width as number } : {}),
				...(height !== undefined ? { height: height as number } : {}),
			};
		}
	}
	if (value.inputRegion === "all" || value.inputRegion === "none") {
		message.inputRegion = value.inputRegion;
	} else if (Array.isArray(value.inputRegion)) {
		message.inputRegion = value.inputRegion
			.map(parseRect)
			.filter((rect): rect is AppRuntimeRect => rect !== null);
	}
	return message;
};

export const buildAppRuntimeConfigureRequest = (
	input: Omit<AppRuntimeConfigureRequest, keyof RuntimeEnvelope | "type">,
): AppRuntimeConfigureRequest => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "configure.request",
	...input,
});

/**
 * The App reports where the pointer is while its overlay owns it. A
 * cross-origin frame swallows pointer events for the whole window once the
 * host makes it interactive, so the host cannot tell whether a rect input
 * region is still hovered; the App — which sees those events — reports the
 * position instead, and the host releases the overlay when it leaves.
 *
 * Coordinates are frame-local CSS pixels (the same space as
 * `getBoundingClientRect()`), which equal overlay-local coordinates because the
 * frame fills the overlay. `down` keeps the host from releasing mid-drag.
 */
export type AppRuntimePointerMessage = RuntimeEnvelope & {
	type: "pointer";
	x: number;
	y: number;
	down: boolean;
};

export const buildAppRuntimePointer = (input: {
	x: number;
	y: number;
	down: boolean;
}): AppRuntimePointerMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "pointer",
	x: input.x,
	y: input.y,
	down: input.down,
});

export const parseAppRuntimePointer = (
	value: unknown,
): AppRuntimePointerMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "pointer" ||
		!finite(value.x) ||
		!finite(value.y)
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "pointer",
		x: value.x,
		y: value.y,
		down: value.down === true,
	};
};
