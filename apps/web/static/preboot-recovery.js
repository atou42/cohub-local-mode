(() => {
	var RETRY_KEY = "cohub:preboot-recovery-attempted";
	var STALE_IMPORT_KEY = "cohub:failed-dynamic-import";
	var SERVER_ERROR_KEY = "cohub:server-error-recovery";
	var BOOT_TIMEOUT_MS = 15_000;
	var WORKER_CONTROL_TIMEOUT_MS = 3_000;
	var WORKER_CHECK_INTERVAL_MS = 30_000;
	var failureStarted = false;
	var lastWorkerCheck = 0;
	var bootTimer = null;

	function readRetryMarker() {
		try {
			return sessionStorage.getItem(RETRY_KEY) === "1";
		} catch (_error) {
			return null;
		}
	}

	function writeRetryMarker() {
		try {
			sessionStorage.setItem(RETRY_KEY, "1");
			return true;
		} catch (_error) {
			return false;
		}
	}

	function clearRecoveryMarkers() {
		try {
			sessionStorage.removeItem(RETRY_KEY);
			sessionStorage.removeItem(STALE_IMPORT_KEY);
			sessionStorage.removeItem(SERVER_ERROR_KEY);
		} catch (_error) {
			// A healthy app must not fail because storage is unavailable.
		}
	}

	function replacePageOnce() {
		if (window.__cohubServiceWorkerReloading) return;
		window.__cohubServiceWorkerReloading = true;
		location.replace(location.href);
	}

	function waitForControllerChange() {
		if (!("serviceWorker" in navigator)) return Promise.resolve(false);
		return new Promise((resolve) => {
			var settled = false;
			var timeout = setTimeout(() => finish(false), WORKER_CONTROL_TIMEOUT_MS);
			function finish(changed) {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(changed);
			}
			navigator.serviceWorker.addEventListener(
				"controllerchange",
				() => finish(true),
				{ once: true },
			);
		});
	}

	function createTextElement(tagName, text) {
		var element = document.createElement(tagName);
		element.textContent = text;
		return element;
	}

	function renderRecoveryState() {
		function render() {
			document.documentElement.removeAttribute("data-home-redirect");
			document.documentElement.setAttribute("data-preboot-recovery", "failed");

			var main = document.createElement("main");
			main.style.cssText =
				"box-sizing:border-box;min-height:100vh;display:grid;place-content:center;gap:16px;padding:32px;background:#f8f8fa;color:#1f2026;font:16px/1.5 system-ui,sans-serif;text-align:center";
			var heading = createTextElement("h1", "Cohub could not start");
			heading.style.cssText = "margin:0;font-size:24px";
			var detail = createTextElement(
				"p",
				"The latest client could not be loaded. Check your connection, then try again.",
			);
			detail.style.cssText = "margin:0;max-width:440px";
			var retry = createTextElement("button", "Try again");
			retry.type = "button";
			retry.style.cssText =
				"justify-self:center;padding:10px 16px;border:1px solid currentColor;border-radius:6px;background:#1f2026;color:#fff;font:inherit;cursor:pointer";
			retry.addEventListener("click", () => {
				clearRecoveryMarkers();
				replacePageOnce();
			});
			main.append(heading, detail, retry);
			document.body.replaceChildren(main);
		}

		if (document.body) render();
		else document.addEventListener("DOMContentLoaded", render, { once: true });
	}

	async function getRegistrationAndUpdate(force) {
		if (!("serviceWorker" in navigator)) return null;
		var now = Date.now();
		if (!force && now - lastWorkerCheck < WORKER_CHECK_INTERVAL_MS) return null;
		lastWorkerCheck = now;

		var registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return null;
		var activated = null;
		function activateWaitingWorker() {
			if (!registration.waiting || registration.waiting === activated) return;
			activated = registration.waiting;
			activated.postMessage({ type: "SKIP_WAITING" });
		}
		activateWaitingWorker();
		await registration.update();
		activateWaitingWorker();
		return registration;
	}

	async function reportFailure(reason) {
		if (failureStarted) return;
		failureStarted = true;
		if (bootTimer !== null) clearTimeout(bootTimer);
		console.error("[Cohub] client boot failed", reason);

		if (readRetryMarker() !== false) {
			renderRecoveryState();
			return;
		}

		if (!writeRetryMarker()) {
			renderRecoveryState();
			return;
		}
		var controllerChange = waitForControllerChange();
		try {
			await getRegistrationAndUpdate(true);
		} catch (error) {
			console.error("[ServiceWorker] preboot update failed", error);
		}
		await controllerChange;
		replacePageOnce();
	}

	function markHealthy() {
		failureStarted = false;
		if (bootTimer !== null) clearTimeout(bootTimer);
		clearRecoveryMarkers();
		document.documentElement.removeAttribute("data-preboot-recovery");
	}

	function errorMessage(value) {
		if (value instanceof Error) return value.message;
		if (value && typeof value === "object" && "message" in value) {
			return String(value.message || "");
		}
		return String(value || "");
	}

	function isStaleAssetFailure(value) {
		return /(?:failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk [^ ]+ failed)/i.test(
			errorMessage(value),
		);
	}

	function failedResource(event) {
		var target = event?.target;
		if (!target || target === window) return null;
		var tagName = String(target.tagName || "").toUpperCase();
		var resource = null;
		if (tagName === "SCRIPT" && target.src) resource = target.src;
		if (
			tagName === "LINK" &&
			String(target.rel || "").toLowerCase() === "stylesheet" &&
			target.href
		) {
			resource = target.href;
		}
		if (!resource) return null;
		try {
			const url = new URL(resource, location.href);
			if (url.origin !== location.origin) return null;
			if (!url.pathname.startsWith("/_app/immutable/")) return null;
			return url.href;
		} catch (_error) {
			return null;
		}
	}

	window.__cohubPrebootRecovery = {
		reportFailure: reportFailure,
		markHealthy: markHealthy,
		checkForUpdate: () =>
			getRegistrationAndUpdate(false).catch((error) => {
				console.error("[ServiceWorker] lifecycle update failed", error);
			}),
	};

	if ("serviceWorker" in navigator) {
		let wasControlled = navigator.serviceWorker.controller !== null;
		navigator.serviceWorker.addEventListener("controllerchange", () => {
			if (!wasControlled) {
				wasControlled = true;
				return;
			}
			replacePageOnce();
		});
	}

	window.addEventListener("vite:preloadError", (event) => {
		event.preventDefault();
		void reportFailure(event.payload || "Vite preload failed");
	});
	window.addEventListener(
		"error",
		(event) => {
			var resource = failedResource(event);
			if (!resource && !isStaleAssetFailure(event.error || event.message))
				return;
			event.preventDefault();
			void reportFailure(resource || event.error || event.message);
		},
		true,
	);
	window.addEventListener("unhandledrejection", (event) => {
		if (!isStaleAssetFailure(event.reason)) return;
		event.preventDefault();
		void reportFailure(event.reason);
	});

	bootTimer = setTimeout(() => {
		void reportFailure("Client boot timed out");
	}, BOOT_TIMEOUT_MS);
})();
