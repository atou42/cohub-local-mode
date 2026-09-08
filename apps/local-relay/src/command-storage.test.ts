import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { RELAY_PROTOCOL_VERSION } from "./protocol.ts";
import { storeCommandWithBodies } from "./command-bodies.ts";

const require = createRequire(import.meta.url);
// Exercise the Worker class with Wrangler's installed compiler and a bounded
// in-memory storage adapter, without adding a second build dependency.
const { buildSync } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const source = process.env.COHUB_RELAY_TEST_BASELINE === "HEAD"
	? execFileSync("git", ["show", "HEAD:apps/local-relay/src/index.ts"], { encoding: "utf8" })
	: readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const bundle = buildSync({
	stdin: { contents: source, loader: "ts", resolveDir: import.meta.dirname },
	bundle: true, platform: "node", format: "cjs", target: "node24", write: false,
	external: ["cloudflare:workers"],
}).outputFiles[0].text;
const module = { exports: {} as Record<string, any> };
new Function("require", "module", "exports", bundle)((id: string) => {
	if (id === "cloudflare:workers") return { DurableObject: class {
		ctx: any; env: any;
		constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
	} };
	return require(id);
}, module, module.exports);

class Storage {
	records = new Map<string, unknown>();
	reads: { key: string; count: number }[] = [];
	failReceiptWrite = false;
	failIndexWrite = false;
	async get(key: string) {
		const value = this.records.get(key);
		this.reads.push({ key, count: value === undefined ? 0 : 1 });
		return structuredClone(value);
	}
	async put(key: string | Record<string, unknown>, value?: unknown) {
		const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
		for (const [name, entry] of entries) {
			if (Buffer.byteLength(JSON.stringify(entry)) > 128 * 1024) throw new Error("Durable Object value exceeds 128 KiB");
			if (this.failReceiptWrite && name.startsWith("operation-receipt:")) throw new Error("injected durable write failure");
			if (this.failIndexWrite && name.startsWith("command-terminal:")) throw new Error("injected index write failure");
			this.records.set(name, structuredClone(entry));
		}
	}
	async delete(keys: string | string[]) { for (const key of typeof keys === "string" ? [keys] : keys) this.records.delete(key); }
	async list({ prefix, limit }: { prefix: string; limit?: number }) {
		const values = [...this.records].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit);
		this.reads.push({ key: prefix, count: values.length });
		return new Map(values.map(([key, value]) => [key, structuredClone(value)]));
	}
	async transaction(fn: (storage: Storage) => Promise<unknown>) {
		const tx = new Storage();
		tx.records = structuredClone(this.records);
		tx.reads = this.reads;
		tx.failReceiptWrite = this.failReceiptWrite;
		tx.failIndexWrite = this.failIndexWrite;
		const result = await fn(tx);
		this.records = tx.records;
		return result;
	}
	async setAlarm() {}
	async getAlarm() { return null; }
}

function harness() {
	const storage = new Storage();
	const ctx = { storage, getWebSockets: () => [], getTags: () => ["node"], waitUntil: () => {} };
	const relay = new module.exports.LocalNodeRelay(ctx, { NODE_ID: "test-node", COMMAND_LEASE_MS: "1000", COMMAND_MAX_BODY_BYTES: "1048576", COMMAND_WAKEUPS: { send: async () => {} } });
	for (const name of ["dispatchNext", "ensurePeriodicAlarm", "scheduleNextAlarm", "gcTurnEvents", "gcActivityOutboxes", "gcExpiredActivityRegistrations", "gcExpiredActivityPreferences", "gcExpiredAttachments"]) relay[name] = async () => {};
	return { relay, storage };
}

const input = {
	kind: "alpha_api", idempotencyKey: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02",
	request: { method: "POST", path: "/api/spaces", headers: {}, body: '{"name":"original"}' },
};
const request = (body = input) => new Request("https://relay.internal/internal/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seedCompleted(h: ReturnType<typeof harness>) {
	const response = await h.relay.createCommand(request());
	assert.equal(response.status, 202);
	const { command } = await response.json();
	const completed = { ...command, status: "succeeded", completedAt: "2026-08-01T00:00:00Z", result: { status: 201, headers: {}, body: '{"id":"space-1"}' } };
	await h.relay.putCommand(completed);
	return completed;
}

test("collecting response bodies retains operation identity and an explicit expired result", async () => {
	const h = harness();
	const command = await seedCompleted(h);
	const admitted = await h.relay.fetch(new Request(`https://relay.internal/internal/operations/${input.idempotencyKey}`));
	assert.equal(admitted.status, 200);
	assert.equal((await admitted.json()).command.id, command.id);
	await h.relay.collectGarbage(Date.parse("2026-09-06T00:00:00Z"));
	const operation = await h.relay.fetch(new Request(`https://relay.internal/internal/operations/${input.idempotencyKey}`));
	assert.equal(operation.status, 410);
	assert.equal((await operation.json()).commandId, command.id);
	const retry = await h.relay.createCommand(request());
	assert.equal(retry.status, 410);
	assert.equal((await retry.json()).commandId, command.id);
	assert.equal((await h.relay.listCommandMetadata()).length, 0);
	const lookup = await h.relay.fetch(new Request(`https://relay.internal/internal/commands/${command.id}`));
	assert.equal(lookup.status, 410);
	assert.equal((await lookup.json()).code, "command_result_expired");
	await assert.rejects(h.relay.createCommand(request({ ...input, request: { ...input.request, body: '{"name":"different"}' } })), /different command/);
	const frames: any[] = [];
	await h.relay.webSocketMessage({ send: (value: string) => frames.push(JSON.parse(value)) }, JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, type: "result", commandId: command.id, attempt: 1, result: command.result }));
	assert.equal(frames[0]?.type, "ack");
	assert.equal(frames[0]?.status, "succeeded");
});

test("a receipt persistence failure leaves the original command and deduplication index intact", async () => {
	const h = harness();
	const command = await seedCompleted(h);
	h.storage.failReceiptWrite = true;
	await assert.rejects(h.relay.collectGarbage(Date.parse("2026-09-06T00:00:00Z")), /durable write failure/);
	assert.equal((await h.relay.getCommandById(command.id)).result.body, command.result.body);
	const retried = await h.relay.createCommand(request());
	assert.equal(retried.status, 202);
	assert.equal((await retried.json()).command.id, command.id);
});

test("escaped and multibyte command bodies fit durable values and corrupt chunks do not become empty content", async () => {
	const h = harness();
	const body = "\u0000汉".repeat(150_000);
	const response = await h.relay.createCommand(request({ ...input, request: { ...input.request, body } }));
	assert.equal(response.status, 202);
	const { command } = await response.json();
	assert.equal((await h.relay.getCommandById(command.id)).request.body, body);
	const key = [...h.storage.records.keys()].find((key) => key.startsWith(`command-body:${command.id}:request:`));
	assert.ok(key);
	h.storage.records.delete(key);
	await assert.rejects(h.relay.getCommandById(command.id), /missing or corrupt/);
});

test("HTTP body references must belong to this node and match a ready stored attachment", async () => {
	const h = harness();
	const part = { id: input.idempotencyKey, size: 4, sha256: "b".repeat(64) };
	const req = { ...input, request: { ...input.request, body: "", bodyParts: [part] } };
	await assert.rejects(h.relay.createCommand(request(req)), /missing, belongs to another node/);
	h.storage.records.set(`attachment:${part.id}`, { ...part, nodeId: "test-node", state: "ready", contentType: "application/octet-stream", expiresAt: "2099-01-01T00:00:00Z" });
	assert.equal((await h.relay.createCommand(request(req))).status, 202);
	h.storage.records.set(`attachment:${part.id}`, { ...part, state: "pending", contentType: "application/octet-stream", expiresAt: "2099-01-01T00:00:00Z" });
	await assert.rejects(h.relay.createCommand(request(req)), /identity/);
});

async function seedHistory(h: ReturnType<typeof harness>, count: number, chunks = 1) {
	const now = new Date().toISOString();
	for (let sequence = 1; sequence <= count; sequence++) {
		const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
		const key = `command:${String(sequence).padStart(20, "0")}:${id}`;
		await storeCommandWithBodies(h.storage as any, key, {
			id, nodeId: "test-node", sequence, idempotencyKey: id, attachments: [],
			status: "succeeded", attempt: 1, acceptedAt: now, updatedAt: now,
			claimedAt: now, startedAt: now, completedAt: now, leaseExpiresAt: null,
			request: { method: "GET", path: "/api/spaces", headers: {}, body: "" },
			result: { status: 200, headers: {}, body: "x".repeat(chunks * 16 * 1024) },
			errorCode: null, errorMessage: null,
		});
		await h.storage.put({ [`command-id:${id}`]: key, [`idempotency:${id}`]: key });
	}
	await h.storage.put("meta:next-sequence", count + 1);
}

test("status never reads historical bodies and warm or reactivated reads are independent of retained history", async () => {
	for (const [count, chunks] of [[0, 0], [10, 1], [200, 8]] as const) {
		const h = harness();
		await seedHistory(h, count, chunks);
		h.storage.reads.length = 0;
		assert.equal((await h.relay.getStatus()).status, 200);
		assert.equal(h.storage.reads.filter(({ key }) => key.startsWith("command-body:")).length, 0, "one-time legacy indexing must not hydrate bodies");
		for (let iteration = 0; iteration < 2; iteration++) {
			if (iteration === 1) h.relay = new module.exports.LocalNodeRelay(h.relay.ctx, h.relay.env);
			h.storage.reads.length = 0;
			const status = await (await h.relay.getStatus()).json();
			assert.equal(status.activeCommandId, null);
			assert.equal(h.storage.reads.filter(({ key }) => key === "command:").length, 0);
			assert.equal(h.storage.reads.filter(({ key }) => key.startsWith("command-body:")).length, 0);
			assert.ok(h.storage.reads.reduce((sum, read) => sum + read.count, 0) <= 4);
		}
	}
});

test("a corrupt completed body cannot break status or read-only command scheduling", async () => {
	const h = harness();
	await seedHistory(h, 10);
	h.storage.records.delete("command-body:00000000-0000-4000-8000-000000000001:result:0");
	assert.equal((await h.relay.getStatus()).status, 200);
	await h.relay.requeueExpired();
	await module.exports.LocalNodeRelay.prototype.scheduleNextAlarm.call(h.relay);
	await h.relay.collectGarbage();
	await assert.rejects(h.relay.getCommandById("00000000-0000-4000-8000-000000000001"), /missing or corrupt/);
});

test("active command indexes track lease and terminal transitions without reading unrelated history", async () => {
	const h = harness();
	await seedHistory(h, 200, 8);
	await h.relay.getStatus();
	const { command } = await (await h.relay.createCommand(request())).json();
	await h.relay.putCommand({ ...command, status: "claimed", attempt: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	h.storage.reads.length = 0;
	const active = await (await h.relay.getStatus()).json();
	assert.equal(active.activeCommandId, command.id);
	assert.equal(active.activeCommandStatus, "claimed");
	assert.ok(h.storage.reads.reduce((sum, read) => sum + read.count, 0) <= 4);
	await h.relay.putCommand({ ...command, status: "succeeded", completedAt: new Date().toISOString(), result: { status: 200, headers: {}, body: "done" } });
	assert.equal((await (await h.relay.getStatus()).json()).activeCommandId, null);
});

test("Alpha activity reconciliation is a no-op only when no owner feature or stored activity exists", async () => {
	const h = harness();
	assert.equal(await h.relay.reconcileActivityWatch(), null);
	await h.storage.put("meta:activity-watch-snapshot", { revision: 1 });
	await assert.rejects(h.relay.reconcileActivityWatch(), /owner|activity/i);
});

test("legacy indexing is atomic, preserves every original row, and refuses a damaged marker", async () => {
	const h = harness();
	await seedHistory(h, 10);
	const original = structuredClone(h.storage.records);
	h.storage.failIndexWrite = true;
	await assert.rejects(h.relay.ensureCommandIndexes(), /index write failure/);
	assert.deepEqual(h.storage.records, original);
	h.storage.failIndexWrite = false;
	await h.relay.ensureCommandIndexes();
	for (const [key, value] of original) assert.deepEqual(h.storage.records.get(key), value, key);
	assert.equal(h.storage.records.get("meta:command-terminal-count"), 10);
	const bad = harness();
	await bad.storage.put("meta:command-index-version", "damaged");
	await assert.rejects(bad.relay.ensureCommandIndexes(), /version is invalid/);
	assert.equal(bad.storage.records.get("meta:command-index-version"), "damaged");
	const incomplete = harness();
	await incomplete.storage.put("meta:command-terminal-count", 0);
	await assert.rejects(incomplete.relay.ensureCommandIndexes(), /incomplete/);
});

test("completion cleanup reads only excess terminal commands and preserves the 200-command retention limit", async () => {
	const h = harness();
	await seedHistory(h, 200, 8);
	await h.relay.ensureCommandIndexes();
	h.storage.reads.length = 0;
	await h.relay.collectGarbage(Date.now(), false);
	assert.deepEqual(h.storage.reads, [{ key: "meta:command-terminal-count", count: 1 }]);
	const { command } = await (await h.relay.createCommand(request())).json();
	const completed = { ...command, status: "succeeded", completedAt: new Date().toISOString(), result: { status: 201, headers: {}, body: "new result" } };
	await h.relay.putCommand(completed);
	await h.relay.putCommand(completed);
	assert.equal(h.storage.records.get("meta:command-terminal-count"), 201);
	h.storage.reads.length = 0;
	await h.relay.collectGarbage(Date.now(), false);
	assert.equal(h.storage.reads.some(read => read.key === "command:"), false);
	assert.equal(h.storage.reads.filter(read => read.key.startsWith("command-body:")).length, 8);
	assert.equal(h.storage.records.get("meta:command-terminal-count"), 200);
	assert.equal((await h.relay.getCommandById(completed.id)).result.body, "new result");
	assert.equal((await h.relay.getCommandReceipt("00000000-0000-4000-8000-000000000001")).status, "succeeded");
});

test("lease renewals and expiry update metadata without loading bodies and retain dispatch content", async () => {
	const h = harness();
	await seedHistory(h, 200, 8);
	const body = "request content".repeat(4_000);
	const { command } = await (await h.relay.createCommand(request({ ...input, request: { ...input.request, body } }))).json();
	await h.relay.putCommand({ ...command, status: "running", attempt: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	h.storage.reads.length = 0;
	await h.relay.extendLease(command.id, 1);
	assert.equal(h.storage.reads.some(read => read.key.startsWith("command-body:") || read.key === "command:"), false);
	await h.relay.requeueExpired(Date.now() + 120_000);
	assert.equal(h.storage.reads.some(read => read.key.startsWith("command-body:") || read.key === "command:"), false);
	assert.equal((await h.relay.getCommandById(command.id)).request.body, body);
	assert.equal((await h.relay.getCommandById(command.id)).status, "queued");
	const frames: any[] = [];
	h.relay.ctx.getWebSockets = (tag: string) => tag === "node" ? [{ send: (value: string) => frames.push(JSON.parse(value)) }] : [];
	await module.exports.LocalNodeRelay.prototype.dispatchNext.call(h.relay);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].command.request.body, body);
	await h.relay.extendLease("already-collected-command", 1);
});

test("a damaged active index is an error rather than a false idle state", async () => {
	const h = harness();
	const { command } = await (await h.relay.createCommand(request())).json();
	await h.relay.putCommand({ ...command, status: "claimed", attempt: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
	const key = h.storage.records.get(`command-id:${command.id}`) as string;
	h.storage.records.delete(key);
	await assert.rejects(h.relay.getStatus(), /index is inconsistent/);
});
