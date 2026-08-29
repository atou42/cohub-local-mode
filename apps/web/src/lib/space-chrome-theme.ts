import {
	isDarkTheme,
	isResolvedTheme,
	type ResolvedTheme,
	THEME_COLOR,
} from "$lib/theme-registry";

const STATUS_BAR_COLOR_PROPERTY = "--cohub-status-bar-color";
const STATUS_BAR_COLOR_SOURCE_ATTR = "data-cohub-status-bar-color-source";
const STATUS_BAR_STYLE_PROPERTY = "--cohub-status-bar-style";
const STATUS_BAR_STYLE_ATTR = "data-cohub-status-bar-style";
const STATUS_BAR_STYLE_SOURCE_ATTR = "data-cohub-status-bar-style-source";
const DISALLOWED_STATUS_BAR_COLORS = new Set([
	"transparent",
	"currentcolor",
	"inherit",
	"initial",
	"unset",
	"revert",
	"revert-layer",
]);

type RootElement = Pick<
	HTMLElement,
	"getAttribute" | "setAttribute" | "removeAttribute"
>;
type MetaElement = Pick<HTMLMetaElement, "setAttribute">;
type StyleDeclaration = Pick<CSSStyleDeclaration, "getPropertyValue">;

type SyncSpaceChromeThemeOptions = {
	root?: RootElement;
	meta?: MetaElement | null;
	statusBarMeta?: MetaElement | null;
	getStyle?: (root: RootElement) => StyleDeclaration;
	supportsColor?: (value: string) => boolean;
};

export type SpaceStatusBarStyle = "light" | "dark";

function resolvedThemeFor(root: RootElement): ResolvedTheme {
	const theme = root.getAttribute("data-theme");
	return isResolvedTheme(theme) ? theme : "dark";
}

function validSpaceStatusBarColor(
	value: string,
	supportsColor: (value: string) => boolean,
) {
	const normalized = value.trim();
	if (!normalized) return null;
	if (DISALLOWED_STATUS_BAR_COLORS.has(normalized.toLowerCase())) return null;
	return supportsColor(normalized) ? normalized : null;
}

export function normalizeSpaceStatusBarColor(
	value: string,
	fallback: string,
	supportsColor: (value: string) => boolean,
) {
	return validSpaceStatusBarColor(value, supportsColor) ?? fallback;
}

export function normalizeSpaceStatusBarStyle(
	value: string,
	fallback: SpaceStatusBarStyle,
): SpaceStatusBarStyle {
	const normalized = value.trim().toLowerCase();
	return normalized === "light" || normalized === "dark"
		? normalized
		: fallback;
}

export function syncSpaceChromeTheme(
	options: SyncSpaceChromeThemeOptions = {},
): {
	color: string;
	colorSource: "space" | "theme";
	style: SpaceStatusBarStyle;
	styleSource: "space" | "theme";
} | null {
	if (typeof document === "undefined" && !options.root) return null;
	const root = options.root ?? document.documentElement;
	const meta =
		options.meta === undefined
			? document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
			: options.meta;
	const statusBarMeta =
		options.statusBarMeta === undefined
			? document.querySelector<HTMLMetaElement>(
					'meta[name="apple-mobile-web-app-status-bar-style"]',
				)
			: options.statusBarMeta;
	const getStyle =
		options.getStyle ??
		((target: RootElement) => getComputedStyle(target as HTMLElement));
	const supportsColor =
		options.supportsColor ??
		((value: string) =>
			typeof CSS !== "undefined" && CSS.supports("color", value));
	const theme = resolvedThemeFor(root);
	const fallback = THEME_COLOR[theme];
	const style = getStyle(root);
	const candidate = validSpaceStatusBarColor(
		style.getPropertyValue(STATUS_BAR_COLOR_PROPERTY),
		supportsColor,
	);
	const color = candidate ?? fallback;
	const styleValue = style
		.getPropertyValue(STATUS_BAR_STYLE_PROPERTY)
		.trim()
		.toLowerCase();
	const customStyle = styleValue === "light" || styleValue === "dark";
	const statusBarStyle = normalizeSpaceStatusBarStyle(
		styleValue,
		isDarkTheme(theme) ? "light" : "dark",
	);

	meta?.setAttribute("content", color);
	statusBarMeta?.setAttribute(
		"content",
		statusBarStyle === "light" ? "black-translucent" : "default",
	);
	root.setAttribute(STATUS_BAR_STYLE_ATTR, statusBarStyle);
	if (candidate) {
		root.setAttribute(STATUS_BAR_COLOR_SOURCE_ATTR, "space");
	} else {
		root.removeAttribute(STATUS_BAR_COLOR_SOURCE_ATTR);
	}
	if (customStyle) {
		root.setAttribute(STATUS_BAR_STYLE_SOURCE_ATTR, "space");
	} else {
		root.removeAttribute(STATUS_BAR_STYLE_SOURCE_ATTR);
	}
	return {
		color,
		colorSource: candidate ? "space" : "theme",
		style: statusBarStyle,
		styleSource: customStyle ? "space" : "theme",
	};
}
