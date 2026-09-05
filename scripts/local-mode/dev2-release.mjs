#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const DEV2_QUEUE = "cohub-personal-node-dev2-wakeups";
const DEV2_BUCKET = "cohub-personal-node-dev2-attachments";
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--deploy")) {
	throw new Error("Usage: node scripts/local-mode/dev2-release.mjs [--deploy]");
}
const action = args[0] === "--deploy" ? "deploy" : "check";

const appId = process.env.COHUB_DEV2_LOGTO_APP_ID?.trim() ?? "";
if (!appId) {
	throw new Error("COHUB_DEV2_LOGTO_APP_ID is required for a Dev2 release");
}
if (!/^[a-z0-9]+$/i.test(appId)) {
	throw new Error("COHUB_DEV2_LOGTO_APP_ID is invalid");
}

const inheritedWebBuildOutDir = process.env.COHUB_WEB_BUILD_OUT_DIR?.trim() ?? "";
if (inheritedWebBuildOutDir) {
	throw new Error(
		"COHUB_WEB_BUILD_OUT_DIR must be unset for a Dev2 release to avoid shared build output",
	);
}
const inheritedWebTarget = process.env.COHUB_WEB_TARGET?.trim() ?? "";
if (inheritedWebTarget && inheritedWebTarget !== "cloudflare") {
	throw new Error("COHUB_WEB_TARGET must be cloudflare for a Dev2 release");
}

function run(program, commandArgs, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(program, commandArgs, {
			cwd: options.cwd ?? repoRoot,
			env: { ...process.env, ...options.env },
			stdio: "inherit",
			shell: false,
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			reject(
				new Error(
					`${program} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
				),
			);
		});
	});
}

function requireCloudflareCredentials() {
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
	if (!apiToken) {
		throw new Error("CLOUDFLARE_API_TOKEN is required for a Dev2 deploy");
	}
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
	if (!accountId) {
		throw new Error("CLOUDFLARE_ACCOUNT_ID is required for a Dev2 deploy");
	}
	if (!/^[a-f0-9]{32}$/i.test(accountId)) {
		throw new Error("CLOUDFLARE_ACCOUNT_ID is invalid");
	}
	return { apiToken, accountId };
}

async function cloudflareApi(resource, init = {}) {
	const { apiToken, accountId } = requireCloudflareCredentials();
	const response = await fetch(
		`https://api.cloudflare.com/client/v4${resource}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
				...init.headers,
			},
		},
	);
	const responseText = await response.text();
	const payload = JSON.parse(responseText);
	if (
		!response.ok ||
		payload === null ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		payload.success !== true
	) {
		throw new Error(`Cloudflare API returned an unsuccessful response for ${resource}`);
	}
	return { accountId, payload };
}

function assertObject(value, path) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Cloudflare API ${path} must be an object`);
	}
}

function assertString(value, path) {
	if (typeof value !== "string") {
		throw new Error(`Cloudflare API ${path} must be a string`);
	}
}

async function listQueueNames(name) {
	const { accountId, payload } = await cloudflareApi(
		`/accounts/${encodeURIComponent(accountId)}/queues?name=${encodeURIComponent(name)}&page=1`,
	);
	if (!Array.isArray(payload.result)) {
		throw new Error("Cloudflare Queues API result must be an array");
	}
	return payload.result.map((queue, index) => {
		const path = `queues.result[${index}]`;
		assertObject(queue, path);
		assertString(queue.queue_name, `${path}.queue_name`);
		return queue.queue_name;
	});
}

async function listBucketNames() {
	const { accountId, payload } = await cloudflareApi(
		`/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
	);
	assertObject(payload.result, "r2.result");
	if (!Array.isArray(payload.result.buckets)) {
		throw new Error("Cloudflare R2 API result.buckets must be an array");
	}
	return payload.result.buckets.map((bucket, index) => {
		const path = `r2.result.buckets[${index}]`;
		assertObject(bucket, path);
		assertString(bucket.name, `${path}.name`);
		return bucket.name;
	});
}

async function ensureCloudflareResource(kind, name) {
	if (kind === "queue") {
		const queueNames = await listQueueNames(name);
		if (queueNames.some((queueName) => queueName === name)) {
			return;
		}
		const { accountId } = requireCloudflareCredentials();
		await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/queues`, {
			method: "POST",
			body: JSON.stringify({ queue_name: name }),
		});
		return;
	}
	if (kind === "r2") {
		const bucketNames = await listBucketNames();
		if (bucketNames.some((bucketName) => bucketName === name)) {
			return;
		}
		const { accountId } = requireCloudflareCredentials();
		await cloudflareApi(`/accounts/${encodeURIComponent(accountId)}/r2/buckets`, {
			method: "POST",
			body: JSON.stringify({ name }),
		});
		return;
	}
	throw new Error(`Unsupported Dev2 Cloudflare resource kind: ${kind}`);
}

await run("node", ["scripts/local-mode/dev2-resource-guard.mjs"]);
await run("pnpm", ["--filter", "@cohub/local-relay", "test"]);
await run("pnpm", ["--filter", "@cohub/local-relay", "typecheck"]);

const webEnv = {
	COHUB_WEB_TARGET: "cloudflare",
	COHUB_WEB_WRANGLER_CONFIG: "wrangler.dev2.json",
	PUBLIC_COHUB_ENV: "prod",
	PUBLIC_COHUB_LOCAL_MODE: "true",
	PUBLIC_PERSONAL_NODE_ALPHA: "true",
	PUBLIC_API_ORIGIN: "https://dev2-cohub.atou.cc",
	PUBLIC_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
	PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
	PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
	PUBLIC_LOCAL_RELAY_ENABLED: "true",
	PUBLIC_LOGTO_ENDPOINT: "https://auth.neta.art",
	PUBLIC_LOGTO_API_RESOURCE: "https://api.talesofai",
	PUBLIC_LOGTO_APP_ID: appId,
};

await run("pnpm", ["--filter", "web", "typecheck"], { env: webEnv });
await run("pnpm", ["--filter", "web", "alpha:build"], { env: webEnv });

if (action === "deploy") {
	await ensureCloudflareResource("queue", DEV2_QUEUE);
	await ensureCloudflareResource("r2", DEV2_BUCKET);
}

const deployArgs = action === "check" ? ["deploy", "--dry-run"] : ["deploy"];
const varArg = (name) => ["--var", `${name}:${appId}`];

await run(
	"pnpm",
	[
		"exec",
		"wrangler",
		...deployArgs,
		"--config",
		"wrangler.dev2.json",
		...varArg("LOGTO_APP_ID"),
	],
	{ cwd: resolve(repoRoot, "apps/local-relay") },
);
await run(
	"pnpm",
	[
		"exec",
		"wrangler",
		...deployArgs,
		"--config",
		"wrangler.dev2.json",
		...varArg("PUBLIC_LOGTO_APP_ID"),
	],
	{ cwd: resolve(repoRoot, "apps/web") },
);
