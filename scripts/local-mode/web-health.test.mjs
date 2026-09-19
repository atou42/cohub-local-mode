import assert from "node:assert/strict";
import test from "node:test";

import { probeLocalAppShell } from "./web-health.mjs";

const html = '<!doctype html><script type="module" src="/_app/immutable/entry/start.ok.js"></script>';

test("accepts a fresh private app shell", async () => {
	const result = await probeLocalAppShell({
		url: "http://127.0.0.1:4173/spaces/release-health",
		fetcher: async () =>
			new Response(html, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "private, no-store",
				},
			}),
	});

	assert.equal(result, html);
});

test("rejects a server error instead of declaring the release ready", async () => {
	await assert.rejects(
		probeLocalAppShell({
			url: "http://127.0.0.1:4173/spaces/release-health",
			fetcher: async () => new Response("Internal Error", { status: 500 }),
		}),
		/returned 500/,
	);
});

test("rejects a cacheable or incomplete app shell", async () => {
	await assert.rejects(
		probeLocalAppShell({
			url: "http://127.0.0.1:4173/spaces/release-health",
			fetcher: async () =>
				new Response(html, {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		}),
		/must return private, no-store/,
	);

	await assert.rejects(
		probeLocalAppShell({
			url: "http://127.0.0.1:4173/spaces/release-health",
			fetcher: async () =>
				new Response("<!doctype html>", {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "private, no-store",
					},
				}),
		}),
		/does not contain the application entrypoint/,
	);
});
