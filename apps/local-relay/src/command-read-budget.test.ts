import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import type { RelayCommand } from "./protocol.ts";

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve("wrangler/package.json"))(
  "esbuild",
);
const bundle = buildSync({
  stdin: {
    contents: readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
    loader: "ts",
    resolveDir: import.meta.dirname,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  write: false,
  external: ["cloudflare:workers"],
}).outputFiles[0].text;
const module = { exports: {} as Record<string, any> };
new Function("require", "module", "exports", bundle)(
  (id: string) => {
    if (id === "cloudflare:workers")
      return {
        DurableObject: class {
          ctx: any;
          env: any;
          constructor(ctx: any, env: any) {
            this.ctx = ctx;
            this.env = env;
          }
        },
      };
    return require(id);
  },
  module,
  module.exports,
);

class Storage {
  records = new Map<string, unknown>();
  reads: { key: string; count: number }[] = [];
  failIndexWrite = false;
  async get(key: string) {
    const value = this.records.get(key);
    this.reads.push({ key, count: value === undefined ? 0 : 1 });
    return structuredClone(value);
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    for (const [name, entry] of typeof key === "string"
      ? [[key, value] as const]
      : Object.entries(key)) {
      if (
        this.failIndexWrite &&
        /^command-(pending|active|terminal):/.test(name)
      )
        throw new Error("injected index write failure");
      this.records.set(name, structuredClone(entry));
    }
  }
  async delete(keys: string | string[]) {
    for (const key of typeof keys === "string" ? [keys] : keys)
      this.records.delete(key);
  }
  async list({ prefix, limit }: { prefix: string; limit?: number }) {
    const values = [...this.records]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit);
    this.reads.push({ key: prefix, count: values.length });
    return new Map(values.map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(fn: (storage: Storage) => Promise<unknown>) {
    const tx = new Storage();
    tx.records = structuredClone(this.records);
    tx.reads = this.reads;
    tx.failIndexWrite = this.failIndexWrite;
    const result = await fn(tx);
    this.records = tx.records;
    return result;
  }
  async setAlarm() {}
  async getAlarm() {
    return null;
  }
}

function harness() {
  const storage = new Storage();
  const ctx = { storage, getWebSockets: () => [], waitUntil: () => {} };
  const relay = new module.exports.LocalNodeRelay(ctx, {
    NODE_ID: "test-node",
    COMMAND_LEASE_MS: "60000",
    COMMAND_MAX_BODY_BYTES: "1048576",
    COMMAND_WAKEUPS: { send: async () => {} },
  });
  for (const name of [
    "dispatchNext",
    "ensurePeriodicAlarm",
    "scheduleNextAlarm",
    "gcTurnEvents",
    "gcActivityOutboxes",
    "gcExpiredActivityRegistrations",
    "gcExpiredActivityPreferences",
    "gcExpiredAttachments",
  ])
    relay[name] = async () => {};
  return { relay, storage };
}

function seed(h: ReturnType<typeof harness>, count = 200) {
  const now = new Date().toISOString();
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    const key = `command:${String(sequence).padStart(20, "0")}:${id}`;
    const command: RelayCommand = {
      id,
      nodeId: "test-node",
      sequence,
      idempotencyKey: id,
      attachments: [],
      status: "succeeded",
      attempt: 1,
      acceptedAt: now,
      updatedAt: now,
      claimedAt: now,
      startedAt: now,
      completedAt: now,
      leaseExpiresAt: null,
      request: { method: "GET", path: "/api/spaces", headers: {}, body: "" },
      result: { status: 200, headers: {}, body: "original-content" },
      errorCode: null,
      errorMessage: null,
    };
    h.storage.records.set(key, command);
    h.storage.records.set(`command-id:${id}`, key);
    h.storage.records.set(`idempotency:${id}`, key);
  }
  h.storage.records.set("meta:next-sequence", count + 1);
  h.storage.records.set("meta:node-id", "test-node");
}

test("production status reads stay bounded after indexing and reactivation", async () => {
  const h = harness();
  seed(h);
  const original = structuredClone(h.storage.records);
  await h.relay.getStatus();
  for (let iteration = 0; iteration < 2; iteration += 1) {
    if (iteration === 1)
      h.relay = new module.exports.LocalNodeRelay(h.relay.ctx, h.relay.env);
    h.storage.reads.length = 0;
    const status = await (await h.relay.getStatus()).json();
    assert.equal(status.activeCommandId, null);
    const readCount = h.storage.reads.reduce(
      (sum, read) => sum + read.count,
      0,
    );
    assert.ok(readCount <= 4, `status read ${readCount} retained records`);
    assert.equal(
      h.storage.reads.some(({ key }) => key === "command:"),
      false,
    );
  }
  for (const [key, value] of original)
    assert.deepEqual(h.storage.records.get(key), value);
});

test("active command transitions do not scan completed history", async () => {
  const h = harness();
  seed(h);
  await h.relay.getStatus();
  const id = "00000000-0000-4000-8000-000000000200";
  const command = await h.relay.getCommandById(id);
  await h.relay.putCommand({
    ...command,
    status: "running",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    completedAt: null,
  });
  h.storage.reads.length = 0;
  const status = await (await h.relay.getStatus()).json();
  assert.equal(status.activeCommandId, id);
  assert.ok(h.storage.reads.reduce((sum, read) => sum + read.count, 0) <= 4);
  await h.relay.putCommand(command);
  assert.equal(
    (await (await h.relay.getStatus()).json()).activeCommandId,
    null,
  );
});

test("failed index updates roll back the original command and derived records", async () => {
  const h = harness();
  seed(h);
  await h.relay.getStatus();
  const command = await h.relay.getCommandById(
    "00000000-0000-4000-8000-000000000001",
  );
  const original = structuredClone(h.storage.records);
  h.storage.failIndexWrite = true;
  await assert.rejects(
    h.relay.putCommand({ ...command, status: "queued", completedAt: null }),
    /injected index write failure/,
  );
  assert.deepEqual(h.storage.records, original);
});

test("invalid index markers fail closed without rebuilding history", async () => {
  const h = harness();
  seed(h);
  h.storage.records.set("meta:command-index-version", "broken");
  const original = structuredClone(h.storage.records);
  await assert.rejects(h.relay.getStatus(), /index version is invalid/);
  assert.deepEqual(h.storage.records, original);
});

test("lease scheduling and completion cleanup never scan completed history", async () => {
  const h = harness();
  seed(h);
  await h.relay.getStatus();
  h.storage.reads.length = 0;
  await h.relay.requeueExpired();
  await module.exports.LocalNodeRelay.prototype.dispatchNext.call(h.relay);
  await module.exports.LocalNodeRelay.prototype.scheduleNextAlarm.call(h.relay);
  await h.relay.collectGarbage(Date.now(), false);
  assert.equal(
    h.storage.reads.some(({ key }) => key === "command:"),
    false,
  );
  assert.ok(h.storage.reads.reduce((sum, read) => sum + read.count, 0) <= 4);
});

test("failed initial indexing leaves legacy records unchanged", async () => {
  const h = harness();
  seed(h);
  const original = structuredClone(h.storage.records);
  h.storage.failIndexWrite = true;
  await assert.rejects(h.relay.getStatus(), /injected index write failure/);
  assert.deepEqual(h.storage.records, original);
  h.storage.failIndexWrite = false;
  assert.equal((await h.relay.getStatus()).status, 200);
});
