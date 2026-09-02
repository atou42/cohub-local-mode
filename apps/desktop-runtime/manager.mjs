#!/usr/bin/env node
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import S3rver from "s3rver";
import sqlClient from "postgres";
import nodeFetch from "node-fetch";
import { initdb, postgres as postgresBinary } from "@embedded-postgres/darwin-arm64";

const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(process.env.COHUB_LOCAL_DATA_DIR || join(homedir(), ".cohub-personal-node"));
const statePath = join(dataRoot, "runtime-state.json");
const stateVersion = 1;
const portOffset = Number(process.env.COHUB_PERSONAL_NODE_TEST_PORT_OFFSET || "0");
if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 10_000) {
	throw new Error("COHUB_PERSONAL_NODE_TEST_PORT_OFFSET must be an integer from 0 to 10000");
}
const ports = {
	postgres: 54_329 + portOffset,
	redis: 6_380 + portOffset,
	objects: 9_000 + portOffset,
	api: 8_787 + portOffset,
	gateway: 8_788 + portOffset,
};
const children = new Map();
let objectStore = null;
let stopping = false;

function secret() {
	return randomBytes(32).toString("base64url");
}

async function readOrCreateState() {
	try {
		const value = JSON.parse(await readFile(statePath, "utf8"));
		if (
			value?.version !== stateVersion ||
			!["postgresPassword", "redisPassword", "appEncryptionKey", "workerSecret"].every(
				(key) => typeof value[key] === "string" && value[key].length >= 32,
			)
		) {
			throw new Error("Personal Node runtime state is invalid");
		}
		return value;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const value = {
		version: stateVersion,
		postgresPassword: secret(),
		redisPassword: secret(),
		appEncryptionKey: secret(),
		workerSecret: secret(),
	};
	await mkdir(dataRoot, { recursive: true });
	const temporary = `${statePath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, statePath);
	return value;
}

function waitForTcp(port, timeoutMs = 30_000) {
	const startedAt = Date.now();
	return new Promise((resolvePromise, reject) => {
		const attempt = () => {
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.end();
				resolvePromise();
			});
			socket.once("error", (error) => {
				socket.destroy();
				if (Date.now() - startedAt >= timeoutMs) reject(error);
				else setTimeout(attempt, 200);
			});
		};
		attempt();
	});
}

async function probe(url, timeoutMs = 1_500) {
	try {
		const response = await nodeFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}

function startChild(name, executable, args, env, cwd = runtimeRoot) {
	const child = spawn(executable, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});
	children.set(name, child);
	for (const [stream, output] of [
		[child.stdout, process.stdout],
		[child.stderr, process.stderr],
	]) {
		stream?.on("data", (chunk) => output.write(`[${name}] ${String(chunk)}`));
	}
	child.once("error", (error) => {
		process.stderr.write(`[runtime] ${name} failed to start: ${error.message}\n`);
	});
	child.once("exit", (code, signal) => {
		children.delete(name);
		if (!stopping) {
			process.stderr.write(
				`[runtime] ${name} stopped unexpectedly (${signal || code || "unknown"})\n`,
			);
			void stop(1);
		}
	});
	return child;
}

async function runChild(name, executable, args, env, cwd = runtimeRoot) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn(executable, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${String(chunk)}`));
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			process.stderr.write(`[${name}] ${String(chunk)}`);
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${name} exited with ${signal || code}: ${stderr.trim()}`));
		});
	});
}

function nodeEntry(packageName, relativePath) {
	return join(runtimeRoot, "node_modules", ...packageName.split("/"), relativePath);
}

async function ensurePostgres(state) {
	const pgData = join(dataRoot, "postgres");
	try {
		await access(join(pgData, "PG_VERSION"));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(pgData, { recursive: true });
		const passwordFile = join(dataRoot, `.postgres-password.${process.pid}`);
		await writeFile(passwordFile, `${state.postgresPassword}\n`, { mode: 0o600, flag: "wx" });
		try {
			await runChild("postgres-init", initdb, [
				"-D",
				pgData,
				"--username=cohub",
				`--pwfile=${passwordFile}`,
				"--auth-host=scram-sha-256",
				"--auth-local=trust",
				"--encoding=UTF8",
				"--no-locale",
			], {});
		} finally {
			await rm(passwordFile, { force: true });
		}
	}
	await mkdir(join(dataRoot, "postgres-socket"), { recursive: true });
	startChild("postgres", postgresBinary, [
		"-D",
		pgData,
		"-h",
		"127.0.0.1",
		"-p",
		String(ports.postgres),
		"-k",
		join(dataRoot, "postgres-socket"),
	], {});
	await waitForTcp(ports.postgres);
	const sql = sqlClient(
		`postgresql://cohub:${state.postgresPassword}@127.0.0.1:${ports.postgres}/postgres`,
		{ max: 1 },
	);
	try {
		let rows;
		const deadline = Date.now() + 30_000;
		while (true) {
			try {
				rows = await sql`select 1 from pg_database where datname = 'cohub'`;
				break;
			} catch (error) {
				if (error?.code !== "57P03" || Date.now() >= deadline) throw error;
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
			}
		}
		if (rows.length === 0) await sql.unsafe("create database cohub");
	} finally {
		await sql.end();
	}
}

async function ensureRedis(state) {
	const redisDir = join(dataRoot, "redis");
	const executable = join(runtimeRoot, "native", "valkey-server");
	await mkdir(redisDir, { recursive: true });
	await access(executable);
	startChild("redis", executable, [
		"--bind",
		"127.0.0.1",
		"--port",
		String(ports.redis),
		"--dir",
		redisDir,
		"--appendonly",
		"yes",
		"--requirepass",
		state.redisPassword,
	], {});
	await waitForTcp(ports.redis);
}

async function ensureObjectStore() {
	const cors = Buffer.from(
		`<CORSConfiguration><CORSRule><AllowedOrigin>https://dev-cohub.atou.cc</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>`,
	);
	await mkdir(join(dataRoot, "objects"), { recursive: true });
	objectStore = new S3rver({
		address: "127.0.0.1",
		port: ports.objects,
		directory: join(dataRoot, "objects"),
		silent: true,
		allowMismatchedSignatures: true,
		vhostBuckets: false,
		configureBuckets: [
			{ name: "cohub-sessions", configs: [cors] },
			{ name: "cohub-assets", configs: [cors] },
		],
	});
	await objectStore.run();
}

async function writeCliWrapper() {
	const binDir = join(dataRoot, "bin");
	const wrapper = join(binDir, "cohub");
	const cli = nodeEntry("@neta-art/cohub-cli", "bin/cohub.js");
	await mkdir(binDir, { recursive: true });
	const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
	await writeFile(
		wrapper,
		`#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
		{ mode: 0o700 },
	);
	await chmod(wrapper, 0o700);
	return wrapper;
}

async function ensurePlatformConfig() {
	const modelPath = join(dataRoot, "configs", "platform", ".cohub", "models.json");
	try {
		JSON.parse(await readFile(modelPath, "utf8"));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(dirname(modelPath), { recursive: true });
		const catalog = {
			providers: {
				openai: {
					api: "openai-responses",
					baseUrl: "https://new-api.talesofai.com/v1",
					apiKey: "LOCAL_PI_API_KEY",
					models: [
						{
							id: "gpt-5.6-sol",
							name: "GPT-5.6-Sol",
							reasoning: true,
							defaultThinkingLevel: "low",
							thinkingLevelMap: {
								low: "low",
								medium: "medium",
								high: "high",
								xhigh: "xhigh",
								max: "max",
								ultra: "ultra",
							},
							input: ["text", "image"],
						},
						{
							id: "gpt-5.6-terra",
							name: "GPT-5.6-Terra",
							reasoning: true,
							defaultThinkingLevel: "medium",
							thinkingLevelMap: {
								low: "low",
								medium: "medium",
								high: "high",
								xhigh: "xhigh",
								max: "max",
								ultra: "ultra",
							},
							input: ["text", "image"],
						},
						{
							id: "gpt-5.6-luna",
							name: "GPT-5.6-Luna",
							reasoning: true,
							defaultThinkingLevel: "medium",
							thinkingLevelMap: {
								low: "low",
								medium: "medium",
								high: "high",
								xhigh: "xhigh",
								max: "max",
							},
							input: ["text", "image"],
						},
						{
							id: "deepseek-v4-pro",
							name: "DeepSeek V4 Pro",
							reasoning: false,
							input: ["text"],
						},
						{
							id: "deepseek-v4-flash",
							name: "DeepSeek V4 Flash",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			},
		};
		await writeFile(modelPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
}

function buildEnvironment(state, cliPath) {
	const sharedSkills = join(homedir(), ".agents", "skills");
	const databaseUrl = `postgresql://cohub:${state.postgresPassword}@127.0.0.1:${ports.postgres}/cohub`;
	const redisUrl = `redis://:${state.redisPassword}@127.0.0.1:${ports.redis}`;
	const apiOrigin = `http://127.0.0.1:${ports.api}`;
	const gatewayOrigin = `ws://127.0.0.1:${ports.gateway}/ws`;
	const objectOrigin = `http://127.0.0.1:${ports.objects}`;
	const values = {
		COHUB_LOCAL_DATA_DIR: dataRoot,
		DATABASE_URL: databaseUrl,
		REDIS_URL: redisUrl,
		BULLMQ_REDIS_URL: redisUrl,
		APP_ENCRYPTION_KEY: state.appEncryptionKey,
		WORKER_SECRET: state.workerSecret,
		LOCAL_SANDBOX_RELAY_TOKEN: createHmac("sha256", state.workerSecret)
			.update("cohub-local-sandbox-relay-v1")
			.digest("base64url"),
		COHUB_NODE_ORIGIN: "local",
		ENV: "prod",
		NODE_ENV: "production",
		SESSIONS_NAMESPACE: "cohub-local",
		API_BASE_URL: apiOrigin,
		INTERNAL_API_BASE_URL: apiOrigin,
		LOCAL_COHUB_GATEWAY_ORIGIN: gatewayOrigin,
		COHUB_RELAY_URL: `ws://127.0.0.1:${ports.gateway}/sandbox/relay`,
		HOST: "127.0.0.1",
		PORT: "",
		WEB_ORIGIN: "https://dev-cohub.atou.cc",
		PUBLIC_API_ORIGIN: "https://dev-cohub.atou.cc",
		PUBLIC_GATEWAY_ORIGIN: "wss://dev-cohub.atou.cc/api/alpha/events",
		PUBLIC_COHUB_LOCAL_MODE: "true",
		PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
		PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
		CLOUD_API_BASE_URL: "https://api.cohub.live",
		SPACE_STORAGE_ROOT: join(dataRoot, "spaces"),
		WORKSPACE_ROOT: join(dataRoot, "spaces"),
		SPACE_SYSTEM_ROOT: join(dataRoot, "system"),
		CHECKPOINT_CACHE_ROOT: join(dataRoot, "checkpoints"),
		SESSIONS_DIR: join(dataRoot, "sessions"),
		PLATFORM_CONFIG_ROOT: join(dataRoot, "configs"),
		LOCAL_GIT_ROOT: join(dataRoot, "git"),
		SPACE_STORAGE_SUBPATH: "spaces",
		CHECKPOINT_CACHE_SUBPATH: "checkpoints",
		LOCAL_USER_AGENTS_PATH: join(homedir(), ".codex", "AGENTS.md"),
		LOCAL_AGENT_SKILLS_PATH: process.env.COHUB_PERSONAL_NODE_SKILLS_PATH || sharedSkills,
		LOCAL_COHUB_CLI_PATH: cliPath,
		COHUB_CLI_AUTO_UPDATE: "0",
		...(process.env.COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_SERVICE
			? {
					COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_SERVICE:
						process.env.COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_SERVICE,
					COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_ACCOUNT:
						process.env.COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_ACCOUNT,
					COHUB_PERSONAL_NODE_AUTH_ORIGIN:
						process.env.COHUB_PERSONAL_NODE_AUTH_ORIGIN,
				}
			: {}),
		COHUB_SANDBOXD_BIN: join(runtimeRoot, "native", "cohub-sandboxd"),
		TURN_OBJECT_S3_ENDPOINT: objectOrigin,
		TURN_OBJECT_S3_PUBLIC_ENDPOINT: objectOrigin,
		TURN_OBJECT_S3_REGION: "us-east-1",
		TURN_OBJECT_S3_BUCKET: "cohub-sessions",
		TURN_OBJECT_S3_ACCESS_KEY_ID: "S3RVER",
		TURN_OBJECT_S3_SECRET_ACCESS_KEY: "S3RVER",
		TURN_OBJECT_CDN_BASE_URL: `${objectOrigin}/cohub-sessions`,
		PUBLIC_ASSET_OSS_ENDPOINT: objectOrigin,
		PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT: objectOrigin,
		PUBLIC_ASSET_OSS_REGION: "us-east-1",
		PUBLIC_ASSET_OSS_BUCKET: "cohub-assets",
		PUBLIC_ASSET_OSS_ACCESS_KEY_ID: "S3RVER",
		PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY: "S3RVER",
		PUBLIC_ASSET_CDN_BASE_URL: `${objectOrigin}/cohub-assets`,
		USER_UPLOAD_S3_ENDPOINT: objectOrigin,
		USER_UPLOAD_S3_REGION: "us-east-1",
		USER_UPLOAD_S3_ACCESS_KEY_ID: "S3RVER",
		USER_UPLOAD_S3_SECRET_ACCESS_KEY: "S3RVER",
		CHAT_ATTACHMENT_S3_BUCKET: "cohub-assets",
		CHAT_ATTACHMENT_PUBLIC_BASE_URL: `${objectOrigin}/cohub-assets`,
		SPACE_UPLOAD_S3_BUCKET: "cohub-assets",
		APP_ASSET_CDN_BASE_URL: `${objectOrigin}/cohub-assets`,
		CHECKPOINT_ASSET_OSS_ENDPOINT: objectOrigin,
		CHECKPOINT_ASSET_OSS_PUBLIC_ENDPOINT: objectOrigin,
		CHECKPOINT_ASSET_OSS_REGION: "us-east-1",
		CHECKPOINT_ASSET_OSS_BUCKET: "cohub-assets",
		CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID: "S3RVER",
		CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY: "S3RVER",
		S3_FORCE_PATH_STYLE: "true",
	};
	return values;
}

async function resolveSkillsPath() {
	for (const candidate of [
		process.env.COHUB_PERSONAL_NODE_SKILLS_PATH,
		join(homedir(), ".agents", "skills"),
		join(homedir(), ".codex", "skills"),
	]) {
		if (!candidate) continue;
		try {
			await access(candidate);
			return candidate;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	const emptySkills = join(dataRoot, "skills");
	await mkdir(emptySkills, { recursive: true });
	return emptySkills;
}

async function syncLocalCatalogs(env) {
	Object.assign(process.env, env);
	const workerDist = join(runtimeRoot, "node_modules", "@cohub", "worker", "dist");
	const [{ publishModelsCacheFromFile }, { publishSkillsCacheFromDir }, { redisCommandClient }] =
		await Promise.all([
			import(pathToFileURL(join(workerDist, "models-cache.js")).href),
			import(pathToFileURL(join(workerDist, "skills-cache.js")).href),
			import(pathToFileURL(join(workerDist, "redis.js")).href),
		]);
	await publishModelsCacheFromFile({
		modelsPath: join(env.PLATFORM_CONFIG_ROOT, "platform", ".cohub", "models.json"),
		scope: "platform",
	});
	await publishSkillsCacheFromDir({
		skillsDir: env.LOCAL_AGENT_SKILLS_PATH,
		sandboxDir: env.LOCAL_AGENT_SKILLS_PATH,
		scope: "platform",
	});
	await redisCommandClient.quit();
}

async function stop(exitCode = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children.values()) child.kill("SIGTERM");
	await objectStore?.close().catch(() => undefined);
	setTimeout(() => process.exit(exitCode), 1_000);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("uncaughtException", (error) => {
	process.stderr.write(`[runtime] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	void stop(1);
});
process.once("unhandledRejection", (error) => {
	process.stderr.write(`[runtime] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	void stop(1);
});

if (await probe(`http://127.0.0.1:${ports.api}/healthz`)) {
	process.stdout.write("[runtime] ready external\n");
	setInterval(() => {}, 60_000);
} else {
	const state = await readOrCreateState();
	for (const path of ["spaces", "system", "checkpoints", "sessions", "configs", "git", "logs"]) {
		await mkdir(join(dataRoot, path), { recursive: true });
	}
	await ensurePlatformConfig();
	await Promise.all([ensurePostgres(state), ensureRedis(state), ensureObjectStore()]);
	const cliPath = await writeCliWrapper();
	const env = buildEnvironment(state, cliPath);
	env.LOCAL_AGENT_SKILLS_PATH = await resolveSkillsPath();
	await runChild(
		"db-migrate",
		process.execPath,
		[nodeEntry("@cohub/api", "dist/db/migrate.js")],
		{ ...env, ELECTRON_RUN_AS_NODE: "1" },
		dirname(nodeEntry("@cohub/api", "package.json")),
	);
	await syncLocalCatalogs(env);
	const nodeEnv = {
		...env,
		ELECTRON_RUN_AS_NODE: "1",
		NODE_OPTIONS: `--import=${pathToFileURL(join(runtimeRoot, "fetch-polyfill.mjs")).href}`,
	};
	startChild(
		"api",
		process.execPath,
		["--import", nodeEntry("@cohub/api", "dist/register-otel-esm-hook.js"), nodeEntry("@cohub/api", "dist/index.js")],
		{ ...nodeEnv, PORT: String(ports.api) },
		dirname(nodeEntry("@cohub/api", "package.json")),
	);
	startChild("worker", process.execPath, [nodeEntry("@cohub/worker", "dist/index.js")], nodeEnv);
	startChild(
		"system",
		process.execPath,
		[nodeEntry("@cohub/worker", "dist/entrances/system-worker.js")],
		nodeEnv,
	);
	startChild("agent", process.execPath, [nodeEntry("@cohub/agent", "dist/index.js")], nodeEnv);
	startChild(
		"gateway",
		process.execPath,
		[nodeEntry("@cohub/gateway", "dist/index.js")],
		{ ...nodeEnv, PORT: String(ports.gateway) },
	);
	await Promise.all([
		(async () => {
			await waitForTcp(ports.api, 90_000);
			if (!(await probe(`http://127.0.0.1:${ports.api}/healthz`, 5_000))) throw new Error("Local API health check failed");
		})(),
		(async () => {
			await waitForTcp(ports.gateway, 90_000);
			if (!(await probe(`http://127.0.0.1:${ports.gateway}/healthz`, 5_000))) throw new Error("Local Gateway health check failed");
		})(),
	]);
	startChild(
		"sandbox-supervisor",
		process.execPath,
		[join(runtimeRoot, "sandbox-supervisor.mjs")],
		nodeEnv,
	);
	process.stdout.write("[runtime] ready bundled\n");
}
