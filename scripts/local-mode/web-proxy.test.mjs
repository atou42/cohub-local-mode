import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const proxyScript = join(repoRoot, "scripts/local-mode/web-proxy.mjs");

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

async function waitForReady(child) {
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("web proxy did not become ready")),
      5_000,
    );
    child.stdout.on("data", (chunk) => {
      if (!chunk.toString().includes("Local Mode web proxy listening")) return;
      clearTimeout(timeout);
      resolvePromise();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`web proxy exited ${code}`)));
  });
}

test("missing immutable assets are never advertised as cacheable", async () => {
  const assetsRoot = await mkdtemp(join(tmpdir(), "cohub-web-assets-test-"));
  const existingPath = join(
    assetsRoot,
    "_app/immutable/entry/start.available.js",
  );
  await mkdir(dirname(existingPath), { recursive: true });
  await writeFile(existingPath, "export {};\n");
  const port = await reservePort();
  const child = spawn(process.execPath, [proxyScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      COHUB_LOCAL_WEB_ASSETS_ROOT: assetsRoot,
      COHUB_LOCAL_WEB_PORT: String(port),
      COHUB_LOCAL_WEB_WORKER_PORT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child);
    const existing = await fetch(
      `http://127.0.0.1:${port}/_app/immutable/entry/start.available.js`,
    );
    assert.equal(existing.status, 200);
    assert.match(existing.headers.get("cache-control"), /immutable/);

    const missing = await fetch(
      `http://127.0.0.1:${port}/_app/immutable/entry/start.missing.js`,
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(await missing.text(), "Immutable asset not found\n");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
    await rm(assetsRoot, { recursive: true, force: true });
  }
});
