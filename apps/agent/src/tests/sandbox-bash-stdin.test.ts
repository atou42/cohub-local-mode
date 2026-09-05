import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const scenario of ["closed-stdin", "rpc-failure"]) {
  test(`sandbox bash stdin: ${scenario}`, () => {
    const home = mkdtempSync(join(tmpdir(), "pi-stdin-"));
    try {
      const result = spawnSync(process.execPath, [
        "--experimental-strip-types",
        "--import", fileURLToPath(new URL("../../../../scripts/test/no-network.mjs", import.meta.url)),
        fileURLToPath(new URL("./fixtures/pi-stdin-worker.mjs", import.meta.url)),
        scenario,
      ], {
        env: { HOME: home, PATH: process.env.PATH, TMPDIR: home },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { scenario, requests: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
