import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { JsonRpcProcess } from "../src/runtime/json-rpc.js";
import { stopProcessGroup, ProcessCleanupUncertainError } from "../src/runtime/process-group.js";

test("macOS cleanup waits through a zombie EPERM probe until ESRCH", { skip: process.platform !== "darwin" }, async (t) => {
  const signals: Array<number | string> = [];
  t.mock.method(process, "kill", (_pid: number, signal: number | string) => {
    signals.push(signal);
    if (signal === 0) {
      throw Object.assign(new Error("probe"), { code: signals.filter((s) => s === 0).length === 1 ? "EPERM" : "ESRCH" });
    }
    return true;
  });
  await stopProcessGroup(123456);
  assert.deepEqual(signals, ["SIGTERM", 0, 0]);
});

test("macOS cleanup does not turn persistent permission denial into success", { skip: process.platform !== "darwin", timeout: 10_000 }, async (t) => {
  t.mock.method(process, "kill", (_pid: number, signal: number | string) => {
    if (signal !== "SIGTERM") throw Object.assign(new Error("denied"), { code: "EPERM" });
    return true;
  });
  await assert.rejects(stopProcessGroup(123456), ProcessCleanupUncertainError);
});

test("macOS cleanup confirms termination of real detached children", { skip: process.platform !== "darwin", timeout: 10_000 }, async () => {
  for (let i = 0; i < 3; i++) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const closed = once(child, "close");
    await once(child, "spawn");
    assert(child.pid);
    await stopProcessGroup(child.pid);
    await closed;
    assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
  }
});

test("RPC close waits for a SIGTERM-resistant descendant with detached pipes", { skip: !["linux", "darwin"].includes(process.platform), timeout: 10_000 }, async () => {
  const rpc = new JsonRpcProcess(process.execPath, [fileURLToPath(new URL("./fixtures/runtime-process-tree.mjs", import.meta.url))], process.cwd(), "codex");
  let pids: number[] = [];
  try {
    const response = await rpc.request("pid"); pids = [Number(response.branch), Number(response.leaf)];
    assert(pids.every((pid) => Number.isInteger(pid) && pid > 0));
    const started = Date.now();
    await rpc.close();
    assert(Date.now() - started >= 1900, "leader exit must not cancel group escalation");
    for (const pid of pids) {
      if (process.platform === "darwin") {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } else {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
        assert(stat === null || ["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? ""), `descendant ${pid} cannot execute after close returns`);
      }
    }
    await rpc.close();
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    await rpc.close();
  }
});
