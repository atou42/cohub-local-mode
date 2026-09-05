import assert from "node:assert/strict";
import test from "node:test";
import { personalNodeFetch } from "$lib/personal-node-fetch";

const deviceId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";

test("reads live data instead of returning a stale projection with an invisible refresh", async (t) => {
	const calls: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/devices")) return Response.json({ devices: [{ id: deviceId, displayName: "Test Mac", status: "active" }] });
		if (url.endsWith("/status")) return Response.json({ connected: true, connector: null });
		if (url.includes("/read?")) return Response.json({ projection: { path: "/api/spaces", updatedAt: "2020-01-01T00:00:00.000Z", result: { status: 200, headers: {}, body: "stale" } } });
		if (url.endsWith("/commands")) return Response.json({ command: { id: "fresh-read", status: "succeeded", result: { status: 200, headers: {}, body: "fresh" }, errorCode: null, errorMessage: null } });
		throw new Error(`Unexpected request: ${url}`);
	});
	const response = await personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", { headers: { authorization: "Bearer freshness-test" } });
	assert.equal(await response.text(), "fresh");
	assert.equal(calls.filter((url) => url.endsWith("/commands")).length, 1);
	assert.equal(calls.some((url) => url.includes("/read?")), false);
});

test("surfaces registry errors instead of claiming the user has no device", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
	await assert.rejects(personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", { headers: { authorization: "Bearer registry-error-test" } }), /HTTP 503/);
});

test("rejects a corrupt device list rather than silently selecting from partial data", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ wrongField: [] }));
	await assert.rejects(personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", { headers: { authorization: "Bearer corrupt-registry-test" } }), /device.*invalid/i);
});

test("a read after a completed mutation does not share a pre-mutation response", async (t) => {
	let finishOldRead!: (value: Response) => void;
	let readStarted!: () => void;
	const oldRead = new Promise<Response>((resolve) => { finishOldRead = resolve; });
	const started = new Promise<void>((resolve) => { readStarted = resolve; });
	let reads = 0;
	const commands: { request: { method: string; body: string }; idempotencyKey: string }[] = [];
	const result = (body: string) => Response.json({ command: { id: crypto.randomUUID(), status: "succeeded", result: { status: 200, headers: {}, body }, errorCode: null, errorMessage: null } });
	t.after(() => finishOldRead(result("before")));
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/devices")) return Response.json({ devices: [{ id: deviceId, displayName: "Test Mac", status: "active" }] });
		if (url.endsWith("/status")) return Response.json({ connected: true, connector: null });
		if (url.endsWith("/commands")) {
			const command = JSON.parse(String(init?.body));
			commands.push(command);
			if (command.request.method !== "GET") return result("updated");
			reads += 1;
			if (reads === 1) { readStarted(); return oldRead; }
			return result("after");
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	const url = "https://dev2-cohub.atou.cc/api/spaces";
	const headers = { authorization: "Bearer mutation-barrier-test" };
	const before = personalNodeFetch(url, { headers });
	await started;
	assert.equal(await (await personalNodeFetch(url, { headers, method: "PATCH", body: '{"title":"New"}' })).text(), "updated");
	const after = personalNodeFetch(url, { headers });
	// Let the old request finish even if the new request incorrectly shares it.
	await new Promise((resolve) => setTimeout(resolve, 20));
	finishOldRead(result("before"));
	assert.equal(await (await after).text(), "after");
	assert.equal(await (await before).text(), "before");
	assert.equal(reads, 2);
	assert.equal(commands[1].request.body, '{"title":"New"}');
	assert.equal(new Set(commands.map((command) => command.idempotencyKey)).size, 3);
});
