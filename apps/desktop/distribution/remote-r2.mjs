import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEV2_RELEASE_BUCKET } from "./deployment.mjs";

const ACCOUNT_ID = "9a667651385ed193d9abad33eae47ea1";
const WORKER_NAME = "cohub-personal-node-dev2-downloads";
const SUBDOMAIN = "sobighead-c";

export async function connectDev2ReleaseBucket() {
	assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID, "An explicit Dev2 Cloudflare account is required");
	assert.ok(process.env.CLOUDFLARE_API_TOKEN, "A Cloudflare API token is required");
	if (process.env.HTTPS_PROXY || process.env.https_proxy) assert.ok(process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy"), "Run the release command with Node --use-env-proxy");
	const require = createRequire(new URL("../../local-relay/package.json", import.meta.url));
	// Load the pinned preview toolchain. Node's own fetch uses --use-env-proxy.
	require("wrangler");
	const dependencyRequire = createRequire(require.resolve("wrangler/package.json"));
	const { Miniflare } = dependencyRequire("miniflare");
	const apiOrigin = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
	const sensitive = [process.env.CLOUDFLARE_API_TOKEN];
	const api = async (path, options = {}) => {
		const response = await fetch(apiOrigin + path, {
			...options, redirect: "error", signal: AbortSignal.timeout(60_000),
			headers: { ...options.headers, Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
		});
		const body = await response.json();
		if (!response.ok || body.success !== true) {
			let detail = body.errors?.map(error => `${error.code}: ${error.message}`).join(",") ?? "Unknown API error";
			for (const value of sensitive) detail = detail.replaceAll(value, "[REDACTED]");
			throw new Error(`Preview API failed (${response.status}): ${detail.slice(0,1600)}`);
		}
		return body.result;
	};
	const session = await api("/workers/subdomain/edge-preview");
	assert.equal(typeof session.token, "string");
	let sessionToken = session.token;
	sensitive.push(sessionToken);
	if (session.exchange_url) {
		const exchangeUrl = new URL(session.exchange_url);
		assert.ok(exchangeUrl.protocol === "https:" && exchangeUrl.hostname.endsWith(`.${SUBDOMAIN}.workers.dev`));
		const response = await fetch(exchangeUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
		if (response.status === 400) {
			console.warn("Preview token expansion is unavailable (400); using the original session token, as Wrangler does");
			await response.body?.cancel();
		} else {
			assert.ok(response.ok, `Preview exchange failed (${response.status})`);
			const expanded = await response.json();
			assert.equal(typeof expanded.token, "string");
			sessionToken = expanded.token;
			sensitive.push(sessionToken);
		}
	}
	const secret = randomBytes(32).toString("hex");
	sensitive.push(secret);
	const expiresAt = Date.now() + 20 * 60_000;
	const wrapper = `export default { async fetch(request, env) {
		if (Date.now() > ${expiresAt} || request.headers.get('X-Dev2-Publish-Token') !== ${JSON.stringify(secret)}) return new Response('Unavailable', {status: 403});
		if (request.headers.get('MF-Binding') !== 'RELEASES') return new Response('Unavailable', {status: 403});
		const headers = new Headers();
		for (const [name, value] of request.headers) if (name.startsWith('mf-header-')) headers.set(name.slice(10), value);
		return env.RELEASES.fetch(request.headers.get('MF-URL'), new Request(request, {headers, redirect:'manual'}));
	} };`;
	const form = new FormData();
	form.set("metadata", JSON.stringify({
		main_module: "entry.js", compatibility_date: "2025-04-28", compatibility_flags: [],
		bindings: [{ name: "RELEASES", type: "r2_bucket", bucket_name: DEV2_RELEASE_BUCKET, raw: true }],
	}));
	form.set("entry.js", new Blob([wrapper], { type: "application/javascript+module" }), "entry.js");
	form.set("wrangler-session-config", JSON.stringify({ workers_dev: true, minimal_mode: true }));
	const preview = await api(`/workers/scripts/${WORKER_NAME}/edge-preview`, { method: "POST", body: form, headers: { "cf-preview-upload-config-token": sessionToken } });
	assert.equal(typeof preview.preview_token, "string");
	const origin = `https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev`;
	// This is an authenticated, expiring preview, not a deployed upload route.
	const rejected = await fetch(origin, { headers: { "cf-workers-preview-token": preview.preview_token }, redirect: "error", signal: AbortSignal.timeout(30_000) });
	assert.equal(rejected.status, 403, "Preview must reject requests without the per-run capability");
	const bridge = createServer(async (request, outgoing) => {
		if (request.url !== `/${secret}`) { outgoing.writeHead(403).end(); return; }
		try {
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("connection");
			headers.delete("transfer-encoding");
			headers.set("cf-workers-preview-token", preview.preview_token);
			headers.set("X-Dev2-Publish-Token", secret);
			const response = await fetch(origin, {
				method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : Readable.toWeb(request),
				duplex: "half", redirect: "error", signal: AbortSignal.timeout(120_000),
			});
			const responseHeaders = new Headers(response.headers);
			for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) responseHeaders.delete(name);
			outgoing.writeHead(response.status, Object.fromEntries(responseHeaders));
			if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
			else outgoing.end();
		} catch (error) {
			console.error("Dev2 preview transport failed:", error instanceof Error ? error.message : "Unknown transport error");
			if (!outgoing.headersSent) outgoing.writeHead(502);
			outgoing.end();
		}
	});
	bridge.listen(0, "127.0.0.1");
	await once(bridge, "listening");
	const connection = new URL(`http://127.0.0.1:${bridge.address().port}/${secret}`);
	let mf;
	const dispose = async () => { try { await mf?.dispose(); } finally { await new Promise((resolve, reject) => bridge.close(error => error ? reject(error) : resolve())); } };
	try {
		const localRejected = await fetch(new URL("/", connection), { signal: AbortSignal.timeout(10_000) });
		assert.equal(localRejected.status, 403, "Loopback bridge must reject requests without the per-run capability");
		console.log(JSON.stringify({ stage: "preview-authentication-checked", remoteMissingCapability: rejected.status, localMissingCapability: localRejected.status, expiresAt: new Date(expiresAt).toISOString() }));
		mf = new Miniflare({
			modules: true, script: "export default {};", compatibilityDate: "2025-04-28", cf: false,
			r2Buckets: { RELEASES: { id: DEV2_RELEASE_BUCKET, remoteProxyConnectionString: connection } },
		});
		return { bucket: await mf.getR2Bucket("RELEASES"), dispose };
	}
	catch (error) { await dispose(); throw error; }
}
