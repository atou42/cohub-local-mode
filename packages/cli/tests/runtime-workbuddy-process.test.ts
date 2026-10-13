import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { WorkBuddyProcess, resolveWorkBuddyLaunch, workbuddySessionFile } from "../src/runtime/workbuddy-process.js";
const fixture = fileURLToPath(new URL("./fixtures/runtime-workbuddy.mjs", import.meta.url));
async function processFor(mode = "") {
  const launch = await resolveWorkBuddyLaunch(process.cwd(), fixture, join(tmpdir(), "workbuddy-fixture-home"));
  return new WorkBuddyProcess(launch, process.cwd(), { sessionId: "session-1", context: { WORKBUDDY_FIXTURE_MODE: mode } });
}
test("WorkBuddy initializes a sanitized native model catalog and executes one turn", async () => {
  const rpc = await processFor();
  try {
    assert.deepEqual(await rpc.initialize(), { models: [{ id: "model-1", name: "Model One", description: "A model" }], currentModelId: "model-1" });
    const events: Record<string, unknown>[] = [];
    const result = new Promise<void>((resolve) => rpc.onEvent((event) => { events.push(event); if (event.type === "result") resolve(); }));
    rpc.prompt({ type: "user", message: { role: "user", content: [{ type: "text", text: "fixture" }] } });
    await result;
    assert.equal(events[0]?.uuid, "native-user-id");
    assert.equal(events[1]?.result, "done");
    assert.throws(() => rpc.prompt({ type: "user", message: { content: "second" } }), /one turn/i);
  } finally { await rpc.close(); }
});
test("WorkBuddy denies requested permission using the native allowed field and exact request ID", async () => {
  const rpc = await processFor("permission");
  try {
    await rpc.initialize();
    const result = new Promise<Record<string, unknown>>((resolve) => rpc.onEvent((event) => {
      if (event.type === "control_request") rpc.denyPermission(String(event.request_id), "Not approved");
      if (event.type === "result") resolve(event);
    }));
    rpc.prompt({ type: "user", message: { role: "user", content: "fixture" } });
    assert.equal((await result).is_error, true);
  } finally { await rpc.close(); }
});
test("WorkBuddy rejects corrupt catalogs instead of inventing a model", async () => {
  const rpc = await processFor("bad-catalog");
  try { await assert.rejects(rpc.initialize(), /catalog/i); } finally { await rpc.close(); }
});
test("WorkBuddy rejects malformed output and timed out control requests", async () => {
  for (const mode of ["malformed", "timeout"]) {
    const rpc = await processFor(mode);
    try { await assert.rejects(rpc.initialize(mode === "timeout" ? 100 : 2000), mode === "timeout" ? /timed out/i : /JSON|Unexpected|Expected/i); } finally { await rpc.close(); }
  }
});
test("WorkBuddy reports exit before a result without exposing stderr", async () => {
  const rpc = await processFor("exit");
  try {
    await rpc.initialize();
    const failed = new Promise<Error>((resolve) => rpc.onFailure(resolve));
    rpc.prompt({ type: "user", message: { role: "user", content: "fixture" } });
    const error = await failed;
    assert.match(error.message, /exited.*7/i);
    assert.doesNotMatch(error.message, /private-secret/);
  } finally { await rpc.close(); }
});
test("WorkBuddy session paths match the native path compressor and reject invalid IDs", () => {
  const id = "d2974300-0488-4233-a801-dd906b81b59f";
  assert.equal(workbuddySessionFile("/wb", "/Users/a//project/", id), `/wb/projects/Users-a-project/${id}.jsonl`);
  assert.throws(() => workbuddySessionFile("/wb", "/cwd", "../bad"), /session location/i);
});

test("WorkBuddy launch enables partial events without bypassing permissions", async () => {
  const rpc = await processFor("launch-contract");
  try { assert.equal((await rpc.initialize()).models[0]?.id, "model-1"); } finally { await rpc.close(); }
});

test("WorkBuddy rejects a top-level CLI error without waiting for process exit", async () => {
  const rpc = await processFor("top-level-error");
  try {
    await rpc.initialize();
    const failure = new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No failure delivered")), 2000);
      rpc.onFailure((error) => { clearTimeout(timer); resolve(error); });
    });
    rpc.prompt({ type: "user", message: { role: "user", content: "fixture" } });
    assert.match((await failure).message, /Authentication required/);
  } finally { await rpc.close(); }
});

test("WorkBuddy honors its saved direct mode before the child captures inherited proxies", async () => {
  const home = await mkdtemp(join(tmpdir(), "workbuddy-direct-"));
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY", "NODE_USE_ENV_PROXY"];
  try {
    await writeFile(join(home, "settings.json"), JSON.stringify({ "http.proxySupport": "off", "http.proxy": "", unrelated: true }));
    const launch = await resolveWorkBuddyLaunch(process.cwd(), fixture, home);
    const context = { ...Object.fromEntries(proxyKeys.map((key) => [key, key === "NODE_USE_ENV_PROXY" ? "1" : "http://127.0.0.1:1"])), WORKBUDDY_FIXTURE_MODE: "network-environment" };
    const rpc = new WorkBuddyProcess(launch, process.cwd(), { context });
    try {
      await rpc.initialize();
      const done = new Promise<Record<string, unknown>>((resolve) => rpc.onEvent((event) => { if (event.type === "result") resolve(event); }));
      rpc.prompt({ type: "user", message: { role: "user", content: "fixture" } });
      const env = (await done).environment as Record<string, string>;
      for (const key of proxyKeys) assert.equal(env[key], undefined, `${key} leaked into direct WorkBuddy`);
      assert.equal(env.NO_PROXY, "*");
      assert.equal(env.no_proxy, "*");
      assert.equal(context.HTTP_PROXY, "http://127.0.0.1:1");
    } finally { await rpc.close(); }
    await writeFile(join(home, "settings.json"), JSON.stringify({ "http.proxySupport": ["off"] }));
    await assert.rejects(resolveWorkBuddyLaunch(process.cwd(), fixture, home), /Invalid WorkBuddy proxy support setting/);
    await writeFile(join(home, "settings.json"), '{"http.proxySupport":');
    await assert.rejects(resolveWorkBuddyLaunch(process.cwd(), fixture, home), /JSON|Unexpected|Expected/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});
