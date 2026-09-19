type ServiceWorkerUpdateInput = {
	container: ServiceWorkerContainer;
	reload: () => void;
};

type ThrottledWorkerUpdateCheckInput = {
	check: () => Promise<unknown>;
	now?: () => number;
	minimumIntervalMs?: number;
};

const SERVICE_WORKER_URL = "/sw.js";

/**
 * Activates a newly deployed worker and refreshes an already-controlled page
 * once the new worker owns it. First installs do not need a reload.
 */
export async function registerCohubServiceWorker({
	container,
	reload,
}: ServiceWorkerUpdateInput) {
	const wasControlled = container.controller !== null;
	let reloadStarted = false;
	container.addEventListener("controllerchange", () => {
		if (!wasControlled || reloadStarted) return;
		reloadStarted = true;
		reload();
	});

	const registration = await container.register(SERVICE_WORKER_URL, {
		updateViaCache: "none",
	});
	let activationRequestedFor: ServiceWorker | null = null;
	const activateWaitingWorker = () => {
		const waiting = registration.waiting;
		if (!waiting || waiting === activationRequestedFor) return;
		activationRequestedFor = waiting;
		waiting.postMessage({ type: "SKIP_WAITING" });
	};
	const watchInstallingWorker = () => {
		const installing = registration.installing;
		if (!installing) return;
		installing.addEventListener("statechange", () => {
			if (installing.state === "installed") activateWaitingWorker();
		});
	};

	registration.addEventListener("updatefound", watchInstallingWorker);
	activateWaitingWorker();
	await registration.update();
	activateWaitingWorker();
}

export function createThrottledWorkerUpdateCheck({
	check,
	now = Date.now,
	minimumIntervalMs = 30_000,
}: ThrottledWorkerUpdateCheckInput) {
	let lastCheckAt = Number.NEGATIVE_INFINITY;
	return () => {
		const currentTime = now();
		if (currentTime - lastCheckAt < minimumIntervalMs) return;
		lastCheckAt = currentTime;
		void check().catch((error) => {
			console.error("[ServiceWorker] lifecycle update failed", error);
		});
	};
}

export function installCohubServiceWorkerUpdateLifecycle() {
	if (!("serviceWorker" in navigator)) return;
	const checkForUpdate = createThrottledWorkerUpdateCheck({
		check: async () => {
			if (window.__cohubPrebootRecovery) {
				await window.__cohubPrebootRecovery.checkForUpdate();
				return;
			}
			const registration = await navigator.serviceWorker.getRegistration();
			if (!registration) return;
			registration.waiting?.postMessage({ type: "SKIP_WAITING" });
			await registration.update();
			registration.waiting?.postMessage({ type: "SKIP_WAITING" });
		},
	});
	const start = () => {
		void registerCohubServiceWorker({
			container: navigator.serviceWorker,
			reload: () => {
				if (window.__cohubServiceWorkerReloading) return;
				window.__cohubServiceWorkerReloading = true;
				window.location.reload();
			},
		}).catch((error) => {
			console.error("[ServiceWorker] update failed", error);
		});
	};
	const checkWhenVisible = () => {
		if (document.visibilityState === "visible") checkForUpdate();
	};

	if (document.readyState === "complete") start();
	else window.addEventListener("load", start, { once: true });
	window.addEventListener("pageshow", checkForUpdate);
	window.addEventListener("online", checkForUpdate);
	document.addEventListener("visibilitychange", checkWhenVisible);
}

declare global {
	interface Window {
		__cohubServiceWorkerReloading?: boolean;
	}
}
