#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWebDeploymentMatches,
  buildWebDeploymentMessage,
  readLocalWebBuildVersion,
} from "./web-deployment.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runScript = join(repoRoot, "scripts/local-mode/run.mjs");
const serviceScript = join(repoRoot, "scripts/local-mode/service.mjs");

function run(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = new Error(
        `${program} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
      );
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

await run(process.execPath, [runScript, "build"]);
const localVersion = await readLocalWebBuildVersion(repoRoot);
const deploymentMessage = buildWebDeploymentMessage(localVersion);

await run("pnpm", [
  "--filter",
  "web",
  "exec",
  "wrangler",
  "deploy",
  "--config",
  "wrangler.local-mode.toml",
  "--message",
  deploymentMessage,
]);

const { stdout } = await run(
  "pnpm",
  [
    "--filter",
    "web",
    "exec",
    "wrangler",
    "deployments",
    "list",
    "--config",
    "wrangler.local-mode.toml",
    "--json",
  ],
  { capture: true },
);
const deployments = JSON.parse(stdout);
assertWebDeploymentMatches({ localVersion, deployments });

await run(process.execPath, [serviceScript, "restart"]);
console.log(`Local Mode release is ready with web build ${localVersion}`);
