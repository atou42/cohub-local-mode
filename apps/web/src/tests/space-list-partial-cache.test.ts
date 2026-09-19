import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("space list cache keeps partial results isolated and explicitly stale", () => {
	const home = mkdtempSync(join(tmpdir(), "cohub-space-list-"));
	try {
		const result = spawnSync(process.execPath, [
			"--unhandled-rejections=strict",
			"--import", fileURLToPath(new URL("../../../../scripts/test/no-network.mjs", import.meta.url)),
			"--import", fileURLToPath(new URL("../../scripts/register-alias.mjs", import.meta.url)),
			"--test", "--test-reporter=tap", fileURLToPath(new URL("./fixtures/space-list-cache-worker.ts", import.meta.url)),
		], { encoding: "utf8", timeout: 15_000, env: { HOME: home, TMPDIR: home, NODE_ENV: "test" } });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /# pass 2\b/);
		assert.match(result.stdout, /# fail 0\b/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
