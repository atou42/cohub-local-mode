import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("routes the stable preboot recovery asset through the public Web Worker", async () => {
  const config = await readFile(
    join(repoRoot, "apps/web/wrangler.local-mode.toml"),
    "utf8",
  );
  assert.match(
    config,
    /pattern = "cohub\.atou\.cc\/preboot-recovery\.js"/,
  );
});

test("prevents intermediary caches from pinning the recovery script", async () => {
  const headers = await readFile(join(repoRoot, "apps/web/_headers"), "utf8");
  assert.match(
    headers,
    /\/preboot-recovery\.js\s+Cache-Control: no-store, no-cache, must-revalidate/,
  );
});

test("runs retention, protocol build, and Web recovery tests before remote deploy", async () => {
  const release = await readFile(
    join(repoRoot, "scripts/local-mode/release.mjs"),
    "utf8",
  );
  const retentionGate = release.indexOf("assertWebRetentionBaseline({");
  const protocolBuild = release.indexOf(
    'await run("pnpm", ["--filter", "@cohub/protocol", "build"]);',
  );
  const recoveryTests = release.indexOf(
    'await run("pnpm", ["--filter", "web", "test"]);',
  );
  const firstDeploy = release.indexOf('"deploy",');

  assert.ok(retentionGate >= 0 && retentionGate < firstDeploy);
  assert.ok(protocolBuild >= 0 && protocolBuild < firstDeploy);
  assert.ok(recoveryTests >= 0 && recoveryTests < firstDeploy);
});
