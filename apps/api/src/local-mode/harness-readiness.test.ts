import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHarness } from "@cohub/protocol";
import { createHarnessReadinessService } from "./harness-readiness.js";

test("readiness keeps Pi ready and classifies unavailable host harnesses", async () => {
  const service = createHarnessReadinessService({
    hasConfiguredPiModel: async () => true,
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
    hasConfiguredPiModel: async () => true,
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

test("bundled Pi is not ready without a configured model provider", async () => {
  const service = createHarnessReadinessService({
    probeExecutable: async () => ({ installed: true }),
    hasAuthentication: async () => true,
    loadCatalog: async () => undefined,
    hasConfiguredPiModel: async () => false,
  });
  const pi = (await service.list()).harnesses.find((entry) => entry.harness === "pi");
  assert.equal(pi?.bundled, true);
  assert.equal(pi?.state, "setup_required");
  assert.match(pi?.detail ?? "", /model provider/i);
});

test("Pi configuration checks are scoped to the requesting user", async () => {
  const service = createHarnessReadinessService({
    probeExecutable: async () => ({ installed: false }),
    hasAuthentication: async () => true,
    loadCatalog: async () => undefined,
    hasConfiguredPiModel: async (userId) => userId === "configured-user",
  });
  assert.equal((await service.list({ userId: "configured-user" })).harnesses[0]?.state, "ready");
  assert.equal((await service.list({ userId: "new-user" })).harnesses[0]?.state, "setup_required");
});

test("broken Pi configuration and CLI status timeouts are errors, not sign-in prompts", async () => {
  const service = createHarnessReadinessService({
    probeExecutable: async () => ({ installed: true }),
    hasAuthentication: async () => { throw new Error("CLI authentication status timed out"); },
    loadCatalog: async () => undefined,
    hasConfiguredPiModel: async () => { throw new Error("Models catalog file is invalid JSON"); },
  });
  const result = await service.list();
  assert.ok(result.harnesses.every((entry) => entry.state === "unavailable"));
  assert.match(result.harnesses[0]?.detail ?? "", /invalid JSON/);
});
