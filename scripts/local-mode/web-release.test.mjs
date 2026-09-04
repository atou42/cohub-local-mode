import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertWebRetentionBaselineReady,
  publishWebBuild,
  readRetainedWebBuildVersions,
} from "./web-release.mjs";

async function writeBuild(root, marker, { complete = true } = {}) {
  const files = [
    ["cloudflare/_worker.js", `worker:${marker}`],
    ["cloudflare/assets/_app/version.json", `{"version":"${marker}"}`],
    ["cloudflare/assets/_app/immutable/entry/start.test.js", "start"],
    ["cloudflare/assets/_app/immutable/entry/app.test.js", "app"],
    ["cloudflare/assets/_app/immutable/assets/app.test.css", "body{}"],
    ["cloudflare/assets/preboot-recovery.js", "recovery"],
    ["output/client/_app/immutable/entry/start.test.js", "start"],
    ["output/client/_app/immutable/entry/app.test.js", "app"],
    ["output/client/_app/immutable/assets/app.test.css", "body{}"],
    ["output/client/preboot-recovery.js", "recovery"],
    [
      "output/client/.vite/manifest.json",
      JSON.stringify({
        start: { file: "_app/immutable/entry/start.test.js" },
        app: {
          file: "_app/immutable/entry/app.test.js",
          css: ["_app/immutable/assets/app.test.css"],
        },
      }),
    ],
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

async function writeRetentionMetadata(root, builds) {
  const records = [];
  for (const build of builds) {
    const assets = [];
    for (const path of build.assets) {
      const bytes = await readFile(join(root, "cloudflare/assets", path));
      assets.push({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    records.push({ ...build, assets });
  }
  await writeFile(
    join(root, "local-mode-retention.json"),
    JSON.stringify({ builds: records }),
  );
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

test("refuses a release without the preboot recovery asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    await rm(join(stagedDir, "cloudflare/assets/preboot-recovery.js"));

    await assert.rejects(
      publishWebBuild({ currentDir, stagedDir }),
      /missing cloudflare\/assets\/preboot-recovery\.js/,
    );
    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:current",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaces generated SvelteKit metadata without treating it as a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await mkdir(join(currentDir, "generated"), { recursive: true });
    await writeFile(join(currentDir, "tsconfig.json"), "{}\n");
    await writeBuild(stagedDir, "staged");

    await publishWebBuild({
      currentDir,
      stagedDir,
      replaceGeneratedCurrent: true,
    });

    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:staged",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing local retention baseline before release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  try {
    await assert.rejects(
      assertWebRetentionBaselineReady(join(root, ".svelte-kit")),
      /missing cloudflare\/assets\/_app\/version\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps recent immutable assets from the current release without overwriting staged files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    const oldAsset = join(
      currentDir,
      "cloudflare/assets/_app/immutable/nodes/old-client.js",
    );
    const collidingAsset = join(
      currentDir,
      "cloudflare/assets/_app/immutable/entry/app.test.js",
    );
    await mkdir(dirname(oldAsset), { recursive: true });
    await writeFile(oldAsset, "old-client");
    await writeFile(collidingAsset, "app");
    const retainedMtime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    await utimes(oldAsset, retainedMtime, retainedMtime);
    await writeRetentionMetadata(currentDir, [
      {
        version: "legacy",
        retainedAt: retainedMtime.toISOString(),
        assets: ["_app/immutable/nodes/old-client.js"],
      },
    ]);

    await publishWebBuild({ currentDir, stagedDir });

    assert.equal(
      await readFile(
        join(currentDir, "cloudflare/assets/_app/immutable/nodes/old-client.js"),
        "utf8",
      ),
      "old-client",
    );
    assert.equal(
      await readFile(
        join(currentDir, "cloudflare/assets/_app/immutable/entry/app.test.js"),
        "utf8",
      ),
      "app",
    );
    const retainedStat = await stat(
      join(
        currentDir,
        "cloudflare/assets/_app/immutable/nodes/old-client.js",
      ),
    );
    assert.ok(Math.abs(retainedStat.mtimeMs - retainedMtime.getTime()) < 2);
    assert.deepEqual(
      (await readRetainedWebBuildVersions(currentDir)).map(
        (record) => record.version,
      ),
      ["legacy", "current"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a same-path immutable asset collision with different bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    await writeFile(
      join(currentDir, "cloudflare/assets/_app/immutable/entry/app.test.js"),
      "different-bytes",
    );

    await assert.rejects(
      publishWebBuild({ currentDir, stagedDir }),
      /immutable asset collision differs.*app\.test\.js/,
    );
    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:current",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects corrupt retention metadata without replacing the current release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    await writeFile(join(currentDir, "local-mode-retention.json"), "{broken");

    await assert.rejects(
      publishWebBuild({ currentDir, stagedDir }),
      /Web retention metadata is invalid JSON/,
    );
    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:current",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("drops immutable assets older than the compatibility window", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    const expiredAsset = join(
      currentDir,
      "cloudflare/assets/_app/immutable/nodes/expired-client.js",
    );
    await mkdir(dirname(expiredAsset), { recursive: true });
    await writeFile(expiredAsset, "expired");
    const expiredMtime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(expiredAsset, expiredMtime, expiredMtime);
    await writeRetentionMetadata(currentDir, [
      {
        version: "expired",
        retainedAt: expiredMtime.toISOString(),
        assets: ["_app/immutable/nodes/expired-client.js"],
      },
    ]);

    await publishWebBuild({ currentDir, stagedDir });

    await assert.rejects(
      readFile(
        join(currentDir, "cloudflare/assets/_app/immutable/nodes/expired-client.js"),
      ),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts the current public build retention window when it is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  const now = Date.parse("2026-09-03T00:00:00Z");
  try {
    await writeBuild(currentDir, "public");
    await writeBuild(stagedDir, "candidate");
    const manifestPath = join(currentDir, "output/client/.vite/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.currentOnly = {
      file: "_app/immutable/nodes/current-only.js",
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    for (const rootPath of ["output/client", "cloudflare/assets"]) {
      const assetPath = join(
        currentDir,
        rootPath,
        "_app/immutable/nodes/current-only.js",
      );
      await mkdir(dirname(assetPath), { recursive: true });
      await writeFile(assetPath, "current-public-client");
      const oldMtime = new Date(now - 90 * 24 * 60 * 60 * 1_000);
      await utimes(assetPath, oldMtime, oldMtime);
    }

    await publishWebBuild({ currentDir, stagedDir, now });

    assert.equal(
      await readFile(
        join(
          currentDir,
          "cloudflare/assets/_app/immutable/nodes/current-only.js",
        ),
        "utf8",
      ),
      "current-public-client",
    );
    const records = await readRetainedWebBuildVersions(currentDir, { now });
    const publicRecord = records.find((record) => record.version === "public");
    assert.equal(publicRecord?.retainedAt, "2026-09-03T00:00:00.000Z");
    assert.ok(
      publicRecord?.assets.some(
        (asset) => asset.path === "_app/immutable/nodes/current-only.js",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects retention metadata whose declared asset is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    await writeFile(
      join(currentDir, "local-mode-retention.json"),
      JSON.stringify({
        builds: [
          {
            version: "missing",
            retainedAt: new Date().toISOString(),
            assets: [
              {
                path: "_app/immutable/nodes/missing.js",
                sha256: "0".repeat(64),
              },
            ],
          },
        ],
      }),
    );

    await assert.rejects(
      publishWebBuild({ currentDir, stagedDir }),
      /retention metadata references a missing asset.*missing\.js/,
    );
    assert.equal(
      await readFile(join(currentDir, "cloudflare/_worker.js"), "utf8"),
      "worker:current",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects retention metadata when a declared asset was modified", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  try {
    await writeBuild(currentDir, "current");
    await writeRetentionMetadata(currentDir, [
      {
        version: "retained",
        retainedAt: new Date().toISOString(),
        assets: ["_app/immutable/entry/app.test.js"],
      },
    ]);
    await writeFile(
      join(currentDir, "cloudflare/assets/_app/immutable/entry/app.test.js"),
      "modified-but-nonempty",
    );

    await assert.rejects(
      readRetainedWebBuildVersions(currentDir),
      /retention metadata references a modified asset.*app\.test\.js/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects retention metadata dated in the future", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const now = Date.parse("2026-09-03T00:00:00Z");
  try {
    await writeBuild(currentDir, "current");
    await writeRetentionMetadata(currentDir, [
      {
        version: "future",
        retainedAt: "2026-09-04T00:00:00Z",
        assets: ["_app/immutable/entry/app.test.js"],
      },
    ]);

    await assert.rejects(
      readRetainedWebBuildVersions(currentDir, { now }),
      /invalid build record/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing manifest dependency without touching the current release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-web-release-test-"));
  const currentDir = join(root, ".svelte-kit");
  const stagedDir = join(root, ".svelte-kit-staged");
  try {
    await writeBuild(currentDir, "current");
    await writeBuild(stagedDir, "staged");
    await writeFile(
      join(stagedDir, "output/client/.vite/manifest.json"),
      JSON.stringify({ app: { file: "_app/immutable/entry/missing.js" } }),
    );

    await assert.rejects(
      publishWebBuild({ currentDir, stagedDir }),
      /missing manifest dependency.*missing\.js/,
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
