import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	normalizeSpaceStatusBarColor,
	normalizeSpaceStatusBarStyle,
	syncSpaceChromeTheme,
} from "$lib/space-chrome-theme";

test("normalizeSpaceStatusBarColor accepts a supported opaque color", () => {
	assert.equal(
		normalizeSpaceStatusBarColor(" oklch(42% 0.1 250) ", "#1F2026", () => true),
		"oklch(42% 0.1 250)",
	);
});

test("normalizeSpaceStatusBarColor rejects missing, invalid, and transparent values", () => {
	const supportsColor = (value: string) => value.startsWith("rgb(");
	assert.equal(
		normalizeSpaceStatusBarColor("", "#1F2026", supportsColor),
		"#1F2026",
	);
	assert.equal(
		normalizeSpaceStatusBarColor("not-a-color", "#1F2026", supportsColor),
		"#1F2026",
	);
	assert.equal(
		normalizeSpaceStatusBarColor("transparent", "#1F2026", () => true),
		"#1F2026",
	);
});

test("normalizeSpaceStatusBarStyle accepts light and dark but restores auto and invalid values", () => {
	assert.equal(normalizeSpaceStatusBarStyle(" light ", "dark"), "light");
	assert.equal(normalizeSpaceStatusBarStyle("dark", "light"), "dark");
	assert.equal(normalizeSpaceStatusBarStyle("auto", "dark"), "dark");
	assert.equal(normalizeSpaceStatusBarStyle("sideways", "light"), "light");
});

test("syncSpaceChromeTheme applies Space color without leaving full-bleed mode", () => {
	const attributes = new Map<string, string>([["data-theme", "light"]]);
	const root = {
		getAttribute: (name: string) => attributes.get(name) ?? null,
		setAttribute: (name: string, value: string) => attributes.set(name, value),
		removeAttribute: (name: string) => attributes.delete(name),
	};
	let customColor = "rgb(18 52 86)";
	let customStyle = "light";
	let metaColor = "";
	let appleStatusBarStyle = "";
	const meta = {
		setAttribute: (name: string, value: string) => {
			if (name === "content") metaColor = value;
		},
	};
	const statusBarMeta = {
		setAttribute: (name: string, value: string) => {
			if (name === "content") appleStatusBarStyle = value;
		},
	};
	const getStyle = () => ({
		getPropertyValue: (property: string) =>
			property === "--cohub-status-bar-color" ? customColor : customStyle,
	});

	assert.deepEqual(
		syncSpaceChromeTheme({
			root,
			meta,
			statusBarMeta,
			getStyle,
			supportsColor: () => true,
		}),
		{
			color: "rgb(18 52 86)",
			colorSource: "space",
			style: "light",
			styleSource: "space",
		},
	);
	assert.equal(metaColor, "rgb(18 52 86)");
	assert.equal(appleStatusBarStyle, "black-translucent");
	assert.equal(attributes.get("data-cohub-status-bar-color-source"), "space");
	assert.equal(attributes.get("data-cohub-status-bar-style"), "light");
	assert.equal(attributes.get("data-cohub-status-bar-style-source"), "space");

	customColor = "transparent";
	customStyle = "sideways";
	assert.deepEqual(
		syncSpaceChromeTheme({
			root,
			meta,
			statusBarMeta,
			getStyle,
			supportsColor: () => true,
		}),
		{
			color: "#F8F8FA",
			colorSource: "theme",
			style: "dark",
			styleSource: "theme",
		},
	);
	assert.equal(metaColor, "#F8F8FA");
	assert.equal(appleStatusBarStyle, "black-translucent");
	assert.equal(attributes.has("data-cohub-status-bar-color-source"), false);
	assert.equal(attributes.get("data-cohub-status-bar-style"), "dark");
	assert.equal(attributes.has("data-cohub-status-bar-style-source"), false);
});

test("syncSpaceChromeTheme still resolves state when optional meta tags are absent", () => {
	const attributes = new Map<string, string>([["data-theme", "dark"]]);
	const root = {
		getAttribute: (name: string) => attributes.get(name) ?? null,
		setAttribute: (name: string, value: string) => attributes.set(name, value),
		removeAttribute: (name: string) => attributes.delete(name),
	};
	assert.deepEqual(
		syncSpaceChromeTheme({
			root,
			meta: null,
			statusBarMeta: null,
			getStyle: () => ({ getPropertyValue: () => "" }),
			supportsColor: () => false,
		}),
		{
			color: "#1F2026",
			colorSource: "theme",
			style: "light",
			styleSource: "theme",
		},
	);
});

test("the app shell opts into full-bleed viewport layout and protects its content", () => {
	const appHtml = readFileSync(new URL("../app.html", import.meta.url), "utf8");
	const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
	const appLayout = readFileSync(
		new URL("../routes/(app)/+layout.svelte", import.meta.url),
		"utf8",
	);
	const sessionComposer = readFileSync(
		new URL("../lib/components/SessionComposer.svelte", import.meta.url),
		"utf8",
	);

	assert.match(appHtml, /viewport-fit=cover/);
	assert.match(
		appHtml,
		/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/,
	);
	assert.doesNotMatch(
		appHtml,
		/querySelector\('meta\[name="apple-mobile-web-app-status-bar-style"\]'\)/,
	);
	assert.match(
		appCss,
		/--cohub-safe-area-top:\s*env\(safe-area-inset-top, 0px\)/,
	);
	assert.match(appCss, /padding-top:\s*var\(--cohub-safe-area-top\)/);
	assert.match(
		appCss,
		/background:\s*var\(--cohub-safe-area-background, transparent\)/,
	);
	assert.match(
		appCss,
		/\.app-shell-viewport\s*{[^}]*height:\s*var\(--cohub-app-shell-height, 100dvh\)/s,
	);
	assert.match(appLayout, /use:iosStandaloneViewportRecovery/);
	assert.doesNotMatch(appLayout, /app-shell h-\[100dvh\]/);
	assert.match(sessionComposer, /class="px-2 pb-3 pt-2 sm:px-4 sm:pb-4"/);
	assert.doesNotMatch(
		sessionComposer,
		/pb-\[calc\(0\.75rem\+env\(safe-area-inset-bottom\)\)\]/,
	);
});
