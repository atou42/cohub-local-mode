#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { publishWebBuild } from "./web-release.mjs";
import { probeLocalAppShell } from "./web-health.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = resolve(
  process.env.COHUB_LOCAL_ENV_FILE ?? join(repoRoot, "deploy/local-mode/.env"),
);
const composeFile = join(repoRoot, "deploy/local-mode/compose.yaml");
const webProxyScript = join(repoRoot, "scripts/local-mode/web-proxy.mjs");
const privateIngressScript = join(
  repoRoot,
  "scripts/local-mode/private-ingress.mjs",
);
const sandboxSupervisorScript = join(
  repoRoot,
  "scripts/local-mode/sandbox-supervisor.mjs",
);
const localSandboxBinary = join(
  repoRoot,
  "apps/sandbox/.local-build/cohub-sandboxd",
);
const localToolPath = join(repoRoot, "scripts/local-mode/bin");
process.env.LOCAL_COHUB_CLI_PATH = join(localToolPath, "cohub");
const command = process.argv[2];
const knownCommands = new Set([
  "infra",
  "init",
  "build",
  "up",
  "host",
  "serve",
  "status",
]);

if (!knownCommands.has(command)) {
  throw new Error(
    "Usage: node scripts/local-mode/run.mjs <infra|init|build|up|host|serve|status>",
  );
}

try {
  await access(envFile);
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(`Missing ${envFile}. Run \`pnpm local:setup\` first.`);
  }
  throw error;
}
process.loadEnvFile(envFile);
process.env.LOCAL_USER_AGENTS_PATH ??= join(homedir(), ".codex", "AGENTS.md");
process.env.LOCAL_AGENT_SKILLS_PATH ??= join(homedir(), ".agents", "skills");

const required = [
  "COHUB_LOCAL_DATA_DIR",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "DATABASE_URL",
  "REDIS_URL",
  "BULLMQ_REDIS_URL",
  "APP_ENCRYPTION_KEY",
  "WORKER_SECRET",
  "SPACE_STORAGE_ROOT",
  "SPACE_SYSTEM_ROOT",
  "CHECKPOINT_CACHE_ROOT",
  "SESSIONS_DIR",
  "PLATFORM_CONFIG_ROOT",
  "LOCAL_GIT_ROOT",
  "PUBLIC_COHUB_LOCAL_MODE",
  "PUBLIC_API_ORIGIN",
  "PUBLIC_CLOUD_API_ORIGIN",
  "PUBLIC_CLOUD_GATEWAY_ORIGIN",
];
for (const name of required) {
  if (!process.env[name]?.trim())
    throw new Error(`Missing required Local Mode setting: ${name}`);
}
for (const name of [
  "COHUB_LOCAL_DATA_DIR",
  "SPACE_STORAGE_ROOT",
  "SPACE_SYSTEM_ROOT",
  "CHECKPOINT_CACHE_ROOT",
  "SESSIONS_DIR",
  "PLATFORM_CONFIG_ROOT",
  "LOCAL_GIT_ROOT",
]) {
  if (!isAbsolute(process.env[name]))
    throw new Error(`${name} must be an absolute path`);
}
if (process.env.COHUB_NODE_ORIGIN !== "local") {
  throw new Error("COHUB_NODE_ORIGIN must be local for Local Mode");
}
process.env.LOCAL_SANDBOX_RELAY_TOKEN = createHmac(
  "sha256",
  process.env.WORKER_SECRET,
)
  .update("cohub-local-sandbox-relay-v1")
  .digest("base64url");

const composeArgs = ["compose", "--env-file", envFile, "-f", composeFile];

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
      else
        reject(
          new Error(
            `${program} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
    });
  });
}

async function startInfra() {
  await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  await run("docker", [...composeArgs, "config", "--quiet"]);
  await run("docker", [
    ...composeArgs,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
  ]);
}

async function ensureDirectories() {
  await Promise.all(
    [
      process.env.COHUB_LOCAL_DATA_DIR,
      process.env.SPACE_STORAGE_ROOT,
      process.env.SPACE_SYSTEM_ROOT,
      process.env.CHECKPOINT_CACHE_ROOT,
      process.env.SESSIONS_DIR,
      process.env.PLATFORM_CONFIG_ROOT,
      process.env.LOCAL_GIT_ROOT,
    ].map((path) => mkdir(path, { recursive: true })),
  );
}

async function ensurePiCatalog() {
  const modelPath = join(
    process.env.PLATFORM_CONFIG_ROOT,
    "platform/.cohub/models.json",
  );
  try {
    await access(modelPath);
    JSON.parse(await readFile(modelPath, "utf8"));
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const provider = process.env.LOCAL_PI_PROVIDER?.trim() || "openai";
  const model = process.env.LOCAL_PI_MODEL?.trim() || "gpt-5.1-codex-mini";
  const baseUrl =
    process.env.LOCAL_PI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const catalog = {
    providers: {
      [provider]: {
        api: "openai-responses",
        baseUrl,
        apiKey: "LOCAL_PI_API_KEY",
        models: [
          { id: model, name: model, reasoning: true, input: ["text", "image"] },
        ],
      },
    },
  };
  await mkdir(dirname(modelPath), { recursive: true });
  await writeFile(modelPath, `${JSON.stringify(catalog, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function ensureLocalAgentContext() {
  const source = process.env.LOCAL_AGENT_SKILLS_PATH;
  try {
    await access(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.warn(`Local machine skills are unavailable: ${source}`);
      return;
    }
    throw error;
  }
  console.log(`Using Local Mode skills directory: ${source}`);
}

async function syncPiCatalogCache() {
  await run("pnpm", [
    "--filter",
    "@cohub/worker",
    "exec",
    "tsx",
    "scripts/sync-local-model-cache.ts",
  ]);
}

async function syncSkillsCatalogCache() {
  await run("pnpm", [
    "--filter",
    "@cohub/worker",
    "exec",
    "tsx",
    "scripts/sync-local-skills-cache.ts",
  ]);
}

async function initialize() {
  await ensureDirectories();
  await ensurePiCatalog();
  await ensureLocalAgentContext();
  await syncPiCatalogCache();
  await syncSkillsCatalogCache();
  await run("pnpm", ["--filter", "@cohub/api", "db:migrate"]);
  await run("pnpm", [
    "--filter",
    "@cohub/api",
    "exec",
    "tsx",
    "scripts/init-local-object-store.ts",
  ]);
}

async function buildWeb() {
  const webRoot = join(repoRoot, "apps/web");
  const currentDir = join(webRoot, ".svelte-kit");
  const stagedName = ".svelte-kit-local-build";
  const stagedDir = join(webRoot, stagedName);
  try {
    await access(stagedDir);
    const failedDir = join(webRoot, `.svelte-kit-failed-${Date.now()}`);
    await rename(stagedDir, failedDir);
    console.warn(`Archived the previous failed web build at ${failedDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await run("pnpm", ["--filter", "web", "build"], {
      env: {
        COHUB_WEB_BUILD_OUT_DIR: stagedName,
        COHUB_WEB_WRANGLER_CONFIG: "wrangler.local-build.toml",
      },
    });
    await publishWebBuild({
      currentDir,
      stagedDir,
      replaceGeneratedCurrent: true,
    });
  } catch (error) {
    throw new Error(
      `Web build was not published. The previous build is unchanged; staged evidence is at ${stagedDir}`,
      { cause: error },
    );
  }
}

async function buildLocalSandbox() {
  const outputDir = dirname(localSandboxBinary);
  const staged = join(outputDir, `cohub-sandboxd.${process.pid}.next`);
  await mkdir(outputDir, { recursive: true });
  try {
    await run(
      "go",
      [
        "build",
        "-ldflags",
        "-X main.buildVersion=local-dev",
        "-o",
        staged,
        ".",
      ],
      { cwd: join(repoRoot, "apps/sandbox") },
    );
    await rename(staged, localSandboxBinary);
  } finally {
    await rm(staged, { force: true });
  }
  process.env.COHUB_SANDBOXD_BIN = localSandboxBinary;
}

async function requireLocalSandboxBuild() {
  try {
    await access(localSandboxBinary);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing compiled local sandbox. Run `pnpm local:build` first.");
    }
    throw error;
  }
  process.env.COHUB_SANDBOXD_BIN = localSandboxBinary;
}

async function requireWebBuild() {
  const workerPath = join(
    repoRoot,
    "apps/web/.svelte-kit/cloudflare/_worker.js",
  );
  try {
    await access(workerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing compiled web client. Run `pnpm local:build` first.");
    }
    throw error;
  }
}

function probeHttp(url, timeoutMs = 3000) {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  }).then((response) => {
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.text();
  });
}

function probeTcp(port, timeoutMs = 3000) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    const timeout = setTimeout(
      () => socket.destroy(new Error(`127.0.0.1:${port} timed out`)),
      timeoutMs,
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function status() {
  const checks = [
    ["Postgres", () => probeTcp(process.env.LOCAL_POSTGRES_PORT ?? "54329")],
    ["Redis", () => probeTcp(process.env.LOCAL_REDIS_PORT ?? "6380")],
    [
      "Object store",
      () =>
        probeHttp(
          `http://127.0.0.1:${process.env.LOCAL_MINIO_PORT ?? "9000"}/minio/health/live`,
        ),
    ],
    ["API", () => probeHttp("http://127.0.0.1:8787/healthz")],
    ["Gateway", () => probeHttp("http://127.0.0.1:8788/healthz")],
    ["Web", () => probeHttp("http://127.0.0.1:4173/robots.txt", 10_000)],
    [
      "Web app shell",
      () =>
        probeLocalAppShell({
          url: "http://127.0.0.1:4173/spaces/release-health",
        }),
    ],
    [
      "Private ingress",
      () => probeHttp("http://127.0.0.1:4180/api/local-mode/route-health"),
    ],
  ];
  if (process.env.COHUB_LOCAL_RELAY_URL?.trim()) {
    checks.push([
      "Cloudflare relay node",
      async () => {
        const statusPath = join(
          process.env.COHUB_LOCAL_DATA_DIR,
          "relay-node-status.json",
        );
        const relayStatus = JSON.parse(await readFile(statusPath, "utf8"));
        if (relayStatus.nodeId !== (process.env.COHUB_LOCAL_RELAY_NODE_ID?.trim() || "mac-mini")) {
          throw new Error("relay node identity does not match configuration");
        }
        if (relayStatus.state !== "connected" && relayStatus.state !== "executing") {
          throw new Error(`relay node state is ${relayStatus.state ?? "unknown"}`);
        }
      },
    ]);
  }
  let failed = false;
  for (const [name, check] of checks) {
    try {
      await check();
      console.log(`${name}: ready`);
    } catch (error) {
      failed = true;
      console.error(
        `${name}: unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  await run("docker", [...composeArgs, "ps"]);
  if (failed)
    throw new Error("One or more Local Mode services are unavailable");
}

const colors = [
  "\x1b[36m",
  "\x1b[34m",
  "\x1b[33m",
  "\x1b[32m",
  "\x1b[35m",
  "\x1b[31m",
];
const reset = "\x1b[0m";

function prefixLines(name, color, chunk) {
  return chunk
    .toString()
    .split(/\r?\n/)
    .map((line, index, lines) =>
      line === "" && index === lines.length - 1
        ? ""
        : `${color}[${name}]${reset} ${line}`,
    )
    .join("\n");
}

async function startServices(webMode = "development") {
  if (webMode !== "development" && webMode !== "host") {
    throw new Error(`Unknown Local Mode web runtime: ${webMode}`);
  }
  const webArgs =
    webMode === "host"
      ? [
          "--filter",
          "web",
          "exec",
          "wrangler",
          "dev",
          "--config",
          "wrangler.prod.toml",
          "--ip",
          "127.0.0.1",
          "--port",
          "4174",
          "--local",
          "--var",
          `PUBLIC_COHUB_LOCAL_MODE:${process.env.PUBLIC_COHUB_LOCAL_MODE}`,
          "--var",
          `PUBLIC_API_ORIGIN:${process.env.PUBLIC_API_ORIGIN}`,
          "--var",
          `PUBLIC_CLOUD_API_ORIGIN:${process.env.PUBLIC_CLOUD_API_ORIGIN}`,
          "--var",
          `PUBLIC_CLOUD_GATEWAY_ORIGIN:${process.env.PUBLIC_CLOUD_GATEWAY_ORIGIN}`,
		  "--var",
		  `PUBLIC_LOCAL_RELAY_ENABLED:${process.env.PUBLIC_LOCAL_RELAY_ENABLED ?? "false"}`,
		  "--var",
		  `PUBLIC_LOCAL_RELAY_BASE_PATH:${process.env.PUBLIC_LOCAL_RELAY_BASE_PATH ?? "/relay"}`,
		  "--var",
		  `PUBLIC_LOCAL_RELAY_NODE_ID:${process.env.PUBLIC_LOCAL_RELAY_NODE_ID ?? "mac-mini"}`,
		  `PUBLIC_LOCAL_FEDERATED_API_URL:${process.env.PUBLIC_LOCAL_FEDERATED_API_URL ?? "https://relay-node.atou.cc"}`,
        ]
      : [
          "--filter",
          "web",
          "exec",
          "vite",
          "dev",
          "--host",
          "127.0.0.1",
          "--port",
          "4173",
        ];
  if (webMode === "host" && process.env.PUBLIC_LOCAL_PRIVATE_ORIGIN?.trim()) {
    webArgs.push(
      "--var",
      `PUBLIC_LOCAL_PRIVATE_ORIGIN:${process.env.PUBLIC_LOCAL_PRIVATE_ORIGIN.trim()}`,
    );
  }
  const definitions = [
    [
      "api",
      ["--filter", "@cohub/api", "exec", "tsx", "src/index.ts"],
      { PORT: "8787" },
    ],
    [
      "worker",
      ["--filter", "@cohub/worker", "exec", "tsx", "src/index.ts"],
      {},
    ],
    [
      "system",
      [
        "--filter",
        "@cohub/worker",
        "exec",
        "tsx",
        "src/entrances/system-worker.ts",
      ],
      {},
    ],
    ["agent", ["--filter", "@cohub/agent", "exec", "tsx", "src/index.ts"], {}],
    [
      "gateway",
      ["--filter", "@cohub/gateway", "exec", "tsx", "src/index.ts"],
      { PORT: "8788" },
    ],
    [
      "sandbox-supervisor",
      ["exec", "node", sandboxSupervisorScript],
      {},
    ],
    ["web", webArgs, {}],
    ["private-ingress", ["exec", "node", privateIngressScript], {}],
  ];
  if (process.env.COHUB_LOCAL_RELAY_URL?.trim()) {
    definitions.push([
      "relay-node",
      [
        "--filter",
        "@cohub/local-relay",
        "exec",
        "node",
        "node/index.mjs",
      ],
      {},
    ]);
  }
  if (webMode === "host") {
    definitions.push([
      "web-proxy",
      ["exec", "node", webProxyScript],
      {
        COHUB_LOCAL_WEB_PORT: "4173",
        COHUB_LOCAL_WEB_WORKER_PORT: "4174",
      },
    ]);
  }
  const children = [];
  let stopping = false;
  const terminate = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode !== null || !child.pid) continue;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  };
  process.once("SIGINT", () => terminate("SIGINT"));
  process.once("SIGTERM", () => terminate("SIGTERM"));

  await new Promise((resolvePromise, reject) => {
    for (const [index, [name, args, childEnv]] of definitions.entries()) {
      const color = colors[index % colors.length];
      const child = spawn("pnpm", args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${localToolPath}:${process.env.PATH ?? ""}`,
          ...childEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
      });
      children.push(child);
      child.stdout.on("data", (chunk) =>
        process.stdout.write(prefixLines(name, color, chunk)),
      );
      child.stderr.on("data", (chunk) =>
        process.stderr.write(prefixLines(name, color, chunk)),
      );
      child.once("error", (error) => {
        terminate();
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          terminate();
          reject(
            new Error(
              `${name} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
            ),
          );
          return;
        }
        if (
          children.every(
            (entry) => entry.exitCode !== null || entry.signalCode !== null,
          )
        )
          resolvePromise();
      });
    }
  });
}

if (command === "infra") await startInfra();
if (command === "init") await initialize();
if (command === "build") {
  await buildLocalSandbox();
  await buildWeb();
}
if (command === "status") await status();
if (command === "up") {
  await startInfra();
  await initialize();
  await buildLocalSandbox();
  await startServices();
}
if (command === "host") {
  await startInfra();
  await initialize();
  await buildLocalSandbox();
  await buildWeb();
  await startServices("host");
}
if (command === "serve") {
  await requireWebBuild();
  await requireLocalSandboxBuild();
  await startInfra();
  await initialize();
  await startServices("host");
}
