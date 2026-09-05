import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const worker = fileURLToPath(new URL("./fixtures/codex-cancel-worker.mjs", import.meta.url));
const noNetwork = fileURLToPath(new URL("../../../../scripts/test/no-network.mjs", import.meta.url));

for (const scenario of [
	"interrupt-error",
	"interrupt-timeout",
	"interrupt-write-error",
	"abort-before-start-notification",
	"abort-before-start-response",
	"interrupt-success",
	"late-interrupt-error",
	"late-interrupt-timeout",
]) {
	test(`Codex cancellation isolates ${scenario}`, () => {
		const home = mkdtempSync(join(tmpdir(), "cohub-cancel-test-"));
		try {
			const child = spawnSync(process.execPath, [
				"--unhandled-rejections=strict",
				"--import", noNetwork,
				worker, scenario,
			], {
				encoding: "utf8",
				timeout: 10_000,
				env: { HOME: home, TMPDIR: home, NODE_ENV: "test" },
			});
			assert.equal(child.error, undefined);
			assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
			assert.deepEqual(JSON.parse(child.stdout), {
				scenario,
				unrelatedTurn: "completed",
				followupTurn: "completed",
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
}
