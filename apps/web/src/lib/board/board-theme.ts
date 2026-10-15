import type { BoardShapeColors } from "@neta-art/cohub/board";
import {
	BOARD_COLORS,
	boardColorCssVar,
	buildFallbackShapeColors,
} from "@neta-art/cohub/board";
import {
	type BoardRenderPalette,
	type BoardRenderStyle,
	defaultBoardRenderStyle,
} from "@neta-art/cohub/board/render";
import {
	IDENTITY_TONE_COUNT,
	identityToken,
	identityTone,
} from "$lib/avatar-identity";
import type { BoardThemeBackground } from "$lib/board/board-theme-background";
import { readCssColorNumber } from "$lib/board/css-color";
import { getResolvedTheme, type ResolvedTheme } from "$lib/theme.svelte";
import { isDarkTheme } from "$lib/theme-registry";

/**
 * The complete theme context used by a browser board. `colorScheme` is only a
 * fallback hint; the resolved palette and shape colors carry the actual theme.
 */
export {
	type BoardBackgroundLoadState,
	type BoardThemeBackground,
	resolveBoardBackground,
} from "$lib/board/board-theme-background";

export type BoardThemeSnapshot = {
	id: ResolvedTheme;
	key: string;
	colorScheme: "dark" | "light";
	palette: BoardRenderPalette;
	colors: BoardShapeColors;
	style: BoardRenderStyle;
	identity: readonly number[];
	background: BoardThemeBackground | null;
};

function cssNumber(
	host: Element | null | undefined,
	name: string,
	fallback: number,
	backdrop?: number,
): number {
	return readCssColorNumber(host, name, fallback, backdrop);
}

function readPalette(host: Element | null | undefined): BoardRenderPalette {
	const bg = cssNumber(host, "--board-bg", 0x141414);
	return {
		bg,
		surface: cssNumber(host, "--board-card", 0x202020, bg),
		hover: cssNumber(host, "--bg-hover", 0x2a2a2a, bg),
		border: cssNumber(host, "--border-subtle", 0x3a3a3a, bg),
		brand: cssNumber(host, "--board-selection-accent", 0xff3e00),
		text: cssNumber(host, "--text-primary", 0xf4f4f4, bg),
		muted: cssNumber(host, "--text-tertiary", 0x8c8c8c, bg),
		rare: cssNumber(host, "--info-400", 0x38bdf8),
		epic: cssNumber(host, "--info-500", 0xa78bfa),
		legendary: cssNumber(host, "--warning-400", 0xf59e0b),
	};
}

function readShapeColors(
	host: Element | null | undefined,
	colorScheme: "dark" | "light",
): BoardShapeColors {
	const fallback = buildFallbackShapeColors(colorScheme);
	const out = {} as BoardShapeColors;
	for (const entry of BOARD_COLORS) {
		const base = fallback[entry.id];
		out[entry.id] = {
			stroke: cssNumber(
				host,
				boardColorCssVar(entry.id, "stroke"),
				base.stroke,
			),
			fill: cssNumber(host, boardColorCssVar(entry.id, "fill"), base.fill),
			label: cssNumber(host, boardColorCssVar(entry.id, "label"), base.label),
		};
	}
	return out;
}

function readIdentity(
	host: Element | null | undefined,
	fallback: number,
): number[] {
	return Array.from({ length: IDENTITY_TONE_COUNT }, (_, index) =>
		cssNumber(host, identityToken(index + 1), fallback),
	);
}

export function boardIdentityColor(theme: BoardThemeSnapshot, seed: string) {
	const tone = identityTone(seed);
	return (tone && theme.identity[tone - 1]) ?? theme.palette.muted;
}

function cssToken(host: Element | null | undefined, name: string): string {
	const element =
		host ?? (typeof document !== "undefined" ? document.documentElement : null);
	return element ? getComputedStyle(element).getPropertyValue(name).trim() : "";
}

function cssStringToken(
	host: Element | null | undefined,
	name: string,
): string {
	const value = cssToken(host, name);
	if (!value) return "";
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === "string" ? parsed : "";
		} catch {
			return "";
		}
	}
	return value;
}

function cssPositiveNumberToken(
	host: Element | null | undefined,
	name: string,
): number | null {
	const value = Number.parseFloat(cssToken(host, name));
	return Number.isFinite(value) && value > 0 ? value : null;
}

function cssNumberToken(
	host: Element | null | undefined,
	name: string,
	fallback: number,
): number {
	const value = Number.parseFloat(cssToken(host, name));
	return Number.isFinite(value) ? value : fallback;
}

function cssEnumToken<T extends string>(
	host: Element | null | undefined,
	name: string,
	values: readonly T[],
	fallback: T,
): T {
	const value = cssToken(host, name);
	return (values as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function readStyle(
	host: Element | null | undefined,
	colorScheme: "dark" | "light",
): BoardRenderStyle {
	const base = defaultBoardRenderStyle(colorScheme);
	const shadowAlpha = cssNumberToken(
		host,
		"--board-card-shadow-opacity",
		base.shadow?.alpha ?? 0,
	);
	return {
		corner: cssEnumToken(
			host,
			"--board-card-corner",
			["round", "pixel"],
			base.corner,
		),
		radius: cssNumberToken(host, "--board-card-radius", base.radius),
		shadow:
			shadowAlpha > 0
				? {
						color: cssNumber(
							host,
							"--board-card-shadow-color",
							base.shadow?.color ?? 0,
						),
						alpha: shadowAlpha,
						blur: cssNumberToken(
							host,
							"--board-card-shadow-blur",
							base.shadow?.blur ?? 12,
						),
						y: cssNumberToken(
							host,
							"--board-card-shadow-y",
							base.shadow?.y ?? 0,
						),
					}
				: null,
		selection: {
			width: cssNumberToken(
				host,
				"--board-selection-width",
				base.selection.width,
			),
			outset: cssNumberToken(
				host,
				"--board-selection-outset",
				base.selection.outset,
			),
			dash: cssNumberToken(host, "--board-selection-dash", base.selection.dash),
			handle: cssEnumToken(
				host,
				"--board-selection-handle",
				["circle", "square"],
				base.selection.handle,
			),
			handleSize: cssNumberToken(
				host,
				"--board-selection-handle-size",
				base.selection.handleSize,
			),
		},
		media: cssEnumToken(host, "--board-media", ["plain", "framed"], base.media),
		progress: cssEnumToken(
			host,
			"--board-progress",
			["shimmer", "mosaic"],
			base.progress,
		),
		icons: cssEnumToken(host, "--board-icons", ["line", "pixel"], base.icons),
		motion: cssEnumToken(
			host,
			"--board-motion",
			["smooth", "stepped"],
			base.motion,
		),
		font: cssToken(host, "--board-font") || base.font,
	};
}

function readBackground(
	host: Element | null | undefined,
): BoardThemeBackground | null {
	const url = cssStringToken(host, "--board-background-image-url");
	if (!url) return null;
	return {
		url,
		tileWidth: cssPositiveNumberToken(host, "--board-background-tile-width"),
		tileHeight: cssPositiveNumberToken(host, "--board-background-tile-height"),
	};
}

/** Cheap identity read used to avoid resolving all CSS tokens every frame. */
export function boardThemeKey(
	host: Element | null | undefined,
	customThemeVersion = 0,
): string {
	const id = getResolvedTheme();
	return [
		id,
		customThemeVersion,
		cssToken(host, "--board-selection-accent"),
		cssToken(host, "--board-bg"),
		cssToken(host, "--board-background-image-url"),
		cssToken(host, "--board-background-tile-width"),
		cssToken(host, "--board-background-tile-height"),
	].join(":");
}

/** Resolve the full current Web theme into the values Pixi can consume. */
export function resolveBoardTheme(
	host: Element | null | undefined,
	customThemeVersion = 0,
	key = boardThemeKey(host, customThemeVersion),
): BoardThemeSnapshot {
	const id = getResolvedTheme();
	const colorScheme = isDarkTheme(id) ? "dark" : "light";
	const palette = readPalette(host);
	return {
		id,
		key,
		colorScheme,
		palette,
		colors: readShapeColors(host, colorScheme),
		style: readStyle(host, colorScheme),
		identity: readIdentity(host, palette.brand),
		background: readBackground(host),
	};
}
