import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../src/local-tmp.js";

test("worker temporary files work with the platform temporary directory", async () => {
  const directory = getWorkerLocalTmpDir("platform-test", randomUUID());
  try {
    await ensureWorkerLocalTmpDir(directory);
    assert.equal((await lstat(directory)).isDirectory(), true);
    await writeFile(join(directory, "fixture"), "isolated bytes", { flag: "wx" });
    assert.equal(await readFile(join(directory, "fixture"), "utf8"), "isolated bytes");
    await assert.rejects(ensureWorkerLocalTmpDir("/"), /unsafe local tmp path/);
    await assert.rejects(removeWorkerLocalTmpDir("/"), /unsafe local tmp path/);
  } finally {
    await removeWorkerLocalTmpDir(directory);
  }
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("a preexisting symbolic-link temp root is rejected without changing its target", async () => {
  const parent = await mkdtemp(join(tmpdir(), "cohub-tmp-root-test-"));
  const outside = join(parent, "outside");
  try {
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    await symlink(outside, join(parent, "cohub-worker"));
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const module = await import(${JSON.stringify(new URL("../src/local-tmp.ts", import.meta.url).href)});
      await assert.rejects(module.ensureWorkerLocalTmpDir(module.getWorkerLocalTmpDir('fixture')), /unsafe local tmp root/);
    `], { env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent }, stdio: "pipe" });
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve");
    assert.equal((await lstat(join(parent, "cohub-worker"))).isSymbolicLink(), true);
  } finally {
    await rm(parent, { recursive: true });
  }
});
