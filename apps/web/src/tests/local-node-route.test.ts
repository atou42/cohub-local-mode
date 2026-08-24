import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalNodeRouteManager } from "../lib/local-node-route-core";

const privateOrigin = "https://macmini.example.ts.net";
const fallbackOrigin = "https://cohub.example.com";

function healthResponse() {
	return new Response('{"status":"ready"}', {
		status: 200,
		headers: { "x-cohub-local-node": "1" },
	});
}

test("healthy private route rewrites local API requests", async () => {
	const urls: string[] = [];
	const manager = new LocalNodeRouteManager({
		privateOrigin,
		fallbackOrigin,
		fetcher: async (input) => {
			const url = input.toString();
			urls.push(url);
			return url.endsWith("/route-health")
				? healthResponse()
				: new Response("private", { status: 200 });
		},
		now: () => 10_000,
	});
	const response = await manager.fetch(`${fallbackOrigin}/api/models`);
	assert.equal(await response.text(), "private");
	assert.deepEqual(urls, [
		`${privateOrigin}/api/local-mode/route-health`,
		`${privateOrigin}/api/models`,
	]);
	assert.equal(manager.websocketUrl("wss://cohub.example.com/ws"), `${privateOrigin.replace("https:", "wss:")}/ws`);
});

test("failed private probe selects the protected public fallback", async () => {
	const urls: string[] = [];
	const manager = new LocalNodeRouteManager({
		privateOrigin,
		fallbackOrigin,
		fetcher: async (input) => {
			const url = input.toString();
			urls.push(url);
			if (url.endsWith("/route-health")) throw new TypeError("unreachable");
			return new Response("fallback", { status: 200 });
		},
		now: () => 10_000,
	});
	const response = await manager.fetch(`${fallbackOrigin}/api/spaces`);
	assert.equal(await response.text(), "fallback");
	assert.equal(urls.at(-1), `${fallbackOrigin}/api/spaces`);
	assert.equal(manager.activeRoute, "fallback");
});

test("private HTTP errors stay visible and are never masked by fallback", async () => {
	let fallbackRequests = 0;
	const manager = new LocalNodeRouteManager({
		privateOrigin,
		fallbackOrigin,
		fetcher: async (input) => {
			const url = input.toString();
			if (url.endsWith("/route-health")) return healthResponse();
			if (url.startsWith(fallbackOrigin)) fallbackRequests += 1;
			return new Response("catalog unavailable", { status: 503 });
		},
		now: () => 10_000,
	});
	const response = await manager.fetch(`${fallbackOrigin}/api/models`);
	assert.equal(response.status, 503);
	assert.equal(fallbackRequests, 0);
});

test("only idempotent requests retry after a private network failure", async () => {
	const calls: string[] = [];
	let failPrivateRequest = true;
	const manager = new LocalNodeRouteManager({
		privateOrigin,
		fallbackOrigin,
		fetcher: async (input) => {
			const url = input.toString();
			calls.push(url);
			if (url.endsWith("/route-health")) return healthResponse();
			if (url.startsWith(privateOrigin) && failPrivateRequest) {
				failPrivateRequest = false;
				throw new TypeError("connection lost");
			}
			return new Response("ok", { status: 200 });
		},
		now: () => 10_000,
	});
	const getResponse = await manager.fetch(`${fallbackOrigin}/api/files`);
	assert.equal(await getResponse.text(), "ok");
	assert.equal(calls.at(-1), `${fallbackOrigin}/api/files`);

	await manager.refresh(true);
	failPrivateRequest = true;
	await assert.rejects(
		manager.fetch(`${fallbackOrigin}/api/spaces/id/prompt`, { method: "POST" }),
		/connection lost/,
	);
	assert.equal(calls.filter((url) => url === `${fallbackOrigin}/api/spaces/id/prompt`).length, 0);
});
