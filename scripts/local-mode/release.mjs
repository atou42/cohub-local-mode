#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWebDeploymentMatches,
  buildWebDeploymentMessage,
  readLocalWebBuildVersion,
} from "./web-deployment.mjs";
import {
  assertRelayDeploymentMatches,
  assertRelaySecrets,
  buildRelayDeploymentMessage,
  readLocalRelaySourceVersion,
  relayHealthUrl,
  waitForRelayHealth,
} from "./relay-deployment.mjs";
import {
  RELAY_EVENT_SCHEMA_VERSION,
  RELAY_PROTOCOL_VERSION,
} from "../../apps/local-relay/node/protocol-compat.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runScript = join(repoRoot, "scripts/local-mode/run.mjs");
const serviceScript = join(repoRoot, "scripts/local-mode/service.mjs");
process.loadEnvFile(join(repoRoot, "deploy/local-mode/.env"));

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
await run("pnpm", ["--filter", "@cohub/local-relay", "build"]);

const relayVersion = await readLocalRelaySourceVersion(repoRoot);
const relayDeploymentMessage = buildRelayDeploymentMessage(relayVersion);
const { stdout: relaySecretsStdout } = await run(
  "pnpm",
  ["exec", "wrangler", "secret", "list", "--config", "wrangler.toml"],
  { cwd: join(repoRoot, "apps/local-relay"), capture: true },
);
assertRelaySecrets(JSON.parse(relaySecretsStdout));
await run(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.toml",
    "--message",
    relayDeploymentMessage,
  ],
  { cwd: join(repoRoot, "apps/local-relay") },
);
const { stdout: relayDeploymentsStdout } = await run(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deployments",
    "list",
    "--config",
    "wrangler.toml",
    "--json",
  ],
  { cwd: join(repoRoot, "apps/local-relay"), capture: true },
);
assertRelayDeploymentMatches({
  localVersion: relayVersion,
  deployments: JSON.parse(relayDeploymentsStdout),
});
await waitForRelayHealth({
  url: relayHealthUrl(process.env.COHUB_LOCAL_RELAY_URL),
  expected: {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
  },
});

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
console.log(
  `Local Mode release is ready with web build ${localVersion} and Relay ${relayVersion}`,
);
