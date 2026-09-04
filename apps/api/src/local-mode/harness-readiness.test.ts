import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHarness } from "@cohub/protocol";
import { createHarnessReadinessService } from "./harness-readiness.js";

test("readiness keeps Pi ready and classifies unavailable host harnesses", async () => {
  const service = createHarnessReadinessService({
    probeExecutable: async (harness) => harness === "codex"
      ? { installed: true, version: "codex-cli 1" }
      : harness === "cursor"
        ? { installed: true, version: "cursor-agent 1" }
        : { installed: false },
    hasAuthentication: async (harness) => harness === "codex",
    loadCatalog: async (harness) => {
      if (harness === "cursor") throw new Error("Device not configured");
    },
    now: () => 1_000,
  });

  const result = await service.list();
  assert.equal(result.checkedAt, "1970-01-01T00:00:01.000Z");
  assert.deepEqual(
    Object.fromEntries(result.harnesses.map((entry) => [entry.harness, entry.state])),
    {
      pi: "ready",
      codex: "ready",
      grok_build: "not_installed",
      cursor: "sign_in_required",
    },
  );
  assert.equal(result.harnesses[0]?.bundled, true);
  assert.equal(result.harnesses.find((entry) => entry.harness === "grok_build")?.action?.kind, "install");
  assert.equal(result.harnesses.find((entry) => entry.harness === "cursor")?.detail, "Cursor is installed but not signed in.");
});

test("readiness coalesces concurrent probes and serves the validated TTL cache", async () => {
  let now = 10_000;
  const counts = new Map<AgentHarness, number>();
  const service = createHarnessReadinessService({
    probeExecutable: async (harness) => {
      counts.set(harness, (counts.get(harness) ?? 0) + 1);
      return { installed: true, version: `${harness}-1` };
    },
    hasAuthentication: async () => true,
    loadCatalog: async () => undefined,
    now: () => now,
    ttlMs: 5_000,
  });

  const [first, concurrent] = await Promise.all([service.list(), service.list()]);
  assert.deepEqual(concurrent, first);
  assert.deepEqual([...counts.values()], [1, 1, 1]);

  now += 4_999;
  assert.deepEqual(await service.list(), first);
  assert.deepEqual([...counts.values()], [1, 1, 1]);

  now += 2;
  const refreshed = await service.list();
  assert.notEqual(refreshed.checkedAt, first.checkedAt);
  assert.deepEqual([...counts.values()], [2, 2, 2]);
});
