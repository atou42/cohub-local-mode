import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const root = process.env.COHUB_SMOKE_ROOT;
const evidence = process.env.COHUB_SMOKE_EVIDENCE;
const started = Date.now();
const checks = [];
const ownedPids = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function owner() {
  return JSON.parse(await readFile(join(root, "data", "local-data", "runtime-owner.json"), "utf8"));
}
function pass(check, detail) {
  const result = { check, detail, atMs: Date.now() - started };
  checks.push(result);
  console.log(JSON.stringify(result));
}

async function run() {
try {
  await import("./build/main.js");
  await until(() => BrowserWindow.getAllWindows().length === 1, "first window");
  const first = BrowserWindow.getAllWindows()[0];
  await until(() => first.webContents.getURL().startsWith("data:"), "startup page");
  await until(() => first.webContents.executeJavaScript("Boolean(window.cohubDesktop && document.getElementById('status'))"), "startup preload");
  assert.equal(first.isVisible(), true);
  assert.match(await first.webContents.executeJavaScript("document.getElementById('status').textContent"), /^Starting local (services|workspace)$/);
  pass("window-before-runtime", { windowId: first.id });
  await writeFile(join(evidence, "启动窗口.png"), (await first.webContents.capturePage()).toPNG());
  first.setSize(760, 520);
  await sleep(100);
  const layout = await first.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON());
    document.getElementById('diagnostics').focus();
    return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, focused: document.activeElement.id, buttons };
  })()`);
  assert.equal(layout.overflow, false);
  assert.equal(layout.focused, "diagnostics");
  for (const button of layout.buttons) assert.ok(button.left >= 0 && button.right <= layout.width);
  pass("minimum-window-layout-and-keyboard-focus", layout);
  await writeFile(join(evidence, "最小启动窗口.png"), (await first.webContents.capturePage()).toPNG());
  first.setSize(1280, 850);
  await until(async () => {
    try { await owner(); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }, "runtime owner persistence");
  ownedPids.push((await owner()).pid);

  await until(async () => first.webContents.getURL().startsWith("data:") &&
    (await first.webContents.executeJavaScript("window.cohubDesktop.getStatus()")).state === "recovering", "recovery status");
  const recoveryText = await first.webContents.executeJavaScript("document.getElementById('status').textContent");
  assert.match(recoveryText, /Recovering local services/);
  await writeFile(join(evidence, "恢复窗口.png"), (await first.webContents.capturePage()).toPNG());
  const statusAfterCapture = await first.webContents.executeJavaScript("window.cohubDesktop.getStatus()");
  assert.notEqual(statusAfterCapture.state, "error", "A delayed window-open failure must not overwrite recovery");
  pass("startup-failure-visible", recoveryText);

  await until(async () => {
    if (first.webContents.getURL().endsWith("/sessions")) return true;
    const status = await first.webContents.executeJavaScript("window.cohubDesktop.getStatus()");
    assert.notEqual(status.state, "error", "Automatic recovery must not show a terminal failure");
    return false;
  }, "automatic workspace navigation");
  await until(async () => (await first.webContents.executeJavaScript("document.body.textContent")).includes("Lifecycle fixture 2"), "authenticated second runtime");
  const secondOwner = await owner();
  ownedPids.push(secondOwner.pid);
  pass("automatic-recovery-same-window", { windowId: first.id, attempt: 2 });

  process.kill(secondOwner.pid, "SIGTERM");
  await until(async () => first.webContents.getURL().endsWith("/sessions") &&
    (await first.webContents.executeJavaScript("document.body.textContent")).includes("Lifecycle fixture 3"), "runtime restart navigation");
  const thirdOwner = await owner();
  ownedPids.push(thirdOwner.pid);
  pass("runtime-secret-rotation", { attempt: 3, authenticatedPage: true });

  first.close();
  await until(() => BrowserWindow.getAllWindows().length === 0, "closed window");
  process.kill(thirdOwner.pid, 0);
  pass("close-keeps-runtime", true);
  app.emit("activate");
  await until(() => BrowserWindow.getAllWindows().length === 1, "reopened window");
  const reopened = BrowserWindow.getAllWindows()[0];
  await until(async () => reopened.webContents.getURL().endsWith("/sessions") &&
    (await reopened.webContents.executeJavaScript("document.body.textContent")).includes("Lifecycle fixture 3"), "reopened authenticated workspace");
  assert.equal((await owner()).pid, thirdOwner.pid);
  pass("reopen-keeps-runtime", { windowId: reopened.id });
  await writeFile(join(evidence, "桌面生命周期实测.json"), JSON.stringify({ checks, ownedPids }, null, 2));
  await reopened.webContents.executeJavaScript("window.cohubDesktop.quit()");
} catch (error) {
  console.error(error);
  await writeFile(join(evidence, "桌面生命周期失败.json"), JSON.stringify({ error: error.stack, checks, ownedPids }, null, 2));
  app.quit();
  process.exitCode = 1;
}
}
void run();
