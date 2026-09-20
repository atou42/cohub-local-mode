#!/usr/bin/env node
import { envProxyExecArgv, shouldRelaunchWithEnvProxy } from "./env-proxy.js";
import { relaunchCli } from "./launcher.js";
import { ensureCliSelfUpdated, SELF_UPDATE_WORKER_ENV, startCliSelfUpdate } from "./self-update.js";

const argv = process.argv.slice(2);
const isVersionRequest = argv.some((arg) => arg === "-v" || arg === "--version");

if (process.env[SELF_UPDATE_WORKER_ENV] === "1") {
  try {
    await ensureCliSelfUpdated();
  } catch {
    // Self-update is best effort and must never affect the foreground command.
  }
  process.exit(0);
}

if (!isVersionRequest && shouldRelaunchWithEnvProxy()) {
  const entrypoint = process.argv[1];
  if (entrypoint) {
    process.exit(await relaunchCli(entrypoint, argv, {
      execArgv: [...envProxyExecArgv, ...process.execArgv],
    }));
  }
}

if (!isVersionRequest) {
  const entrypoint = process.argv[1];
  if (entrypoint) process.once("exit", () => startCliSelfUpdate(entrypoint));
}

await import("./index.js");
