<script lang="ts">
import {
	ChevronLeft,
	ChevronRight,
	Download,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-svelte";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";
import { fetchRelayMedia, protectedRelayMedia, publicMediaSource } from "$lib/protected-relay-media";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const locale = $derived(getLocale());
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
/** Discrete mouse-wheel notch (non-pinch). */
const WHEEL_STEP = 0.12;
/**
 * Trackpad pinch (ctrl/meta + wheel) exponential intensity.
 * Higher = more zoom per pixel of deltaY. ~0.01–0.02 feels natural on macOS.
 */
const PINCH_INTENSITY = 0.018;
/** Trackpad two-finger scroll zoom (no modifier) — gentler than pinch. */
const SCROLL_INTENSITY = 0.0035;

// ─── Zoom / pan (image only) ───
let zoom = $state(1);
let panX = $state(0);
let panY = $state(0);
let dragging = $state(false);
/** True while a continuous gesture (pinch / fine scroll) is active — skip CSS transition. */
let gestureZooming = $state(false);
let gestureZoomEndTimer: ReturnType<typeof setTimeout> | null = null;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginX = 0;
let dragOriginY = 0;

function markGestureZoom() {
	gestureZooming = true;
	if (gestureZoomEndTimer) clearTimeout(gestureZoomEndTimer);
	gestureZoomEndTimer = setTimeout(() => {
		gestureZooming = false;
		gestureZoomEndTimer = null;
	}, 80);
}

function clampZoom(value: number) {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function resetView() {
	zoom = 1;
	panX = 0;
	panY = 0;
	dragging = false;
}

function setZoom(next: number, options?: { resetPan?: boolean }) {
	const clamped = clampZoom(next);
	zoom = clamped;
	if (options?.resetPan || clamped <= 1) {
		panX = 0;
		panY = 0;
	}
}

function zoomBy(delta: number) {
	// Match workspace image preview: toolbar/wheel steps re-center the view.
	setZoom(zoom + delta, { resetPan: true });
}

// Reset view when switching media or closing.
$effect(() => {
	// Track index + open so view resets on either change.
	void mediaLightbox.index;
	void mediaLightbox.open;
	resetView();
});

// ─── Keyboard ───
$effect(() => {
	function onKey(e: KeyboardEvent) {
		if (!mediaLightbox.open) return;
		if (e.key === "Escape") mediaLightbox.close();
		if (e.key === "ArrowLeft" && zoom <= 1) mediaLightbox.prev();
		if (e.key === "ArrowRight" && zoom <= 1) mediaLightbox.next();
		if (e.key === "+" || e.key === "=") {
			e.preventDefault();
			zoomBy(ZOOM_STEP);
		}
		if (e.key === "-" || e.key === "_") {
			e.preventDefault();
			zoomBy(-ZOOM_STEP);
		}
		if (e.key === "0") {
			e.preventDefault();
			resetView();
		}
	}
	window.addEventListener("keydown", onKey);
	return () => window.removeEventListener("keydown", onKey);
});

// ─── Touch swipe (gallery) / pinch zoom ───
let swipeStartX = $state(0);
let swipeStartY = $state(0);
const pointers = new Map<number, { clientX: number; clientY: number }>();
let pinchStart: {
	distance: number;
	zoom: number;
	panX: number;
	panY: number;
} | null = null;
let panTouchStart: {
	pointerId: number;
	clientX: number;
	clientY: number;
	panX: number;
	panY: number;
} | null = null;

function pointerDistance(
	a: { clientX: number; clientY: number },
	b: { clientX: number; clientY: number },
) {
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function onTouchStart(e: TouchEvent) {
	if (e.target !== e.currentTarget) return;
	if (zoom > 1) return;
	swipeStartX = e.touches[0].clientX;
	swipeStartY = e.touches[0].clientY;
}

function onTouchEnd(e: TouchEvent) {
	if (e.target !== e.currentTarget) return;
	if (zoom > 1) return;
	const dx = e.changedTouches[0].clientX - swipeStartX;
	const dy = e.changedTouches[0].clientY - swipeStartY;
	if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
		dx > 0 ? mediaLightbox.prev() : mediaLightbox.next();
	}
}

function onImagePointerDown(e: PointerEvent) {
	if (mediaLightbox.current?.type !== "image") return;
	// Left button / touch only — keep right-click for browser image context menu.
	if (e.pointerType === "mouse" && e.button !== 0) return;
	// Ignore events that start on chrome (toolbar etc. sits above); stage/img only.
	const target = e.target as HTMLElement | null;
	if (target && target !== e.currentTarget && target.tagName !== "IMG") return;

	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

	if (pointers.size === 2) {
		const [a, b] = [...pointers.values()];
		pinchStart = {
			distance: pointerDistance(a, b),
			zoom,
			panX,
			panY,
		};
		panTouchStart = null;
		dragging = false;
		return;
	}

	if (zoom > 1) {
		e.preventDefault();
		dragging = true;
		panTouchStart = {
			pointerId: e.pointerId,
			clientX: e.clientX,
			clientY: e.clientY,
			panX,
			panY,
		};
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		dragOriginX = panX;
		dragOriginY = panY;
	}
}

function onImagePointerMove(e: PointerEvent) {
	if (!pointers.has(e.pointerId)) return;
	pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

	if (pointers.size >= 2 && pinchStart) {
		const [a, b] = [...pointers.values()];
		if (!a || !b || pinchStart.distance <= 0) return;
		e.preventDefault();
		markGestureZoom();
		const next = clampZoom(
			pinchStart.zoom * (pointerDistance(a, b) / pinchStart.distance),
		);
		zoom = next;
		if (next <= 1) {
			panX = 0;
			panY = 0;
		}
		return;
	}

	if (!panTouchStart || panTouchStart.pointerId !== e.pointerId) return;
	if (zoom <= 1) return;
	e.preventDefault();
	panX = panTouchStart.panX + (e.clientX - panTouchStart.clientX);
	panY = panTouchStart.panY + (e.clientY - panTouchStart.clientY);
}

function onImagePointerUp(e: PointerEvent) {
	pointers.delete(e.pointerId);
	const target = e.currentTarget as HTMLElement;
	if (target.hasPointerCapture(e.pointerId)) {
		target.releasePointerCapture(e.pointerId);
	}

	if (pointers.size < 2) pinchStart = null;

	if (panTouchStart?.pointerId === e.pointerId) {
		panTouchStart = null;
		dragging = false;
	}

	// Resume single-finger pan if one pointer remains while zoomed.
	if (pointers.size === 1 && zoom > 1) {
		const [pointerId, pointer] = [...pointers.entries()][0];
		panTouchStart = {
			pointerId,
			clientX: pointer.clientX,
			clientY: pointer.clientY,
			panX,
			panY,
		};
		dragging = true;
	}
}

// ─── Mouse pan (desktop) ───
function onImageMouseDown(e: MouseEvent) {
	// Pointer events already cover modern browsers; keep mouse path as fallback
	// only when pointer events are unavailable.
	if (window.PointerEvent) return;
	if (zoom <= 1) return;
	if (e.button !== 0) return;
	e.preventDefault();
	dragging = true;
	dragStartX = e.clientX;
	dragStartY = e.clientY;
	dragOriginX = panX;
	dragOriginY = panY;
	document.addEventListener("mousemove", onImageMouseMove);
	document.addEventListener("mouseup", onImageMouseUp);
}

function onImageMouseMove(e: MouseEvent) {
	if (!dragging) return;
	panX = dragOriginX + (e.clientX - dragStartX);
	panY = dragOriginY + (e.clientY - dragStartY);
}

function onImageMouseUp() {
	dragging = false;
	document.removeEventListener("mousemove", onImageMouseMove);
	document.removeEventListener("mouseup", onImageMouseUp);
}

function normalizeWheelDelta(e: WheelEvent) {
	let delta = e.deltaY;
	// 0 = pixels, 1 = lines, 2 = pages
	if (e.deltaMode === 1) delta *= 16;
	if (e.deltaMode === 2) delta *= 80;
	return delta;
}

function onImageWheel(e: WheelEvent) {
	if (mediaLightbox.current?.type !== "image") return;
	e.preventDefault();
	e.stopPropagation();

	const delta = normalizeWheelDelta(e);
	if (delta === 0) return;

	// Trackpad pinch-to-zoom is reported as wheel + ctrlKey (Chrome/Safari/Firefox).
	// Use continuous exponential scaling so small deltas accumulate smoothly.
	const isPinch = e.ctrlKey || e.metaKey;
	if (isPinch) {
		markGestureZoom();
		setZoom(zoom * Math.exp(-delta * PINCH_INTENSITY), { resetPan: false });
		return;
	}

	// Large discrete notches (classic mouse wheel) → stepped zoom + re-center.
	if (Math.abs(delta) >= 40) {
		setZoom(zoom + (delta < 0 ? WHEEL_STEP : -WHEEL_STEP), {
			resetPan: true,
		});
		return;
	}

	// Fine trackpad scroll without pinch → continuous, keep pan.
	markGestureZoom();
	setZoom(zoom * Math.exp(-delta * SCROLL_INTENSITY), { resetPan: false });
}

let imageStageEl = $state<HTMLDivElement | null>(null);
let imageEl = $state<HTMLImageElement | null>(null);

function isPointInsideImage(clientX: number, clientY: number) {
	const img = imageEl;
	if (!img) return false;
	const rect = img.getBoundingClientRect();
	return (
		clientX >= rect.left &&
		clientX <= rect.right &&
		clientY >= rect.top &&
		clientY <= rect.bottom
	);
}

/** Close only when clicking the dimmed area outside the media bounds. */
function onStageClick(e: MouseEvent) {
	if (dragging) return;
	// Ignore clicks that land on the image itself (including while zoomed).
	if (isPointInsideImage(e.clientX, e.clientY)) return;
	mediaLightbox.close();
}

// Non-passive wheel listener so trackpad pinch / scroll zoom can preventDefault.
$effect(() => {
	const el = imageStageEl;
	if (!el) return;
	el.addEventListener("wheel", onImageWheel, { passive: false });
	return () => el.removeEventListener("wheel", onImageWheel);
});

// ─── Backdrop ───
function onBackdropClick(e: MouseEvent) {
	if (e.target === e.currentTarget) mediaLightbox.close();
}

function onBackdropKeyDown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		mediaLightbox.close();
	}
}

// ─── Lock body scroll ───
$effect(() => {
	if (!mediaLightbox.open) return;
	const original = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	return () => {
		document.body.style.overflow = original;
	};
});

// ─── Download ───
let downloading = $state(false);
let downloadError = $state<string | null>(null);

async function handleDownload() {
	const item = mediaLightbox.current;
	if (!item || downloading) return;

	downloading = true;
	downloadError = null;
	try {
		const filename = extractFilename(item.src, item.alt);
		const blob = item.src.startsWith("data:")
			? await dataUrlToBlob(item.src)
			: await fetchUrlAsBlob(item.src);

		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	} catch (err) {
		downloadError = err instanceof Error ? err.message : "Download failed";
	} finally {
		downloading = false;
	}
}

function extractFilename(src: string, fallback?: string): string {
	if (fallback) return fallback;
	try {
		const pathname = new URL(src).pathname;
		const name = pathname.split("/").filter(Boolean).pop();
		if (name) return decodeURIComponent(name);
	} catch {
		// ignore
	}
	return "download";
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
	const res = await fetch(dataUrl);
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);
	return res.blob();
}

async function fetchUrlAsBlob(url: string): Promise<Blob> {
	const res = await fetchRelayMedia(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);
	return res.blob();
}

const imageCursor = $derived(
	dragging ? "grabbing" : zoom > 1 ? "grab" : "zoom-in",
);
</script>

{#if mediaLightbox.open && mediaLightbox.current}
	<div
		class="fixed inset-0 z-[9999] flex items-center justify-center bg-overlay-scrim-strong"
		onclick={onBackdropClick}
		onkeydown={onBackdropKeyDown}
		ontouchstart={onTouchStart}
		ontouchend={onTouchEnd}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-label={m.media_preview({}, { locale })}
	>
		<!-- Top toolbar -->
		<div class="absolute top-3 right-3 z-10 flex items-center gap-2 sm:top-4 sm:right-4">
			{#if mediaLightbox.current.type === "image"}
				<div class="flex items-center gap-1 rounded-full bg-overlay-control px-1.5 py-1">
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-full text-overlay-control-text hover:bg-overlay-control-hover transition-colors disabled:opacity-40"
						onclick={() => zoomBy(-ZOOM_STEP)}
						disabled={zoom <= MIN_ZOOM}
						title={m.media_zoom_out({}, { locale })}
						aria-label={m.media_zoom_out({}, { locale })}
					>
						<ZoomOut class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="min-w-11 px-1 text-center text-[12px] tabular-nums text-overlay-control-text hover:bg-overlay-control-hover rounded-full transition-colors"
						onclick={resetView}
						title={m.media_reset_zoom({}, { locale })}
						aria-label={`Zoom ${Math.round(zoom * 100)} percent. Click to reset`}
					>
						{Math.round(zoom * 100)}%
					</button>
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-full text-overlay-control-text hover:bg-overlay-control-hover transition-colors disabled:opacity-40"
						onclick={() => zoomBy(ZOOM_STEP)}
						disabled={zoom >= MAX_ZOOM}
						title={m.media_zoom_in({}, { locale })}
						aria-label={m.media_zoom_in({}, { locale })}
					>
						<ZoomIn class="w-4 h-4" />
					</button>
				</div>
			{/if}
			<!-- Download button -->
			<button
				type="button"
				class="flex items-center justify-center w-9 h-9 rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover transition-colors disabled:opacity-50"
				onclick={handleDownload}
				disabled={downloading}
				title={m.media_download({}, { locale })}
			>
				{#if downloading}
					<svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
				{:else}
					<Download class="w-5 h-5" />
				{/if}
			</button>
			<!-- Close button -->
			<button
				type="button"
				class="flex items-center justify-center w-9 h-9 rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover transition-colors"
				onclick={() => mediaLightbox.close()}
			>
				<X class="w-5 h-5" />
			</button>
		</div>

		<!-- Nav arrows (desktop only, multi-item, only when not zoomed) -->
		{#if mediaLightbox.items.length > 1 && zoom <= 1}
			<button
				type="button"
				class="absolute left-3 z-10 hidden items-center justify-center w-9 h-9 rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover transition-colors sm:flex sm:top-1/2 sm:-translate-y-1/2 sm:left-4"
				onclick={() => mediaLightbox.prev()}
			>
				<ChevronLeft class="w-5 h-5" />
			</button>
			<button
				type="button"
				class="absolute right-3 z-10 hidden items-center justify-center w-9 h-9 rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover transition-colors sm:flex sm:top-1/2 sm:-translate-y-1/2 sm:right-4"
				onclick={() => mediaLightbox.next()}
			>
				<ChevronRight class="w-5 h-5" />
			</button>
		{/if}

		<!-- Media -->
		{#if mediaLightbox.current.type === "image"}
			<div
				bind:this={imageStageEl}
				class="absolute inset-0 z-0 flex items-center justify-center overflow-hidden"
				role="button"
				tabindex="0"
				aria-label={m.media_image_hint({}, { locale })}
				style:cursor={imageCursor}
				onclick={onStageClick}
				onkeydown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						mediaLightbox.close();
					}
					if (e.key === "Enter" || e.key === " ") {
						// Space/Enter reset zoom when focused on the stage.
						if (zoom !== 1 || panX !== 0 || panY !== 0) {
							e.preventDefault();
							resetView();
						}
					}
				}}
				onpointerdown={onImagePointerDown}
				onpointermove={onImagePointerMove}
				onpointerup={onImagePointerUp}
				onpointercancel={onImagePointerUp}
				onmousedown={onImageMouseDown}
				ondblclick={resetView}
			>
				<img
					bind:this={imageEl}
					src={publicMediaSource(mediaLightbox.current.src)}
					use:protectedRelayMedia={mediaLightbox.current.src}
					alt={mediaLightbox.current.alt ?? ""}
					draggable="false"
					style={`transform: translate(${panX}px, ${panY}px) scale(${zoom}); ${dragging || gestureZooming ? "" : "transition: transform 120ms ease-out;"}`}
					class="max-w-[90vw] max-h-[85vh] object-contain rounded-lg select-none"
				/>
			</div>
		{:else}
			<div class="w-full max-w-[95vw] max-h-[85vh] rounded-lg" role="presentation" onclick={(e) => e.stopPropagation()}>
				<!-- svelte-ignore a11y_media_has_caption: User-generated preview videos do not provide caption tracks. -->
				<video
					src={publicMediaSource(mediaLightbox.current.src)}
					use:protectedRelayMedia={mediaLightbox.current.src}
					poster={mediaLightbox.current.poster}
					controls
					autoplay
					playsinline
					aria-label={mediaLightbox.current.alt ?? "Video preview"}
					class="w-full max-w-[95vw] max-h-[85vh] rounded-lg"
				>
				</video>
			</div>
		{/if}

		<!-- Download error hint -->
		{#if downloadError}
			<div class="absolute bottom-16 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-error text-error-fg text-[13px] whitespace-nowrap">
				{downloadError}
			</div>
		{/if}

		<!-- Dots indicator (multi-item) -->
		{#if mediaLightbox.items.length > 1}
			<div class="absolute bottom-6 flex items-center gap-1.5 {downloadError ? 'bottom-24' : ''}">
				{#each mediaLightbox.items as _, i}
					<span
						class="block w-1.5 h-1.5 rounded-full transition-colors {i === mediaLightbox.index ? 'bg-overlay-control-text' : 'bg-overlay-control-hover'}"
					></span>
				{/each}
			</div>
		{/if}
	</div>
{/if}
