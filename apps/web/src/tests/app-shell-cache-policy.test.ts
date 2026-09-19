import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../hooks.server";

async function resolveHtml() {
	return new Response('<!doctype html><html lang="en"></html>', {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

test("private app shells are never cached across releases", async () => {
	for (const pathname of [
		"/spaces/local-space",
		"/sessions/local-session",
		"/settings/profile",
	]) {
		const response = await handle({
			event: { url: new URL(`https://cohub.atou.cc${pathname}`) },
			resolve: resolveHtml,
		} as unknown as Parameters<typeof handle>[0]);

		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
});

test("public pages keep their existing cache policy", async () => {
	const response = await handle({
		event: { url: new URL("https://cohub.atou.cc/docs") },
		resolve: async () =>
			new Response('<!doctype html><html lang="en"></html>', {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "public, max-age=3600",
				},
			}),
	} as unknown as Parameters<typeof handle>[0]);

	assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
});
