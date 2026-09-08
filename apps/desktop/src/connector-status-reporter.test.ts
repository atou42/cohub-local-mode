import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorStatusReporter } from "./connector-status-reporter.ts";

test("unchanged IPC and timer statuses share one heartbeat instead of two streams", async () => {
	let now = 1_000;
	let calls = 0;
	const reporter = createConnectorStatusReporter({ now: () => now, onError: error => { throw error; } });
	const report = { scope: "account-device", body: "connected", send: async () => { calls++; return new Response(); } };
	await Promise.all(Array.from({ length: 20 }, () => reporter.publish(report)));
	assert.equal(calls, 1);
	now += 15_000;
	await reporter.publish(report);
	assert.equal(calls, 1);
	now += 15_000;
	await Promise.all([reporter.publish(report), reporter.publish(report)]);
	assert.equal(calls, 2);
});

test("a burst during a slow report sends only the newest remaining state", async () => {
	let finish!: (response: Response) => void;
	const first = new Promise<Response>(resolve => { finish = resolve; });
	const sent: string[] = [];
	const reporter = createConnectorStatusReporter({ onError: error => { throw error; } });
	const publish = (body: string) => reporter.publish({ scope: "account-device", body, send: async () => { sent.push(body); return body === "connecting" ? first : new Response(); } });
	const pending = publish("connecting");
	for (let attempt = 0; attempt < 50; attempt++) void publish(`recovering-${attempt}`);
	void publish("connected");
	finish(new Response());
	await pending;
	assert.deepEqual(sent, ["connecting", "connected"]);
});

test("a stopped status arriving while a duplicate is being skipped is still flushed before quit", async () => {
	const sent: string[] = [];
	const reporter = createConnectorStatusReporter({ onError: error => { throw error; } });
	const publish = (body: string) => reporter.publish({ scope: "account-device", body, send: async () => { sent.push(body); return new Response(); } });
	await publish("connected");
	void publish("connected");
	void publish("stopped");
	await reporter.flush();
	assert.deepEqual(sent, ["connected", "stopped"]);
});

test("maintenance suppresses every state change until Retry-After and later sends the latest state", async () => {
	let now = 1_000;
	let restored = false;
	const sent: string[] = [];
	const errors: unknown[] = [];
	const reporter = createConnectorStatusReporter({ now: () => now, onError: error => errors.push(error) });
	const publish = (body: string) => reporter.publish({ scope: "account-device", body, send: async () => {
		 sent.push(body);
		 return restored ? new Response() : new Response("Maintenance", { status: 503, headers: { "retry-after": "120" } });
	} });
	await publish("connecting");
	for (let attempt = 0; attempt < 100; attempt++) await publish(`reconnecting-${attempt}`);
	assert.equal(sent.length, 1);
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /HTTP 503/);
	now += 119_999;
	await publish("connected");
	assert.equal(sent.length, 1);
	now++;
	restored = true;
	await reporter.flush();
	assert.deepEqual(sent, ["connecting", "connected"]);
});

test("an old-account failure cannot throttle the new account or replay an old pending report", async () => {
	let finish!: (response: Response) => void;
	const first = new Promise<Response>(resolve => { finish = resolve; });
	const sent: string[] = [];
	const reporter = createConnectorStatusReporter({ onError: error => { throw error; } });
	const pending = reporter.publish({ scope: "old", body: "connecting", send: () => first });
	void reporter.publish({ scope: "old", body: "stopped", send: async () => { sent.push("old"); return new Response(); } });
	void reporter.publish({ scope: "new", body: "connected", send: async () => { sent.push("new"); return new Response(); } });
	finish(new Response("Maintenance", { status: 503, headers: { "retry-after": "3600" } }));
	await pending;
	assert.deepEqual(sent, ["new"]);
});

test("network errors remain visible and use bounded backoff instead of an unbounded promise queue", async () => {
	let now = 1_000;
	let calls = 0;
	let errors = 0;
	const reporter = createConnectorStatusReporter({ now: () => now, onError: () => { errors++; } });
	const report = { scope: "account-device", body: "connecting", send: async () => { calls++; throw new Error("offline"); } };
	await reporter.publish(report);
	for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000]) {
		const before = calls;
		now += delay - 1;
		await reporter.publish(report);
		assert.equal(calls, before);
		now++;
		await reporter.publish(report);
		assert.equal(calls, before + 1);
	}
	assert.equal(errors, calls);
});
