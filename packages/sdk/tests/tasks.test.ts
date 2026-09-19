import assert from "node:assert/strict";
import test from "node:test";
import { TasksApi } from "../src/apis/tasks.js";
import type { HttpTransport } from "../src/transport.js";
import type { WebsocketClient, WebsocketEventPayload } from "../src/websocket.js";

test("realtime task updates keep one fallback poll timer and release the room on abort", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let requests = 0;
	let listener: ((event: WebsocketEventPayload) => void) | undefined;
	let releases = 0;
	let unsubscribes = 0;
	const websocket = {
		state: "open",
		retainRooms: () => () => { releases += 1; },
		on: (_type: string, handler: typeof listener) => {
			listener = handler;
			return () => { listener = undefined; unsubscribes += 1; };
		},
	} as unknown as WebsocketClient;
	const transport = {
		request: async () => {
			requests += 1;
			return { run: { id: "task-1", spaceId: "space-1", status: "running" } };
		},
	} as unknown as HttpTransport;
	const controller = new AbortController();
	const waiting = new TasksApi(transport, websocket).wait("task-1", {
		signal: controller.signal,
		pollIntervalMs: 2_000,
	});
	const aborted = assert.rejects(waiting, { name: "AbortError" });
	const flush = async () => {
		for (let i = 0; i < 4; i += 1) await Promise.resolve();
	};
	try {
		await flush();
		assert.ok(listener);
		for (let i = 0; i < 2; i += 1) {
			t.mock.timers.tick(100);
			listener({ type: "task.updated", payload: { task: { id: "task-1" } } } as WebsocketEventPayload);
			await flush();
		}
		assert.equal(requests, 3);
		t.mock.timers.tick(1_800);
		await flush();
		assert.equal(requests, 3, "a realtime update must replace the older fallback poll");
		t.mock.timers.tick(200);
		await flush();
		assert.equal(requests, 4);
	} finally {
		controller.abort();
		await aborted;
	}
	assert.equal(releases, 1);
	assert.equal(unsubscribes, 1);
	const before = requests;
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(requests, before);
});

test("wait rejects an already-aborted signal before requesting", async () => {
	const controller = new AbortController();
	controller.abort();
	let requested = false;
	const transport = {
		request: async () => {
			requested = true;
			return {};
		},
	} as unknown as HttpTransport;
	await assert.rejects(
		() => new TasksApi(transport).wait("task-1", { signal: controller.signal }),
		(error) => error instanceof DOMException && error.name === "AbortError",
	);
	assert.equal(requested, false);
});

test("wait rejects invalid timing options", async () => {
	const transport = { request: async () => ({}) } as unknown as HttpTransport;
	const tasks = new TasksApi(transport);
	await assert.rejects(() => tasks.wait("task-1", { timeoutMs: Number.NaN }), /timeoutMs/);
	await assert.rejects(() => tasks.wait("task-1", { pollIntervalMs: 1 }), /pollIntervalMs/);
});

test("wait returns immediately for a terminal task", async () => {
	const transport = {
		request: async () => ({
			run: {
				id: "task-1",
				status: "completed",
				spaceId: "space-1",
			} as never,
			progress: null,
		}),
	} as unknown as HttpTransport;
	const task = await new TasksApi(transport).wait("task-1");
	assert.equal(task.id, "task-1");
	assert.equal(task.status, "completed");
});

test("getMany deduplicates task IDs and scopes the batch to a Space", async () => {
	const requests: string[] = [];
	const transport = {
		request(path: string) {
			requests.push(path);
			return Promise.resolve({ runs: [] });
		},
	} as unknown as HttpTransport;
	const tasks = new TasksApi(transport);

	await tasks.getMany(["task-1", "task-2", "task-1"], {
		spaceId: "space-1",
	});

	assert.equal(requests.length, 1);
	const url = new URL(requests[0] ?? "", "https://api.example.com");
	assert.equal(url.pathname, "/api/tasks");
	assert.equal(url.searchParams.get("ids"), "task-1,task-2");
	assert.equal(url.searchParams.get("spaceId"), "space-1");
	assert.equal(url.searchParams.get("limit"), "2");
});

test("getMany avoids a request for an empty batch", async () => {
	let requested = false;
	const transport = {
		request() {
			requested = true;
			return Promise.resolve({ runs: [] });
		},
	} as unknown as HttpTransport;

	const result = await new TasksApi(transport).getMany([]);

	assert.deepEqual(result, { runs: [] });
	assert.equal(requested, false);
});
