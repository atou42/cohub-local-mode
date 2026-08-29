import { syncSpaceChromeTheme } from "$lib/space-chrome-theme";
import {
	getSystemTheme,
	isThemeMode,
	type ResolvedTheme,
	resolveThemeMode,
	THEME_STORAGE_KEY,
	type ThemeMode,
} from "$lib/theme-registry";

export type { ResolvedTheme, ThemeMode } from "$lib/theme-registry";

// --- Reactive state (Svelte 5 runes) ---
let _mode = $state<ThemeMode>("system");
let _resolved = $state<ResolvedTheme>("dark");

/** Update reactive state + DOM attribute. Called on init, user action, and system change. */
function applyTheme(mode: ThemeMode, skipDom = false) {
	const resolved = resolveThemeMode(mode);
	_mode = mode;
	_resolved = resolved;
	if (!skipDom && typeof document !== "undefined") {
		document.documentElement.setAttribute("data-theme", resolved);
		syncSpaceChromeTheme();
	}
}

// --- Public reactive getters ---
export function getTheme(): ThemeMode {
	return _mode;
}

export function getResolvedTheme(): ResolvedTheme {
	return _resolved;
}

// --- Theme mutation ---
export function setTheme(mode: ThemeMode) {
	if (typeof localStorage !== "undefined") {
		localStorage.setItem(THEME_STORAGE_KEY, mode);
	}
	applyTheme(mode);
}

// --- Initialization ---
if (typeof window !== "undefined") {
	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	const initial: ThemeMode = isThemeMode(stored) ? stored : "system";

	// app.html inline script already set data-theme before JS loads —
	// skip redundant DOM write here, only sync reactive state.
	applyTheme(initial, true);

	// React to system preference changes (only affects "system" mode).
	// applyTheme("system") resolves via getSystemTheme() and updates both
	// _resolved state and the DOM attribute.
	window
		.matchMedia("(prefers-color-scheme: dark)")
		.addEventListener("change", () => {
			if (_mode === "system") {
				applyTheme("system");
			}
		});
}

export { getSystemTheme };
