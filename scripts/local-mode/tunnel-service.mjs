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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = fileURLToPath(import.meta.url);
const label = "cc.atou.cohub-local-tunnel";
const keychainService = "Cohub Local Mode Cloudflare Tunnel";
const domain = `gui/${userInfo().uid}`;
const target = `${domain}/${label}`;
const launchAgentsDir = join(homedir(), "Library/LaunchAgents");
const plistPath = join(launchAgentsDir, `${label}.plist`);
const dataDir = resolve(
  process.env.COHUB_LOCAL_DATA_DIR ?? join(homedir(), ".cohub-local-mode"),
);
const logsDir = join(dataDir, "logs");
const command = process.argv[2];
const tunnelId =
  process.argv.slice(3).find((argument) => argument !== "--") ??
  process.env.COHUB_LOCAL_TUNNEL_ID;
const knownCommands = new Set([
  "install",
  "restart",
  "run",
  "status",
  "uninstall",
]);

if (process.platform !== "darwin") {
  throw new Error("The Local Mode tunnel service is supported only on macOS");
}
if (!knownCommands.has(command)) {
  throw new Error(
    "Usage: node scripts/local-mode/tunnel-service.mjs <install|restart|status|uninstall> [tunnel-id]",
  );
}
if ((command === "install" || command === "run") && !tunnelId) {
  throw new Error("A Cloudflare Tunnel ID is required");
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

async function readTunnelToken(id) {
  const { stdout } = await run(
    "/usr/bin/security",
    ["find-generic-password", "-s", keychainService, "-a", id, "-w"],
    { capture: true },
  );
  const token = stdout.trim();
  if (!token) throw new Error(`The tunnel token is empty for ${id}`);
  return token;
}

async function findCloudflared() {
  const candidates = [
    process.env.COHUB_CLOUDFLARED_BIN,
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("cloudflared is not installed");
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

async function writePlist(id, cloudflaredPath) {
  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "cohub-local-tunnel-"));
  const jsonPath = join(tempDir, "service.json");
  const generatedPlistPath = join(tempDir, `${label}.plist`);
  const path = [
    dirname(process.execPath),
    dirname(cloudflaredPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const definition = {
    Label: label,
    ProgramArguments: [process.execPath, scriptPath, "run", id],
    WorkingDirectory: repoRoot,
    EnvironmentVariables: {
      COHUB_CLOUDFLARED_BIN: cloudflaredPath,
      PATH: path,
      TUNNEL_TRANSPORT_PROTOCOL: "http2",
    },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    ThrottleInterval: 10,
    StandardOutPath: join(logsDir, "tunnel.stdout.log"),
    StandardErrorPath: join(logsDir, "tunnel.stderr.log"),
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

async function install() {
  await readTunnelToken(tunnelId);
  const cloudflaredPath = await findCloudflared();
  await run(cloudflaredPath, ["--version"], { capture: true });
  await stopLoadedService();
  await writePlist(tunnelId, cloudflaredPath);
  await run("launchctl", ["bootstrap", domain, plistPath]);
  await run("launchctl", ["enable", target]);
  await run("launchctl", ["kickstart", "-k", target]);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  await status();
  console.log(`Local Mode tunnel service is ready: ${label}`);
}

async function restart() {
  if (!(await isLoaded())) {
    throw new Error("Local Mode tunnel service is not installed");
  }
  await run("launchctl", ["kickstart", "-k", target]);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  await status();
  console.log(`Local Mode tunnel service restarted: ${label}`);
}

async function status() {
  if (!(await isLoaded())) {
    throw new Error("Local Mode tunnel service is not installed");
  }
  const { stdout } = await run("launchctl", ["print", target], {
    capture: true,
  });
  const state = stdout.match(/^\s*state = (.+)$/m)?.[1];
  const pid = stdout.match(/^\s*pid = (\d+)$/m)?.[1];
  if (state !== "running" || !pid) {
    throw new Error(`Local Mode tunnel service is ${state ?? "not running"}`);
  }
  let connectorPid;
  try {
    const result = await run(
      "/usr/bin/pgrep",
      ["-P", pid, "-x", "cloudflared"],
      { capture: true },
    );
    connectorPid = result.stdout.trim().split(/\s+/)[0];
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  if (!connectorPid) {
    throw new Error("Local Mode tunnel connector is not running");
  }
  console.log(
    `Tunnel service: ${state} (pid ${pid}, connector ${connectorPid})`,
  );
}

async function runTunnel() {
  const token = await readTunnelToken(tunnelId);
  const cloudflaredPath = await findCloudflared();
  const child = spawn(
    cloudflaredPath,
    ["tunnel", "--no-autoupdate", "run"],
    {
      cwd: repoRoot,
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: "inherit",
      shell: false,
    },
  );
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM") {
        resolvePromise();
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `cloudflared exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
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
  console.log(
    "Local Mode tunnel service removed. The Keychain token was left unchanged.",
  );
}

if (command === "install") await install();
if (command === "restart") await restart();
if (command === "run") await runTunnel();
if (command === "status") await status();
if (command === "uninstall") await uninstall();
