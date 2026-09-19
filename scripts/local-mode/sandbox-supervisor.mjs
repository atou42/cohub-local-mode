#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ManagedSandboxSupervisor } from "./sandbox-supervisor-core.mjs";

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);
const workerSecret = process.env.WORKER_SECRET?.trim();
const storageRoot = process.env.SPACE_STORAGE_ROOT?.trim();
const relayToken = process.env.LOCAL_SANDBOX_RELAY_TOKEN?.trim();
const relayUrl =
  process.env.COHUB_RELAY_URL?.trim() ??
  "ws://127.0.0.1:8788/sandbox/relay";
const pollIntervalMs = Number(
  process.env.LOCAL_SANDBOX_SUPERVISOR_POLL_MS ?? 1_000,
);
const startupTimeoutMs = Number(
  process.env.LOCAL_SANDBOX_STARTUP_TIMEOUT_MS ?? 15_000,
);

if (!workerSecret) throw new Error("WORKER_SECRET is required");
if (!storageRoot) throw new Error("SPACE_STORAGE_ROOT is required");
if (!relayToken) throw new Error("LOCAL_SANDBOX_RELAY_TOKEN is required");
if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 250) {
  throw new Error("LOCAL_SANDBOX_SUPERVISOR_POLL_MS must be at least 250");
}
if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 1_000) {
  throw new Error("LOCAL_SANDBOX_STARTUP_TIMEOUT_MS must be at least 1000");
}

async function internalRequest(path, init = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-worker-secret": workerSecret,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(5_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data.message === "string"
        ? data.message
        : `HTTP ${response.status}`;
    throw new Error(`${path} failed: ${message}`);
  }
  return data;
}

async function listSpaces() {
  const data = await internalRequest("/internal/gateway/local-sandbox/managed");
  if (!data || !Array.isArray(data.sandboxes)) {
    throw new Error("managed sandbox inventory is malformed");
  }
  return data.sandboxes.map((sandbox) => {
    if (
      !sandbox ||
      typeof sandbox.spaceId !== "string" ||
      typeof sandbox.status !== "string"
    ) {
      throw new Error("managed sandbox inventory contains an invalid entry");
    }
    return {
      spaceId: sandbox.spaceId,
      status: sandbox.status,
      reportedAt:
        typeof sandbox.reportedAt === "string" ? sandbox.reportedAt : null,
    };
  });
}

async function reportStatus(input) {
  await internalRequest("/internal/gateway/local-sandbox/supervisor-status", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function lineWriter(spaceId, stream, onLine) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      stream.write(`[${spaceId.slice(0, 8)}] ${line}\n`);
      onLine(line);
    }
  };
}

async function startRunner({ spaceId, workspaceDir }) {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@neta-art/cohub-cli",
      "exec",
      "tsx",
      "src/index.ts",
      "sandbox",
      "up",
      workspaceDir,
      "--space",
      spaceId,
      "--yes",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COHUB_API_URL: apiBaseUrl,
        COHUB_WS_URL: "ws://127.0.0.1:8788/ws",
        COHUB_WEB_URL: "http://127.0.0.1:4173",
        COHUB_RELAY_URL: relayUrl,
        COHUB_LOCAL_SANDBOX_MANAGED: "1",
        LOCAL_SANDBOX_RELAY_TOKEN: relayToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let exitResult = null;
  const exitListeners = new Set();
  let registered = false;
  let relinquished = false;
  let lastReportedError = null;
  const observeLine = (line) => {
    if (line.includes("relay registered")) registered = true;
    if (line.includes("replaced by new runner")) {
      relinquished = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      return;
    }
    if (!line.includes("relay rejected connection")) return;
    if (line === lastReportedError) return;
    lastReportedError = line;
    void reportStatus({ spaceId, status: "error", message: line }).catch(
      (error) => console.error(`[${spaceId.slice(0, 8)}] ${error.message}`),
    );
  };
  child.stdout.on("data", lineWriter(spaceId, process.stdout, observeLine));
  child.stderr.on("data", lineWriter(spaceId, process.stderr, observeLine));

  const handle = {
    onExit(listener) {
      if (exitResult) queueMicrotask(() => listener(exitResult));
      else exitListeners.add(listener);
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };

  child.once("exit", (code, signal) => {
    exitResult = { code, signal, relinquished };
    for (const listener of exitListeners) listener(exitResult);
    exitListeners.clear();
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const timer = setTimeout(() => {
    if (registered || exitResult) return;
    void reportStatus({
      spaceId,
      status: "error",
      message: `local sandbox runner did not become ready within ${startupTimeoutMs}ms`,
    }).catch((error) =>
      console.error(`[${spaceId.slice(0, 8)}] ${error.message}`),
    );
  }, startupTimeoutMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
  return handle;
}

const supervisor = new ManagedSandboxSupervisor({
  storageRoot,
  listSpaces,
  startRunner,
  reportStatus,
  ensureDirectory: (path) => mkdir(path, { recursive: true }),
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await supervisor.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

while (!stopping) {
  try {
    await supervisor.reconcile();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!stopping) await sleep(pollIntervalMs);
}
