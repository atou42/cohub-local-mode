#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseSnapshot, recoverRelease } from "./release-recovery.mjs";

import {
  assertWebDeploymentMatches,
  assertWebRetentionBaseline,
  buildWebDeploymentMessage,
  readLocalWebBuildVersion,
} from "./web-deployment.mjs";
import {
  assertWebRetentionBaselineReady,
  readRetainedWebBuildVersions,
} from "./web-release.mjs";
import {
  assertRelayDeploymentMatches,
  assertRelaySecrets,
  buildRelayDeploymentMessage,
  readLocalRelaySourceVersion,
  relayHealthUrl,
  waitForRelayHealth,
} from "./relay-deployment.mjs";
import {
  RELAY_BROWSER_PROTOCOL_VERSION,
  RELAY_EVENT_SCHEMA_VERSION,
  RELAY_PROTOCOL_VERSION,
} from "../../apps/local-relay/node/protocol-compat.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runScript = join(repoRoot, "scripts/local-mode/run.mjs");
const serviceScript = join(repoRoot, "scripts/local-mode/service.mjs");

function executeCommand(program, args, options = {}) {
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

export async function releaseLocalMode(dependencies = {}) {
  const {
    run = executeCommand,
    readWebVersion = readLocalWebBuildVersion,
    readRelayVersion = readLocalRelaySourceVersion,
    retentionReady = assertWebRetentionBaselineReady,
    readRetainedVersions = readRetainedWebBuildVersions,
    health = waitForRelayHealth,
    relayUrl = process.env.COHUB_LOCAL_RELAY_URL,
    log = console.log,
  } = dependencies;
  const relay = {
    name: "relay",
    prefix: ["exec", "wrangler"],
    config: "wrangler.toml",
    options: { cwd: join(repoRoot, "apps/local-relay") },
    attempted: false,
  };
  const web = {
    name: "web",
    prefix: ["--filter", "web", "exec", "wrangler"],
    config: "wrangler.local-mode.toml",
    options: {},
    attempted: false,
  };
  async function listDeployments(target) {
    const { stdout } = await run("pnpm", [
      ...target.prefix, "deployments", "list", "--config", target.config, "--json",
    ], { ...target.options, capture: true });
    return JSON.parse(stdout);
  }
  async function readCurrent(target) {
    return readReleaseSnapshot(await listDeployments(target), target.name);
  }

  const retainedWebVersion = await readWebVersion(repoRoot);
  await retentionReady(join(repoRoot, "apps/web/.svelte-kit"));
  const retainedVersions = await readRetainedVersions(join(repoRoot, "apps/web/.svelte-kit"));
  const retainedDeployments = await listDeployments(web);
  readReleaseSnapshot(retainedDeployments, web.name);
  assertWebRetentionBaseline({
    localVersion: retainedWebVersion,
    retainedVersions,
    deployments: retainedDeployments,
  });

  await run("pnpm", ["--filter", "@cohub/protocol", "build"]);
  await run(process.execPath, [runScript, "build"]);
  await run("pnpm", ["--filter", "@cohub/local-relay", "build"]);
  await run(process.execPath, [
    "--experimental-strip-types",
    "--test",
    join(repoRoot, "scripts/local-mode/protocol-compatibility.test.mjs"),
    join(repoRoot, "scripts/local-mode/web-client-recovery-config.test.mjs"),
  ]);
  await run("pnpm", ["--filter", "web", "test"]);

  const relayVersion = await readRelayVersion(repoRoot);
  relay.message = buildRelayDeploymentMessage(relayVersion);
  const { stdout: relaySecretsStdout } = await run(
    "pnpm",
    ["exec", "wrangler", "secret", "list", "--config", "wrangler.toml"],
    { ...relay.options, capture: true },
  );
  assertRelaySecrets(JSON.parse(relaySecretsStdout));
  const healthUrl = relayHealthUrl(relayUrl);
  const localVersion = await readWebVersion(repoRoot);
  const webCompatibility = {
    nodeProtocolVersion: RELAY_PROTOCOL_VERSION,
    browserProtocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
    eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
  };
  web.message = buildWebDeploymentMessage(localVersion, webCompatibility);

  // Re-read both targets after the build so recovery uses the actual pre-release versions.
  relay.previous = await readCurrent(relay);
  const webBeforeDeploy = await listDeployments(web);
  web.previous = readReleaseSnapshot(webBeforeDeploy, web.name);
  assertWebRetentionBaseline({
    localVersion: retainedWebVersion,
    retainedVersions,
    deployments: webBeforeDeploy,
  });

  let stage = "relay deploy";
  try {
    for (const target of [relay, web]) {
      stage = `${target.name} deploy`;
      // A failed CLI call may already have changed the public deployment.
      target.attempted = true;
      await run("pnpm", [
        ...target.prefix, "deploy", "--config", target.config, "--message", target.message,
      ], target.options);
      stage = `${target.name} verify`;
      const deployments = await listDeployments(target);
      const current = readReleaseSnapshot(deployments, target.name);
      if (current.message !== target.message) {
        throw new Error(`${target.name}: deployed workers/message does not match this release`);
      }
      target.deployedVersionId = current.versionId;
      if (target === relay) {
        assertRelayDeploymentMatches({ localVersion: relayVersion, deployments });
        stage = "relay health";
        await health({
          url: healthUrl,
          expected: {
            protocolVersion: RELAY_PROTOCOL_VERSION,
            eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
            browserProtocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
          },
        });
      } else {
        assertWebDeploymentMatches({ localVersion, compatibility: webCompatibility, deployments });
      }
    }
  } catch (originalError) {
    await recoverRelease({ targets: [relay, web], run, readCurrent, originalError, failedStage: stage });
  }

  try {
    await run(process.execPath, [serviceScript, "restart"]);
  } catch (error) {
    throw new Error(`Local Mode restart failed: ${error instanceof Error ? error.message : String(error)}. Remote deployments were not rolled back because local process state is unknown.`, { cause: error });
  }
  log(`Local Mode release is ready with web build ${localVersion} and Relay ${relayVersion}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.loadEnvFile(join(repoRoot, "deploy/local-mode/.env"));
  await releaseLocalMode();
}
