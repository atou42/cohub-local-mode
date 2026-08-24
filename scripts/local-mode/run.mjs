#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = resolve(
  process.env.COHUB_LOCAL_ENV_FILE ?? join(repoRoot, "deploy/local-mode/.env"),
);
const composeFile = join(repoRoot, "deploy/local-mode/compose.yaml");
const command = process.argv[2];
const knownCommands = new Set(["infra", "init", "build", "up", "host", "status"]);

if (!knownCommands.has(command)) {
  throw new Error(
    "Usage: node scripts/local-mode/run.mjs <infra|init|build|up|host|status>",
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

async function initialize() {
  await ensureDirectories();
  await ensurePiCatalog();
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
  await run("pnpm", ["--filter", "web", "build"]);
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
  ];
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
          "4173",
          "--local",
          "--var",
          `PUBLIC_COHUB_LOCAL_MODE:${process.env.PUBLIC_COHUB_LOCAL_MODE}`,
          "--var",
          `PUBLIC_API_ORIGIN:${process.env.PUBLIC_API_ORIGIN}`,
          "--var",
          `PUBLIC_CLOUD_API_ORIGIN:${process.env.PUBLIC_CLOUD_API_ORIGIN}`,
          "--var",
          `PUBLIC_CLOUD_GATEWAY_ORIGIN:${process.env.PUBLIC_CLOUD_GATEWAY_ORIGIN}`,
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
    ["web", webArgs, {}],
  ];
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
        env: { ...process.env, ...childEnv },
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
if (command === "build") await buildWeb();
if (command === "status") await status();
if (command === "up") {
  await startInfra();
  await initialize();
  await startServices();
}
if (command === "host") {
  await startInfra();
  await initialize();
  await buildWeb();
  await startServices("host");
}
