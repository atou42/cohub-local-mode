import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { publishWebBuild } from "./web-release.mjs";

async function writeBuild(root, marker, { complete = true } = {}) {
  const files = [
    ["cloudflare/_worker.js", `worker:${marker}`],
    ["cloudflare/assets/_app/version.json", `{"version":"${marker}"}`],
    ["cloudflare/assets/_app/immutable/entry/start.test.js", "start"],
    ["cloudflare/assets/_app/immutable/entry/app.test.js", "app"],
    ["cloudflare/assets/_app/immutable/assets/app.test.css", "body{}"],
    ["cloudflare-tmp/manifest.js", "export const manifest = {};"],
    ["output/server/index.js", `server:${marker}`],
  ];
  for (const [relativePath, contents] of files) {
    if (!complete && relativePath === "output/server/index.js") continue;
    const filePath = join(root, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

test("refuses an incomplete staged build without touching the current release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged", { complete: false });

    await assert.rejects(
      publishWebBuild({ currentDir, stagedDir }),
      /output\/server\/index\.js/,
    );
    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:current",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes a complete staged build and removes the previous release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");

    await publishWebBuild({ currentDir, stagedDir });

    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:staged",
    );
    await assert.rejects(readFile(stagedDir, "utf8"), /EISDIR|ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
