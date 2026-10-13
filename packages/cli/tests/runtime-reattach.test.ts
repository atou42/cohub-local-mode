import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Command } from "commander";
import type { RuntimeSummary } from "../src/runtime/presentation.js";

for (const failure of ["reload error", "stopped"] as const) {
  test(`reattaching does not report the old ready state after ${failure}`, async (t) => {
    const root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "cohub-reattach-")));
    const previous = { HOME: process.env.HOME, COHUB_EXECUTION_TOKEN: process.env.COHUB_EXECUTION_TOKEN };
    process.env.HOME = root;
    process.env.COHUB_EXECUTION_TOKEN = `fixture.${Buffer.from(JSON.stringify({ sub: "reattach-test" })).toString("base64url")}.fixture`;
    const { runtimeUp } = await import("../src/runtime/launch.js");
    const { currentIdentityKey } = await import("../src/space.js");
    const { ownRuntimeInstance, runtimeInstanceDirectory } = await import("../src/runtime/instance.js");
    const { runtimeStateRoot, writeNativeConfig } = await import("../src/runtime/native/config.js");
    const spaceId = "11111111-1111-4111-8111-111111111111";
    const identity = currentIdentityKey();
    assert.ok(identity);
    const directory = runtimeInstanceDirectory(identity, spaceId);
    const summary: RuntimeSummary = { spaceId, runtimeId: "fixture-runtime", root, harnesses: ["workbuddy"], pid: process.pid, state: "ready", harnessConnected: true, workspaceConnected: true, diagnosticsPath: join(root, "diagnostics"), background: true };
    const actions: string[] = [];
    const close = await ownRuntimeInstance(directory, () => {
      // The process disappears after answering status but before reload reaches it.
      if (failure === "stopped") unlinkSync(join(directory, "owner.json"));
      return summary;
    }, async () => {}, async (action) => { actions.push(action); throw new Error("Native reload failed: damaged sync configuration"); });
    try {
      await writeNativeConfig(runtimeStateRoot(spaceId), { version: 2, identity, spaceId, root, harnesses: ["workbuddy"], enabledAt: "2025-01-01T00:00:00.000Z", codexShared: false });
      t.mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden in this fixture"); });
      const output: string[] = [];
      const stdout = t.mock.method(process.stdout, "write", (chunk) => { output.push(String(chunk)); return true; });
      try {
        await assert.rejects(runtimeUp(new Command(), root, { space: spaceId, harness: ["workbuddy"], yes: true, json: true }), failure === "stopped" ? /Runtime stopped before native sync could reload/ : /Native reload failed: damaged sync configuration/);
      } finally { stdout.mock.restore(); }
      assert.deepEqual(actions, failure === "stopped" ? [] : ["reload"]);
      assert.deepEqual(output, []);
    } finally {
      await close();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
}
