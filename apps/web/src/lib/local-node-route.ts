import { env } from "$env/dynamic/public";
import { LocalNodeRouteManager } from "$lib/local-node-route-core";
import { personalNodeFetch } from "$lib/personal-node-fetch";

const fallbackOrigin =
	(env.PUBLIC_API_ORIGIN ?? "").trim() ||
	(typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8787");

export const localNodeRouteManager = new LocalNodeRouteManager({
	privateOrigin: env.PUBLIC_LOCAL_PRIVATE_ORIGIN,
	fallbackOrigin,
	requestOrigins: [typeof location !== "undefined" ? location.origin : null],
});

const personalNodeAlphaEnabled = env.PUBLIC_PERSONAL_NODE_ALPHA === "true";

export const localNodeFetch: typeof fetch = (input, init) =>
	personalNodeAlphaEnabled
		? personalNodeFetch(input, init)
		: localNodeRouteManager.fetch(input, init);

export function createLocalNodeWebSocket(
	fallbackUrl: string,
): typeof WebSocket {
	return class RouteAwareWebSocket extends WebSocket {
		constructor(_url: string | URL, protocols?: string | string[]) {
			super(localNodeRouteManager.websocketUrl(fallbackUrl), protocols);
		}
	};
}
