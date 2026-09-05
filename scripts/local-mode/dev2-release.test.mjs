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

async function createFetchStub(directory) {
	const stubPath = join(directory, "fetch-stub.mjs");
	await writeFile(
		stubPath,
		`import { appendFileSync } from "node:fs";

const queueName = "cohub-personal-node-dev2-wakeups";
const bucketName = "cohub-personal-node-dev2-attachments";
const accountId = "0123456789abcdef0123456789abcdef";
const mode = process.env.MOCK_FETCH_MODE;
const logPath = process.env.MOCK_FETCH_LOG;

function record(method, url, body) {
  appendFileSync(logPath, JSON.stringify({ method, url, body }) + "\\n");
}

globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? "GET";
  const url = new URL(String(input));
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  record(method, url.toString(), body);

  if (url.hostname !== "api.cloudflare.com" || url.pathname !== "/client/v4/accounts/" + accountId + "/queues" && url.pathname !== "/client/v4/accounts/" + accountId + "/r2/buckets") {
    throw new Error("Unexpected Cloudflare API URL");
  }
  if (method === "GET" && url.pathname.endsWith("/queues")) {
    if (mode === "bad-json") return new Response("{", { status: 200 });
    const listedName = mode === "exact" ? queueName : queueName + "-shadow";
    return new Response(JSON.stringify({ success: true, result: [{ queue_name: listedName }] }), { status: 200 });
  }
  if (method === "GET" && url.pathname.endsWith("/r2/buckets")) {
    const listedName = mode === "exact" ? bucketName : bucketName + "-shadow";
    return new Response(JSON.stringify({ success: true, result: { buckets: [{ name: listedName }] } }), { status: 200 });
  }
  if (method === "POST" && url.pathname.endsWith("/queues")) {
    if (body?.queue_name !== queueName) throw new Error("Unexpected queue create body");
    return new Response(JSON.stringify({ success: true, result: { queue_name: queueName } }), { status: 200 });
  }
  if (method === "POST" && url.pathname.endsWith("/r2/buckets")) {
    if (body?.name !== bucketName) throw new Error("Unexpected bucket create body");
    return new Response(JSON.stringify({ success: true, result: { name: bucketName } }), { status: 200 });
  }
  throw new Error("Unexpected Cloudflare API request");
};
`,
	);
	return stubPath;
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

test("deploy checks exact resource names through structured API responses", async () => {
	const accountId = "0123456789abcdef0123456789abcdef";
	for (const mode of ["similar", "exact"]) {
		const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cohub-dev2-release-"));
		try {
			await createMockPnpm(directory);
			const pnpmLogPath = join(directory, "pnpm.jsonl");
			const fetchLogPath = join(directory, "fetch.jsonl");
			await writeFile(pnpmLogPath, "");
			await writeFile(fetchLogPath, "");
			const fetchStubPath = await createFetchStub(directory);
			const environment = testEnvironment(directory, pnpmLogPath);
			Object.assign(environment, {
				CLOUDFLARE_API_TOKEN: "test-token",
				CLOUDFLARE_ACCOUNT_ID: accountId,
				MOCK_FETCH_MODE: mode,
				MOCK_FETCH_LOG: fetchLogPath,
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${fetchStubPath}`.trim(),
			});

			const result = await runRelease(["--deploy"], environment);
			assert.equal(result.code, 0, result.stderr || result.stdout);
			const fetchRecords = (await readFile(fetchLogPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const queueGet = fetchRecords.find(
				({ method, url }) => method === "GET" && new URL(url).pathname.endsWith("/queues"),
			);
			assert.ok(queueGet);
			assert.equal(
				queueGet.url,
				`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues?name=cohub-personal-node-dev2-wakeups&page=1`,
			);
			const bucketGet = fetchRecords.find(
				({ method, url }) => method === "GET" && new URL(url).pathname.endsWith("/r2/buckets"),
			);
			assert.ok(bucketGet);
			assert.equal(
				bucketGet.url,
				`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
			);
			const creates = fetchRecords.filter(({ method }) => method === "POST");
			assert.equal(creates.length, mode === "similar" ? 2 : 0);
			if (mode === "similar") {
				assert.deepEqual(creates.map(({ body }) => body), [
					{ queue_name: "cohub-personal-node-dev2-wakeups" },
					{ name: "cohub-personal-node-dev2-attachments" },
				]);
			}

			const pnpmRecords = (await readFile(pnpmLogPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const deployCalls = pnpmRecords.filter(
				({ args }) => args[0] === "exec" && args[1] === "wrangler",
			);
			assert.equal(deployCalls.length, 2);
			for (const call of deployCalls) {
				assert.equal(call.args.includes("--dry-run"), false);
				assert.equal(call.args.includes("wrangler.dev2.json"), true);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("malformed resource JSON stops deploy before later API calls or Wrangler deploys", async () => {
	const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cohub-dev2-release-"));
	try {
		await createMockPnpm(directory);
		const pnpmLogPath = join(directory, "pnpm.jsonl");
		const fetchLogPath = join(directory, "fetch.jsonl");
		await writeFile(pnpmLogPath, "");
		await writeFile(fetchLogPath, "");
		const fetchStubPath = await createFetchStub(directory);
		const environment = testEnvironment(directory, pnpmLogPath);
		Object.assign(environment, {
			CLOUDFLARE_API_TOKEN: "test-token",
			CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
			MOCK_FETCH_MODE: "bad-json",
			MOCK_FETCH_LOG: fetchLogPath,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${fetchStubPath}`.trim(),
		});

		const result = await runRelease(["--deploy"], environment);
		assert.notEqual(result.code, 0);
		const fetchRecords = (await readFile(fetchLogPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(fetchRecords.length, 1);
		assert.equal(fetchRecords[0].method, "GET");
		assert.match(result.stderr, /JSON|Unexpected token/);
		const pnpmRecords = (await readFile(pnpmLogPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert.equal(
			pnpmRecords.filter(({ args }) => args[0] === "exec" && args[1] === "wrangler").length,
			0,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
