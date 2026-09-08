import assert from "node:assert/strict";
import test from "node:test";
import { connectDev2ReleaseBucket } from "./remote-r2.mjs";

test("release transport rejects the wrong account and missing credentials before any request", async () => {
	const original = { account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN };
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => { throw new Error("No network request is allowed before scope validation"); };
	try {
		process.env.CLOUDFLARE_ACCOUNT_ID = "another-account";
		await assert.rejects(connectDev2ReleaseBucket(), /explicit Dev2 Cloudflare account/);
		process.env.CLOUDFLARE_ACCOUNT_ID = "9a667651385ed193d9abad33eae47ea1";
		delete process.env.CLOUDFLARE_API_TOKEN;
		await assert.rejects(connectDev2ReleaseBucket(), /Cloudflare API token is required/);
	} finally {
		globalThis.fetch = originalFetch;
		if (original.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = original.account;
		if (original.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = original.token;
	}
});
