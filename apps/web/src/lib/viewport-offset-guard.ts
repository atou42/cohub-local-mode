/**
 * Viewport offset guard for the fixed-height app shell.
 *
 * The shell fills the viewport through the `html → body → .app-shell`
 * `height: 100%` chain with `overflow: hidden`, so the document itself must
 * never scroll. Mobile browsers still pan the visual viewport (and bump
 * `window.scrollY`) to keep a focused input visible above the soft keyboard,
 * and some Android Chrome / PWA builds fail to pan back when the keyboard
 * closes — the whole shell ends up shifted up, exposing the root canvas at
 * the bottom.
 *
 * The document is only snapped back when it is safe to do so: no input is
 * focused (the keyboard is closing or closed) and the page is not pinch-zoomed
 * (a zoomed user legitimately pans the visual viewport). Keyboard geometry is
 * deliberately not inspected — with `interactive-widget=resizes-content` the
 * layout viewport shrinks alongside the visual one, so height comparisons
 * cannot tell an open keyboard from a closed one.
 */

function isDocumentOffset(): boolean {
	const vv = window.visualViewport;
	return (
		window.scrollY > 0 ||
		window.scrollX > 0 ||
		(vv !== null && (vv.offsetTop > 0 || vv.pageTop > 0))
	);
}

function isEditableFocused(): boolean {
	const el = document.activeElement;
	if (!el) return false;
	const tag = el.tagName;
	return (
		tag === "INPUT" ||
		tag === "TEXTAREA" ||
		el.getAttribute("contenteditable") !== null
	);
}

function isPinchZoomed(): boolean {
	const vv = window.visualViewport;
	return vv !== null && Math.abs(vv.scale - 1) > 0.01;
}

function snapDocumentToOrigin() {
	if (isEditableFocused() || isPinchZoomed() || !isDocumentOffset()) return;
	window.scrollTo(0, 0);
}

/**
 * Install the guard. Returns a cleanup function; safe to call multiple times
 * as long as each call's cleanup runs.
 */
export function installViewportOffsetGuard(): () => void {
	if (typeof window === "undefined") return () => {};

	let disposed = false;
	let pending = false;
	const timers = new Set<number>();

	const schedule = () => {
		if (disposed || pending) return;
		pending = true;
		requestAnimationFrame(() => {
			pending = false;
			if (!disposed) snapDocumentToOrigin();
		});
	};
	const scheduleAfter = (ms: number) => {
		const id = window.setTimeout(() => {
			timers.delete(id);
			schedule();
		}, ms);
		timers.add(id);
	};

	// Keyboard close: visual viewport grows back to layout height.
	const vv = window.visualViewport;
	vv?.addEventListener("resize", schedule);
	// Layout viewport change (resizes-content mode) or orientation.
	window.addEventListener("resize", schedule);
	// Input released — keyboard is about to close; re-check after the viewport
	// animation settles (two extra passes cover slow Android chrome animations).
	const handleFocusOut = () => {
		schedule();
		scheduleAfter(120);
		scheduleAfter(360);
	};
	document.addEventListener("focusout", handleFocusOut, true);

	return () => {
		disposed = true;
		for (const id of timers) window.clearTimeout(id);
		timers.clear();
		vv?.removeEventListener("resize", schedule);
		window.removeEventListener("resize", schedule);
		document.removeEventListener("focusout", handleFocusOut, true);
	};
}
