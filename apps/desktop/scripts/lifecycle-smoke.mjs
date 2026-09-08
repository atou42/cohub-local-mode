import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "cohub-lifecycle-smoke-"));
const evidence = resolve(process.argv[2] ?? root);
await mkdir(evidence, { recursive: true });
await mkdir(join(root, "build"));
await mkdir(join(root, "resources", "runtime"), { recursive: true });
for (const file of await readdir(join(directory, "..", "build"))) {
  if (/\.(?:c?js|map)$/.test(file)) await copyFile(join(directory, "..", "build", file), join(root, "build", file));
}
await copyFile(join(directory, "fixtures", "lifecycle-app.mjs"), join(root, "main.mjs"));
await copyFile(join(directory, "fixtures", "lifecycle-runtime.mjs"), join(root, "resources", "runtime", "manager.mjs"));
await writeFile(join(root, "package.json"), JSON.stringify({ name: "cohub-lifecycle-smoke", type: "module", main: "main.mjs" }));
await mkdir(join(root, "assets"));
await copyFile(join(directory, "..", "assets", "Cohub.icns"), join(root, "assets", "Cohub.icns"));

async function portsFree(offset) {
  const sockets = [];
  try {
    for (const port of [54329, 6380, 9000, 8787, 8788, 4173]) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port + offset, "127.0.0.1", resolve);
      });
      sockets.push(server);
    }
    return true;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return false;
  } finally {
    await Promise.all(sockets.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
let offset;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const candidate = 5_000 + Math.floor(Math.random() * 4_000);
  if (await portsFree(candidate)) { offset = candidate; break; }
}
assert.ok(offset, "Need isolated free ports");
const child = spawn(require("electron"), [root], {
  env: {
    ...process.env, COHUB_SMOKE_ROOT: root, COHUB_SMOKE_EVIDENCE: evidence,
    COHUB_DESKTOP_TEST_HOME: join(root, "data"),
    COHUB_PERSONAL_NODE_TEST_PORT_OFFSET: String(offset),
    COHUB_CONNECTOR_DISABLE_AUTO_SIGN_IN: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 90_000);
const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
clearTimeout(timeout);
await writeFile(join(evidence, "桌面生命周期输出.log"), output);
console.log(JSON.stringify({ root, evidence, offset, exit, timedOut }));
assert.equal(exit.code, 0, output);
assert.equal(timedOut, false, `Lifecycle smoke exceeded its deadline\n${output}`);
let failure;
try { failure = JSON.parse(await readFile(join(evidence, "桌面生命周期失败.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
assert.equal(failure, undefined, failure?.error);
const report = JSON.parse(await readFile(join(evidence, "桌面生命周期实测.json"), "utf8"));
for (const pid of report.ownedPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
await assert.rejects(readFile(join(root, "data", "local-data", "runtime-owner.json")), { code: "ENOENT" });
report.checks.push({ check: "quit-removes-owned-runtime-and-owner-record", detail: true });
await writeFile(join(evidence, "桌面生命周期实测.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
