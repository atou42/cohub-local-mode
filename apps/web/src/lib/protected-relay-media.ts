import { getAuthToken } from "$lib/auth";
import { currentPersonalNodeScope, resolvePersonalNodeDevice } from "$lib/personal-node-fetch";

export function protectedRelayMediaPath(source: string) {
	if (typeof location === "undefined") return null;
	const url = new URL(source, location.href);
	if (url.origin !== location.origin) return null;
	const match = url.pathname.match(/^\/api\/alpha\/v1\/nodes\/([a-f0-9-]{36})\/attachments\/([a-f0-9-]{36})\/content$/i);
	return match ? { path: url.pathname, deviceId: match[1] } : null;
}

export function publicMediaSource(source: string) {
	return protectedRelayMediaPath(source) ? undefined : source;
}

export async function fetchRelayMedia(source: string, signal?: AbortSignal) {
	const target = protectedRelayMediaPath(source);
	if (!target) return fetch(source, { signal });
	const token = await getAuthToken();
	if (!token) throw new Error("Sign in to view this attachment");
	const authorization = `Bearer ${token}`;
	const device = await resolvePersonalNodeDevice(authorization);
	const scope = currentPersonalNodeScope();
	if (device?.id !== target.deviceId || !scope) throw new Error("This attachment belongs to a different device");
	const response = await fetch(target.path, { headers: { authorization }, signal, redirect: "error" });
	if (!response.ok) throw new Error(`Attachment is unavailable (${response.status})`);
	const blob = await response.blob();
	if (currentPersonalNodeScope()?.generation !== scope.generation) throw new Error("The account or device changed while loading this attachment");
	return new Response(blob, { headers: response.headers });
}

export function protectedRelayMedia(node: HTMLImageElement | HTMLMediaElement, source: string) {
	let release = () => {};
	const update = (value: string) => {
		release();
		if (!protectedRelayMediaPath(value)) return;
		const controller = new AbortController();
		let objectUrl: string | null = null;
		node.removeAttribute("src");
		node.setAttribute("aria-busy", "true");
		void fetchRelayMedia(value, controller.signal).then((response) => response.blob()).then((blob) => {
			if (controller.signal.aborted) return;
			objectUrl = URL.createObjectURL(blob);
			node.src = objectUrl;
			node.removeAttribute("aria-busy");
		}).catch((error) => {
			if (controller.signal.aborted) return;
			node.removeAttribute("aria-busy");
			node.title = error instanceof Error ? error.message : "Attachment unavailable";
			if (node instanceof HTMLImageElement) node.alt = node.title;
		});
		release = () => {
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			node.setAttribute("src", value);
		};
	};
	update(source);
	return { update, destroy: () => release() };
}

export async function downloadRelayMedia(source: string, filename: string) {
	const response = await fetchRelayMedia(source);
	if (!response.ok) throw new Error(`Download failed (${response.status})`);
	const url = URL.createObjectURL(await response.blob());
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename || "attachment";
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
