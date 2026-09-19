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
const watchScript = join(repoRoot, "scripts/local-mode/upstream-watch.mjs");
const label = "cc.atou.cohub-upstream-watch";
const domain = `gui/${userInfo().uid}`;
const target = `${domain}/${label}`;
const launchAgentsDir = join(homedir(), "Library/LaunchAgents");
const plistPath = join(launchAgentsDir, `${label}.plist`);
const stateDir = resolve(
  process.env.COHUB_UPSTREAM_WATCH_STATE_DIR ||
    join(homedir(), ".cohub-upstream-watch"),
);
const logsDir = join(stateDir, "logs");
const senderRoot = resolve(
  process.env.COHUB_UPSTREAM_WATCH_SENDER_ROOT ||
    join(homedir(), "agents-in-discord"),
);
const senderScript = resolve(
  process.env.COHUB_UPSTREAM_WATCH_SENDER ||
    join(senderRoot, "scripts/send-channel-message.mjs"),
);
const threadId =
  process.env.COHUB_UPSTREAM_WATCH_THREAD_ID || "1540358055563100230";
const scheduleHour = Number(process.env.COHUB_UPSTREAM_WATCH_HOUR || 10);
const scheduleMinute = Number(process.env.COHUB_UPSTREAM_WATCH_MINUTE || 0);
const command = process.argv[2];
const knownCommands = new Set(["install", "status", "uninstall"]);

if (process.platform !== "darwin") {
  throw new Error("The upstream watch service is supported only on macOS");
}
if (!knownCommands.has(command)) {
  throw new Error(
    "Usage: node scripts/local-mode/upstream-watch-service.mjs <install|status|uninstall>",
  );
}
if (!/^\d{15,25}$/.test(threadId)) {
  throw new Error("COHUB_UPSTREAM_WATCH_THREAD_ID must be a Discord channel ID");
}
if (!Number.isInteger(scheduleHour) || scheduleHour < 0 || scheduleHour > 23) {
  throw new Error("COHUB_UPSTREAM_WATCH_HOUR must be an integer from 0 to 23");
}
if (!Number.isInteger(scheduleMinute) || scheduleMinute < 0 || scheduleMinute > 59) {
  throw new Error("COHUB_UPSTREAM_WATCH_MINUTE must be an integer from 0 to 59");
}

function run(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd || repoRoot,
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

async function isLoaded() {
  try {
    await run("launchctl", ["print", target], { capture: true });
    return true;
  } catch (error) {
    if (error?.code === 113 || error?.stderr?.includes("Could not find service")) {
      return false;
    }
    throw error;
  }
}

async function stopLoadedService() {
  if (await isLoaded()) await run("launchctl", ["bootout", target]);
}

async function writePlist() {
  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "cohub-upstream-watch-"));
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
    ProgramArguments: [process.execPath, watchScript, "--json"],
    WorkingDirectory: repoRoot,
    EnvironmentVariables: {
      HOME: homedir(),
      PATH: path,
      COHUB_UPSTREAM_WATCH_THREAD_ID: threadId,
      COHUB_UPSTREAM_WATCH_SENDER_ROOT: senderRoot,
      COHUB_UPSTREAM_WATCH_STATE_DIR: stateDir,
    },
    StartCalendarInterval: { Hour: scheduleHour, Minute: scheduleMinute },
    ProcessType: "Background",
    ThrottleInterval: 60,
    StandardOutPath: join(logsDir, "watch.stdout.log"),
    StandardErrorPath: join(logsDir, "watch.stderr.log"),
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
  await access(watchScript);
  await access(senderScript);
  await run(process.execPath, [senderScript, "--help"], { cwd: senderRoot, capture: true });
  await stopLoadedService();
  await writePlist();
  await run("launchctl", ["bootstrap", domain, plistPath]);
  await run("launchctl", ["enable", target]);
  await status();
  console.log(`Upstream watch installed: daily at ${formatTime(scheduleHour, scheduleMinute)}`);
}

async function status() {
  if (!(await isLoaded())) throw new Error("Upstream watch service is not installed");
  const { stdout } = await run("launchctl", ["print", target], { capture: true });
  const state = stdout.match(/^\s*state = (.+)$/m)?.[1] || "waiting";
  console.log(`Upstream watch: ${state}`);
  console.log(`Schedule: daily at ${formatTime(scheduleHour, scheduleMinute)} Asia/Shanghai`);
  console.log(`Discord thread: ${threadId}`);
  try {
    const value = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
    console.log(
      `Last delivery: ${value.lastCheckedAt || "unknown"} message ${value.lastMessageId || "unknown"}`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    console.log("Last delivery: none");
  }
}

async function uninstall() {
  await stopLoadedService();
  try {
    const contents = await readFile(plistPath, "utf8");
    if (!contents.includes(`<string>${label}</string>`)) {
      throw new Error(`Refusing to remove unexpected file: ${plistPath}`);
    }
    await rm(plistPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  console.log("Upstream watch removed. Reports and state were left unchanged.");
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

if (command === "install") await install();
if (command === "status") await status();
if (command === "uninstall") await uninstall();
