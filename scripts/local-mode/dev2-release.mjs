#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
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

function capture(program, commandArgs, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(program, commandArgs, {
			cwd: options.cwd ?? repoRoot,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise(output);
				return;
			}
			reject(
				new Error(
					`${program} resource check exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
				),
			);
		});
	});
}

async function ensureCloudflareResource(listArgs, name, createArgs) {
	const cwd = resolve(repoRoot, "apps/local-relay");
	const listed = await capture("pnpm", ["exec", "wrangler", ...listArgs], { cwd });
	if (listed.includes(name)) {
		return;
	}
	await run("pnpm", ["exec", "wrangler", ...createArgs, name], { cwd });
}

await run("node", ["scripts/local-mode/dev2-resource-guard.mjs"]);
await run("pnpm", ["--filter", "@cohub/local-relay", "test"]);
await run("pnpm", ["--filter", "@cohub/local-relay", "typecheck"]);

const webEnv = {
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
	await ensureCloudflareResource(
		["queues", "list"],
		"cohub-personal-node-dev2-wakeups",
		["queues", "create"],
	);
	await ensureCloudflareResource(
		["r2", "bucket", "list"],
		"cohub-personal-node-dev2-attachments",
		["r2", "bucket", "create"],
	);
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
