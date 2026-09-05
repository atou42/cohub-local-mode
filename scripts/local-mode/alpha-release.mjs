#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const action = process.argv[2];
if (action !== "check" && action !== "deploy") {
	throw new Error("Usage: node scripts/local-mode/alpha-release.mjs <check|deploy>");
}

const appId = process.env.COHUB_ALPHA_LOGTO_APP_ID?.trim() ?? "";
if (!appId) {
	throw new Error("COHUB_ALPHA_LOGTO_APP_ID is required for an Alpha release");
}
if (!/^[a-z0-9]+$/i.test(appId)) {
	throw new Error("COHUB_ALPHA_LOGTO_APP_ID is invalid");
}

function run(program, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(program, args, {
			cwd: options.cwd ?? repoRoot,
			env: { ...process.env, ...options.env },
			stdio: "inherit",
			shell: false,
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else {
				reject(
					new Error(
						`${program} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
					),
				);
			}
		});
	});
}

function capture(program, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(program, args, {
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
		child.once("exit", (code) => {
			if (code === 0) resolvePromise(output);
			else reject(new Error(`${program} resource check exited with code ${code}`));
		});
	});
}

async function ensureCloudflareResource(listArgs, name, createArgs) {
	const cwd = resolve(repoRoot, "apps/local-relay");
	const listed = await capture("pnpm", ["exec", "wrangler", ...listArgs], {
		cwd,
	});
	if (listed.includes(name)) return;
	await run("pnpm", ["exec", "wrangler", ...createArgs, name], { cwd });
}

await run("node", ["scripts/local-mode/alpha-resource-guard.mjs"]);
await run("pnpm", ["--filter", "@cohub/local-relay", "test"]);
await run("pnpm", ["--filter", "@cohub/local-relay", "typecheck"]);
const webEnv = {
	PUBLIC_COHUB_ENV: "prod",
	PUBLIC_COHUB_LOCAL_MODE: "true",
	PUBLIC_PERSONAL_NODE_ALPHA: "true",
	PUBLIC_API_ORIGIN: "https://dev-cohub.atou.cc",
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

const deployArgs = action === "check" ? ["deploy", "--dry-run"] : ["deploy"];
const varArg = (name) => ["--var", `${name}:${appId}`];

if (action === "deploy") {
	await ensureCloudflareResource(
		["queues", "list"],
		"cohub-personal-node-alpha-dev-wakeups",
		["queues", "create"],
	);
	await ensureCloudflareResource(
		["r2", "bucket", "list"],
		"cohub-personal-node-alpha-dev-attachments",
		["r2", "bucket", "create"],
	);
}

await run(
	"pnpm",
	[
		"exec",
		"wrangler",
		...deployArgs,
		"--config",
		"wrangler.alpha.toml",
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
		"wrangler.alpha.toml",
		...varArg("PUBLIC_LOGTO_APP_ID"),
	],
	{ cwd: resolve(repoRoot, "apps/web") },
);
