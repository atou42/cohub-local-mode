import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedSandboxSupervisor,
  managedWorkspacePath,
} from "./sandbox-supervisor-core.mjs";

const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";

function childHandle() {
  let exitListener = null;
  return {
    stopped: false,
    onExit(listener) {
      exitListener = listener;
    },
    stop() {
      this.stopped = true;
    },
    exit(code = 1, extra = {}) {
      exitListener?.({ code, signal: null, ...extra });
    },
  };
}

test("concurrent reconciliation starts one isolated runner per local Space", async () => {
  const starts = [];
  const reports = [];
  const supervisor = new ManagedSandboxSupervisor({
    storageRoot: "/data/spaces",
    listSpaces: async () => [
      { spaceId: SPACE_A, status: "stopped", reportedAt: null },
      { spaceId: SPACE_B, status: "stopped", reportedAt: null },
    ],
    startRunner: async (input) => {
      starts.push(input);
      return childHandle();
    },
    reportStatus: async (input) => reports.push(input),
    ensureDirectory: async () => {},
    sleep: async () => {},
    startupTimeoutMs: 60_000,
  });

  await Promise.all([supervisor.reconcile(), supervisor.reconcile()]);

  assert.equal(starts.length, 2);
  assert.deepEqual(
    starts.map((entry) => entry.spaceId).sort(),
    [SPACE_A, SPACE_B],
  );
  assert.equal(new Set(starts.map((entry) => entry.workspaceDir)).size, 2);
  assert.ok(reports.every((entry) => entry.status === "provisioning"));
  await supervisor.stop();
});

test("fresh ready manual runner is preserved while stale ready state is recovered", async () => {
  const starts = [];
  const startedAt = 10_000;
  const supervisor = new ManagedSandboxSupervisor({
    storageRoot: "/data/spaces",
    startedAt,
    listSpaces: async () => [
      { spaceId: SPACE_A, status: "ready", reportedAt: startedAt + 1 },
      { spaceId: SPACE_B, status: "ready", reportedAt: startedAt - 1 },
    ],
    startRunner: async (input) => {
      starts.push(input);
      return childHandle();
    },
    reportStatus: async () => {},
    ensureDirectory: async () => {},
    sleep: async () => {},
  });

  await supervisor.reconcile();
  assert.deepEqual(starts.map((entry) => entry.spaceId), [SPACE_B]);
  await supervisor.stop();
});

test("runner exit is visible and a later reconciliation restarts it once", async () => {
  const children = [];
  const reports = [];
  const supervisor = new ManagedSandboxSupervisor({
    storageRoot: "/data/spaces",
    listSpaces: async () => [
      { spaceId: SPACE_A, status: "stopped", reportedAt: null },
    ],
    startRunner: async () => {
      const child = childHandle();
      children.push(child);
      return child;
    },
    reportStatus: async (input) => reports.push(input),
    ensureDirectory: async () => {},
    sleep: async () => {},
    retryDelayMs: 0,
  });

  await supervisor.reconcile();
  children[0].exit(17);
  await supervisor.reconcile();

  assert.equal(children.length, 2);
  assert.ok(
    reports.some(
      (entry) =>
        entry.status === "error" && entry.message.includes("code 17"),
    ),
  );
  await supervisor.stop();
});

test("runner startup failure stays explicit until its bounded retry", async () => {
  const reports = [];
  const starts = [];
  let now = 10_000;
  const supervisor = new ManagedSandboxSupervisor({
    storageRoot: "/data/spaces",
    listSpaces: async () => [
      { spaceId: SPACE_A, status: "error", reportedAt: now },
    ],
    startRunner: async () => {
      starts.push(now);
      throw new Error("spawn grok: executable not found");
    },
    reportStatus: async (input) => reports.push(input),
    ensureDirectory: async () => {},
    now: () => now,
    retryDelayMs: 5_000,
  });

  await supervisor.reconcile();
  await supervisor.reconcile();
  assert.equal(starts.length, 1);
  assert.deepEqual(reports.at(-1), {
    spaceId: SPACE_A,
    status: "error",
    message: "local sandbox runner failed to start: spawn grok: executable not found",
  });

  now += 5_000;
  await supervisor.reconcile();
  assert.equal(starts.length, 2);
  await supervisor.stop();
});

test("a managed runner replaced by a fresh manual runner is relinquished without restart", async () => {
  const child = childHandle();
  const reports = [];
  let manualReady = false;
  const supervisor = new ManagedSandboxSupervisor({
    storageRoot: "/data/spaces",
    startedAt: 10_000,
    listSpaces: async () => [
      {
        spaceId: SPACE_A,
        status: manualReady ? "ready" : "stopped",
        reportedAt: manualReady ? 10_001 : null,
      },
    ],
    startRunner: async () => child,
    reportStatus: async (input) => reports.push(input),
    ensureDirectory: async () => {},
    sleep: async () => {},
  });

  await supervisor.reconcile();
  manualReady = true;
  child.exit(0, { relinquished: true });
  await supervisor.reconcile();

  assert.equal(
    reports.filter((entry) => entry.status === "provisioning").length,
    1,
  );
  assert.equal(reports.some((entry) => entry.status === "error"), false);
  await supervisor.stop();
});

test("workspace paths reject malformed ids instead of escaping the storage root", () => {
  assert.equal(
    managedWorkspacePath("/data/spaces", SPACE_A),
    `/data/spaces/${SPACE_A}/workspace`,
  );
  assert.throws(
    () => managedWorkspacePath("/data/spaces", "../../outside"),
    /invalid local Space id/,
  );
});
