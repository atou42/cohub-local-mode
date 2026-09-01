#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWebDeploymentMatches,
  readLocalWebBuildVersion,
} from "./web-deployment.mjs";
import {
  assertRelayDeploymentMatches,
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
process.loadEnvFile(join(repoRoot, "deploy/local-mode/.env"));
const label = "cc.atou.cohub-local-mode";
const domain = `gui/${userInfo().uid}`;
const target = `${domain}/${label}`;
const launchAgentsDir = join(homedir(), "Library/LaunchAgents");
const plistPath = join(launchAgentsDir, `${label}.plist`);
const dataDir = resolve(
  process.env.COHUB_LOCAL_DATA_DIR ?? join(homedir(), ".cohub-local-mode"),
);
const logsDir = join(dataDir, "logs");
const command = process.argv[2];
const knownCommands = new Set(["install", "restart", "status", "uninstall"]);

if (process.platform !== "darwin") {
  throw new Error("The Local Mode service is supported only on macOS");
}
if (!knownCommands.has(command)) {
  throw new Error(
    "Usage: node scripts/local-mode/service.mjs <install|restart|status|uninstall>",
  );
}

function run(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
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

async function isLoaded() {
  try {
    await run("launchctl", ["print", target], { capture: true });
    return true;
  } catch (error) {
    if (error?.code === 113) return false;
    if (error?.stderr?.includes("Could not find service")) return false;
    throw error;
  }
}

async function stopLoadedService() {
  if (await isLoaded()) await run("launchctl", ["bootout", target]);
}

async function bootstrapService() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await run("launchctl", ["bootstrap", domain, plistPath]);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 5 || attempt === 4) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw lastError;
}

async function writePlist() {
  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "cohub-local-service-"));
  const jsonPath = join(tempDir, "service.json");
  const generatedPlistPath = join(tempDir, `${label}.plist`);
  const path = [
    dirname(process.execPath),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const definition = {
    Label: label,
    ProgramArguments: [process.execPath, runScript, "serve"],
    WorkingDirectory: repoRoot,
    EnvironmentVariables: { PATH: path },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    ThrottleInterval: 10,
    StandardOutPath: join(logsDir, "host.stdout.log"),
    StandardErrorPath: join(logsDir, "host.stderr.log"),
  };
  try {
    await writeFile(jsonPath, `${JSON.stringify(definition, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await run("plutil", ["-convert", "xml1", "-o", generatedPlistPath, jsonPath]);
    await chmod(generatedPlistPath, 0o600);
    await rename(generatedPlistPath, plistPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function waitForReady() {
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await run(process.execPath, [runScript, "status"], { capture: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
  }
  throw new Error(
    `Local Mode did not become ready: ${lastError?.stderr || lastError?.message}`,
  );
}

async function install() {
  await access(join(repoRoot, "deploy/local-mode/.env"));
  await run(process.execPath, [runScript, "build"]);
  await stopLoadedService();
  await writePlist();
  await bootstrapService();
  await run("launchctl", ["enable", target]);
  await run("launchctl", ["kickstart", "-k", target]);
  await waitForReady();
  console.log(`Local Mode service is ready: ${label}`);
}

async function restart() {
  if (!(await isLoaded())) {
    throw new Error("Local Mode service is not installed");
  }
  const localRelayVersion = await readLocalRelaySourceVersion(repoRoot);
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
    localVersion: localRelayVersion,
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
    { cwd: join(repoRoot, "apps/web"), capture: true },
  );
  const deployments = JSON.parse(stdout);
  assertWebDeploymentMatches({ localVersion, deployments });
  // bootout gives child workers a SIGTERM path so in-flight agent turns can
  // drain. kickstart -k kills the service tree and can strand a running turn.
  await stopLoadedService();
  await bootstrapService();
  await waitForReady();
  console.log(`Local Mode service restarted: ${label}`);
}

async function status() {
  if (!(await isLoaded())) {
    throw new Error("Local Mode service is not installed");
  }
  const { stdout } = await run("launchctl", ["print", target], {
    capture: true,
  });
  const state = stdout.match(/^\s*state = (.+)$/m)?.[1];
  const pid = stdout.match(/^\s*pid = (\d+)$/m)?.[1];
  console.log(`Service: ${state ?? "unknown"}${pid ? ` (pid ${pid})` : ""}`);
  await run(process.execPath, [runScript, "status"]);
}

async function uninstall() {
  await stopLoadedService();
  try {
    await access(plistPath);
    const contents = await readFile(plistPath, "utf8");
    if (!contents.includes(`<string>${label}</string>`)) {
      throw new Error(`Refusing to remove unexpected file: ${plistPath}`);
    }
    await rm(plistPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  console.log("Local Mode service removed. Local data was left unchanged.");
}

if (command === "install") await install();
if (command === "restart") await restart();
if (command === "status") await status();
if (command === "uninstall") await uninstall();
