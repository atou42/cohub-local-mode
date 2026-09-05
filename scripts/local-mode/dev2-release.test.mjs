import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releasePath = resolve(repoRoot, "scripts/local-mode/dev2-release.mjs");

function runRelease(args, env) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [releasePath, ...args], {
			cwd: repoRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			resolvePromise({ code, signal, stdout, stderr }),
		);
	});
}

async function createMockPnpm(directory) {
	const executable = join(directory, "pnpm");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const record = {
  args: process.argv.slice(2),
  webTarget: process.env.COHUB_WEB_TARGET ?? null,
  webConfig: process.env.COHUB_WEB_WRANGLER_CONFIG ?? null,
  buildOutDir: process.env.COHUB_WEB_BUILD_OUT_DIR ?? null,
};
appendFileSync(process.env.MOCK_PNPM_LOG, JSON.stringify(record) + "\\n");
`,
	);
	await chmod(executable, 0o755);
	return executable;
}

function testEnvironment(path, logPath) {
	const environment = {
		...process.env,
		PATH: `${path}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
		COHUB_DEV2_LOGTO_APP_ID: "mockapp",
		MOCK_PNPM_LOG: logPath,
	};
	delete environment.COHUB_WEB_TARGET;
	delete environment.COHUB_WEB_WRANGLER_CONFIG;
	delete environment.COHUB_WEB_BUILD_OUT_DIR;
	return environment;
}

test("default release is a Dev2-only dry run and fixes web build inputs", async () => {
	const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cohub-dev2-release-"));
	try {
		const releaseSource = await readFile(releasePath, "utf8");
		assert.match(releaseSource, /JSON\.parse/);
		assert.doesNotMatch(releaseSource, /listed\.includes\(name\)/);
		await createMockPnpm(directory);
		const logPath = join(directory, "pnpm.jsonl");
		const result = await runRelease([], testEnvironment(directory, logPath));
		assert.equal(result.code, 0, result.stderr || result.stdout);

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const wranglerCalls = records.filter(
			({ args }) => args[0] === "exec" && args[1] === "wrangler",
		);
		assert.equal(wranglerCalls.length, 2);
		for (const call of wranglerCalls) {
			assert.equal(call.args.includes("--dry-run"), true);
			assert.equal(call.args.includes("wrangler.dev2.json"), true);
			assert.equal(call.args.includes("wrangler.alpha.toml"), false);
			assert.equal(call.args.includes("queues"), false);
			assert.equal(call.args.includes("r2"), false);
			assert.equal(call.args.includes("create"), false);
		}

		const webBuild = records.find(
			({ args }) => args.includes("--filter") && args.includes("web") && args.includes("alpha:build"),
		);
		assert.ok(webBuild);
		assert.equal(webBuild.webTarget, "cloudflare");
		assert.equal(webBuild.webConfig, "wrangler.dev2.json");
		assert.equal(webBuild.buildOutDir, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("release rejects inherited desktop targets and custom output directories", async () => {
	const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cohub-dev2-release-"));
	try {
		await createMockPnpm(directory);
		const logPath = join(directory, "pnpm.jsonl");
		await writeFile(logPath, "");
		for (const badEnvironment of [
			{ COHUB_WEB_TARGET: "desktop" },
			{ COHUB_WEB_BUILD_OUT_DIR: ".svelte-kit-local-build" },
		]) {
			const environment = testEnvironment(directory, logPath);
			Object.assign(environment, badEnvironment);
			const result = await runRelease([], environment);
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /COHUB_WEB_(?:TARGET|BUILD_OUT_DIR)/);
		}
		assert.equal((await readFile(logPath, "utf8")).trim(), "");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
