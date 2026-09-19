import { SPACE_CUSTOM_THEME_CSS_PATH } from "@cohub/protocol";
import { HttpError, type SpaceFsFileResponse } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { syncSpaceChromeTheme } from "$lib/space-chrome-theme";

const SPACE_STYLE_NODE_ATTR = "data-cohub-space-style";
const SPACE_STYLE_ACTIVE_ATTR = "data-cohub-space-style-active";
const SPACE_STYLE_SPACE_ATTR = "data-space-id";
const MAX_RETRY_ATTEMPTS = 5;
const RETRYABLE_ERROR_DELAY_MS = 1200;
export const SPACE_STYLE_CHANGED_EVENT = "cohub:space-style-changed";

type CachedSpaceStyle =
	| { type: "inline"; content: string }
	| { type: "url"; href: string };

let activeSpaceId: string | null = null;
let activeVersion = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function getCacheKey(spaceId: string) {
	return `cohub:space-style:${spaceId}:v1`;
}

function readCachedSpaceStyle(spaceId: string): CachedSpaceStyle | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(getCacheKey(spaceId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if (record.type === "inline" && typeof record.content === "string") {
			return { type: "inline", content: record.content };
		}
		if (record.type === "url" && typeof record.href === "string") {
			return { type: "url", href: record.href };
		}
	} catch {
		// Ignore malformed or unavailable storage.
	}
	return null;
}

function writeCachedSpaceStyle(spaceId: string, style: CachedSpaceStyle) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(getCacheKey(spaceId), JSON.stringify(style));
	} catch {
		// Cache writes are best-effort and should never block workspace boot.
	}
}

function clearCachedSpaceStyle(spaceId: string) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(getCacheKey(spaceId));
	} catch {
		// ignore
	}
}

function clearRetryTimer() {
	if (!retryTimer) return;
	clearTimeout(retryTimer);
	retryTimer = null;
}

function notifySpaceStyleChanged(spaceId: string | null) {
	if (typeof window === "undefined") return;
	syncSpaceChromeTheme();
	window.dispatchEvent(
		new CustomEvent(SPACE_STYLE_CHANGED_EVENT, {
			detail: { spaceId },
		}),
	);
}

function removeSpaceStyleNodes(notify = false) {
	if (typeof document === "undefined") return;
	for (const node of document.querySelectorAll(`[${SPACE_STYLE_NODE_ATTR}]`)) {
		node.remove();
	}
	document.documentElement.removeAttribute(SPACE_STYLE_ACTIVE_ATTR);
	document.documentElement.removeAttribute(SPACE_STYLE_SPACE_ATTR);
	if (notify) notifySpaceStyleChanged(null);
}

function markActiveSpaceStyle(spaceId: string) {
	document.documentElement.setAttribute(SPACE_STYLE_ACTIVE_ATTR, "true");
	document.documentElement.setAttribute(SPACE_STYLE_SPACE_ATTR, spaceId);
}

function installLinkedStyle(spaceId: string, href: string, version: number) {
	removeSpaceStyleNodes();
	if (activeVersion !== version || activeSpaceId !== spaceId) return;
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = href;
	link.setAttribute(SPACE_STYLE_NODE_ATTR, "true");
	link.setAttribute(SPACE_STYLE_SPACE_ATTR, spaceId);
	document.head.append(link);
	markActiveSpaceStyle(spaceId);
	// A linked stylesheet may not have applied when it is appended. Notify once
	// more after load so board snapshots never cache the pre-style colors.
	link.addEventListener("load", () => {
		if (activeVersion === version && activeSpaceId === spaceId)
			notifySpaceStyleChanged(spaceId);
	});
	notifySpaceStyleChanged(spaceId);
}

function installInlineStyle(spaceId: string, content: string, version: number) {
	removeSpaceStyleNodes();
	if (activeVersion !== version || activeSpaceId !== spaceId) return;
	const style = document.createElement("style");
	style.textContent = content;
	style.setAttribute(SPACE_STYLE_NODE_ATTR, "true");
	style.setAttribute(SPACE_STYLE_SPACE_ATTR, spaceId);
	document.head.append(style);
	markActiveSpaceStyle(spaceId);
	notifySpaceStyleChanged(spaceId);
}

function installCachedSpaceStyle(spaceId: string, version: number) {
	const cached = readCachedSpaceStyle(spaceId);
	if (!cached) return;
	if (cached.type === "url") {
		installLinkedStyle(spaceId, cached.href, version);
		return;
	}
	installInlineStyle(spaceId, cached.content, version);
}

function getFileContent(file: SpaceFsFileResponse) {
	return file.encoding === "base64" ? atob(file.content) : file.content;
}

function scheduleRetry(
	spaceId: string,
	version: number,
	attempt: number,
	delayMs: number,
) {
	if (attempt >= MAX_RETRY_ATTEMPTS) return;
	clearRetryTimer();
	retryTimer = setTimeout(
		() => {
			retryTimer = null;
			if (activeVersion !== version || activeSpaceId !== spaceId) return;
			void loadSpaceStyle(spaceId, { version, attempt: attempt + 1 });
		},
		Math.max(250, delayMs),
	);
}

async function loadSpaceStyle(
	spaceId: string,
	options: { version: number; attempt?: number },
) {
	const attempt = options.attempt ?? 0;
	try {
		const file = await sdk
			.space(spaceId)
			.files.read(SPACE_CUSTOM_THEME_CSS_PATH);
		if (activeVersion !== options.version || activeSpaceId !== spaceId) return;
		if (!("content" in file)) {
			scheduleRetry(spaceId, options.version, attempt, file.retryAfterMs);
			return;
		}
		if (file.delivery === "url" && file.url) {
			writeCachedSpaceStyle(spaceId, { type: "url", href: file.url });
			installLinkedStyle(spaceId, file.url, options.version);
			return;
		}
		const content = getFileContent(file);
		writeCachedSpaceStyle(spaceId, { type: "inline", content });
		installInlineStyle(spaceId, content, options.version);
	} catch (error) {
		if (activeVersion !== options.version || activeSpaceId !== spaceId) return;
		if (error instanceof HttpError && error.status === 404) {
			clearCachedSpaceStyle(spaceId);
			removeSpaceStyleNodes(true);
			return;
		}
		const isRetryableHttpError =
			error instanceof HttpError &&
			(error.status === 408 || error.status === 429 || error.status >= 500);
		if (!(error instanceof HttpError) || isRetryableHttpError) {
			scheduleRetry(
				spaceId,
				options.version,
				attempt,
				RETRYABLE_ERROR_DELAY_MS * 2 ** attempt,
			);
		}
		// Custom styles should never block the workspace. Keep the default theme.
	}
}

export function activateSpaceStyle(spaceId: string) {
	if (typeof document === "undefined") return;
	// Layout effects can rerun while the current route data is updating. Keep
	// activation idempotent so those updates do not refetch the same stylesheet.
	if (activeSpaceId === spaceId) return;
	clearRetryTimer();
	activeSpaceId = spaceId;
	activeVersion += 1;
	removeSpaceStyleNodes(true);
	installCachedSpaceStyle(spaceId, activeVersion);
	void loadSpaceStyle(spaceId, { version: activeVersion });
}

export function refreshSpaceStyle(spaceId: string) {
	if (typeof document === "undefined") return;
	if (activeSpaceId !== spaceId) return;
	clearRetryTimer();
	activeVersion += 1;
	void loadSpaceStyle(spaceId, { version: activeVersion });
}

export function deactivateSpaceStyle(spaceId?: string) {
	if (spaceId && activeSpaceId !== spaceId) return;
	clearRetryTimer();
	activeSpaceId = null;
	activeVersion += 1;
	removeSpaceStyleNodes(true);
}

export function isSpaceStylePath(path: string | null | undefined) {
	return (
		path?.replace(/\\/g, "/").replace(/^\.\/+/, "") ===
		SPACE_CUSTOM_THEME_CSS_PATH
	);
}
