import assert from "node:assert/strict";
import test, { beforeEach, afterEach, describe } from "node:test";
import {
	personalNodeFetch,
	choosePersonalNodeDevice,
	listPersonalNodeDevices,
	currentPersonalNodeScope,
	getPersonalNodeDeviceStatus,
	resolvePersonalNodeDevice,
	invalidatePersonalNodeRequests,
} from "$lib/personal-node-fetch";
import { localRelayRequestTimeoutMs } from "@cohub/protocol/local-relay-request-timeout";

describe("personal node fetch", () => {
	const deviceId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
	const accountId = "a".repeat(64);
	const storageDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	beforeEach(() => {
		invalidatePersonalNodeRequests();
		const values = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, value),
			},
		});
	});
	afterEach(() => {
		if (storageDescriptor)
			Object.defineProperty(globalThis, "localStorage", storageDescriptor);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	for (const kind of ["upload completion", "file download"] as const) {
		test(`${kind} keeps polling the same command beyond the ordinary read deadline`, async (t) => {
			let now = Date.now();
			let polls = 0;
			let dispatches = 0;
			t.mock.method(Date, "now", () => now);
			t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/account")) return Response.json({ accountId });
				if (url.endsWith("/devices"))
					return Response.json({
						devices: [{ id: deviceId, displayName: "Mac", status: "active" }],
					});
				if (url.endsWith("/status"))
					return Response.json({ connected: true, connector: null });
				if (url.endsWith("/commands")) {
					dispatches += 1;
					return Response.json({
						command: { id: "upload-completion", status: "running" },
					});
				}
				if (url.endsWith("/commands/upload-completion")) {
					polls += 1;
					now += 65_000;
					return Response.json({
						command:
							polls === 1
								? { id: "upload-completion", status: "running" }
								: {
										id: "upload-completion",
										status: "succeeded",
										result: { status: 200, headers: {}, body: '{"ok":true}' },
									},
					});
				}
				throw new Error(`unexpected ${url}`);
			});
			const download = kind === "file download";
			const path = download
				? `download?path=large.zip`
				: `uploads/${deviceId}/complete`;
			const response = await personalNodeFetch(
				`https://dev2-cohub.atou.cc/api/spaces/${deviceId}/fs/${path}`,
				{
					method: download ? "GET" : "POST",
					body: download ? undefined : '{"entries":[{"id":"file"}]}',
					headers: { authorization: `Bearer long-${kind}` },
				},
			);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: true });
			assert.equal(polls, 2);
			assert.equal(dispatches, 1);
		});
	}

	test("long upload budgets do not extend unrelated calls or partial path matches", () => {
		const path = `/api/spaces/${deviceId}/fs/uploads/${deviceId}/complete`;
		assert.equal(
			localRelayRequestTimeoutMs({ method: "POST", path }, 30_000),
			61 * 60_000,
		);
		assert.equal(
			localRelayRequestTimeoutMs({ method: "GET", path }, 30_000),
			30_000,
		);
		assert.equal(
			localRelayRequestTimeoutMs(
				{ method: "POST", path: path + "/other" },
				30_000,
			),
			30_000,
		);
		assert.equal(
			localRelayRequestTimeoutMs(
				{ method: "PUT", path, bodyParts: [{}] },
				30_000,
			),
			10 * 60_000,
		);
		const download = `/api/spaces/${deviceId}/fs/download`;
		assert.equal(
			localRelayRequestTimeoutMs(
				{ method: "GET", path: download + "?path=large.zip" },
				30_000,
			),
			10 * 60_000,
		);
		assert.equal(
			localRelayRequestTimeoutMs(
				{ method: "GET", path: download },
				20 * 60_000,
			),
			20 * 60_000,
		);
		assert.equal(
			localRelayRequestTimeoutMs({ method: "POST", path: download }, 30_000),
			30_000,
		);
		assert.equal(
			localRelayRequestTimeoutMs(
				{ method: "GET", path: download + "/other" },
				30_000,
			),
			30_000,
		);
	});

	test("reads live data instead of returning a stale projection with an invisible refresh", async (t) => {
		const calls: string[] = [];
		t.mock.method(
			globalThis,
			"fetch",
			async (input: string | URL | Request) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith("/account")) return Response.json({ accountId });
				if (url.endsWith("/devices"))
					return Response.json({
						devices: [
							{ id: deviceId, displayName: "Test Mac", status: "active" },
						],
					});
				if (url.endsWith("/status"))
					return Response.json({ connected: true, connector: null });
				if (url.includes("/read?"))
					return Response.json({
						projection: {
							path: "/api/spaces",
							updatedAt: "2020-01-01T00:00:00.000Z",
							result: { status: 200, headers: {}, body: "stale" },
						},
					});
				if (url.endsWith("/commands"))
					return Response.json({
						command: {
							id: "fresh-read",
							status: "succeeded",
							result: { status: 200, headers: {}, body: "fresh" },
							errorCode: null,
							errorMessage: null,
						},
					});
				throw new Error(`Unexpected request: ${url}`);
			},
		);
		const response = await personalNodeFetch(
			"https://dev2-cohub.atou.cc/api/spaces",
			{ headers: { authorization: "Bearer freshness-test" } },
		);
		assert.equal(await response.text(), "fresh");
		assert.equal(calls.filter((url) => url.endsWith("/commands")).length, 1);
		assert.equal(
			calls.some((url) => url.includes("/read?")),
			false,
		);
	});

	test("surfaces registry errors instead of claiming the user has no device", async (t) => {
		t.mock.method(
			globalThis,
			"fetch",
			async () => new Response("Unavailable", { status: 503 }),
		);
		await assert.rejects(
			personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", {
				headers: { authorization: "Bearer registry-error-test" },
			}),
			/HTTP 503/,
		);
	});

	test("rejects a corrupt device list rather than silently selecting from partial data", async (t) => {
		t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
			Response.json(
				String(input).endsWith("/account") ? { accountId } : { wrongField: [] },
			),
		);
		await assert.rejects(
			personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", {
				headers: { authorization: "Bearer corrupt-registry-test" },
			}),
			/device.*invalid/i,
		);
	});

	test("a read after a completed mutation does not share a pre-mutation response", async (t) => {
		let finishOldRead!: (value: Response) => void;
		let readStarted!: () => void;
		const oldRead = new Promise<Response>((resolve) => {
			finishOldRead = resolve;
		});
		const started = new Promise<void>((resolve) => {
			readStarted = resolve;
		});
		let reads = 0;
		const commands: {
			request: { method: string; body: string };
			idempotencyKey: string;
		}[] = [];
		const result = (body: string) =>
			Response.json({
				command: {
					id: crypto.randomUUID(),
					status: "succeeded",
					result: { status: 200, headers: {}, body },
					errorCode: null,
					errorMessage: null,
				},
			});
		t.after(() => finishOldRead(result("before")));
		t.mock.method(
			globalThis,
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/account")) return Response.json({ accountId });
				if (url.endsWith("/devices"))
					return Response.json({
						devices: [
							{ id: deviceId, displayName: "Test Mac", status: "active" },
						],
					});
				if (url.endsWith("/status"))
					return Response.json({ connected: true, connector: null });
				if (url.endsWith("/commands")) {
					const command = JSON.parse(String(init?.body));
					commands.push(command);
					if (command.request.method !== "GET") return result("updated");
					reads += 1;
					if (reads === 1) {
						readStarted();
						return oldRead;
					}
					return result("after");
				}
				throw new Error(`Unexpected request: ${url}`);
			},
		);
		const url = "https://dev2-cohub.atou.cc/api/spaces";
		const headers = { authorization: "Bearer mutation-barrier-test" };
		const before = personalNodeFetch(url, { headers });
		await Promise.race([
			started,
			before.then(() => {
				throw new Error("read did not enter relay");
			}),
		]);
		assert.equal(
			await (
				await personalNodeFetch(url, {
					headers,
					method: "PATCH",
					body: '{"title":"New"}',
				})
			).text(),
			"updated",
		);
		const after = personalNodeFetch(url, { headers });
		// Let the old request finish even if the new request incorrectly shares it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		finishOldRead(result("before"));
		assert.equal(await (await after).text(), "after");
		assert.equal(await (await before).text(), "before");
		assert.equal(reads, 2);
		assert.equal(commands[1].request.body, '{"title":"New"}');
		assert.equal(
			new Set(commands.map((command) => command.idempotencyKey)).size,
			3,
		);
	});

	test("a missing preferred device is not replaced by another active device", async (t) => {
		const values = new Map([
			[
				`cohub:personal-node:active-device:${accountId}`,
				"669526bb-bf65-4013-a825-4f61adf199f8",
			],
		]);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, value),
			},
		});
		t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/account"))
				return Response.json({ accountId });
			if (String(input).endsWith("/devices"))
				return Response.json({
					devices: [
						{ id: deviceId, displayName: "Other Mac", status: "active" },
					],
				});
			throw new Error("must not dispatch to another device");
		});
		await assert.rejects(
			personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", {
				headers: { authorization: "Bearer preferred-missing" },
			}),
			/selected.*device.*unavailable/i,
		);
		assert.equal(
			values.get(`cohub:personal-node:active-device:${accountId}`),
			"669526bb-bf65-4013-a825-4f61adf199f8",
		);
	});

	test("an old account response cannot arrive after a new account request", async (t) => {
		let finish!: (value: Response) => void;
		let started!: () => void;
		const pending = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const result = (body: string) =>
			Response.json({
				command: {
					id: crypto.randomUUID(),
					status: "succeeded",
					result: { status: 200, headers: {}, body },
					errorCode: null,
					errorMessage: null,
				},
			});
		t.after(() => finish(result("old account")));
		t.mock.method(
			globalThis,
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const old =
					new Headers(init?.headers).get("authorization") ===
					"Bearer account-old";
				const url = String(input);
				if (url.endsWith("/account"))
					return Response.json({ accountId: old ? accountId : "b".repeat(64) });
				if (url.endsWith("/devices"))
					return Response.json({
						devices: [{ id: deviceId, displayName: "Mac", status: "active" }],
					});
				if (url.endsWith("/status"))
					return Response.json({ connected: true, connector: null });
				if (url.endsWith("/commands")) {
					if (old) {
						started();
						return pending;
					}
					return result("new account");
				}
				throw new Error(`unexpected ${url}`);
			},
		);
		const old = personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", {
			headers: { authorization: "Bearer account-old" },
		});
		await Promise.race([
			ready,
			old.then(() => {
				throw new Error("read did not enter relay");
			}),
		]);
		assert.equal(
			await (
				await personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", {
					headers: { authorization: "Bearer account-new" },
				})
			).text(),
			"new account",
		);
		const rejected = assert.rejects(old, /account or device changed/i);
		finish(result("old account"));
		await rejected;
	});

	test("explicit device choice rejects revoked devices and invalidates an in-flight old-device read", async (t) => {
		const otherId = "669526bb-bf65-4013-a825-4f61adf199f8";
		let finish!: (value: Response) => void;
		let started!: () => void;
		const pending = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const result = () =>
			Response.json({
				command: {
					id: crypto.randomUUID(),
					status: "succeeded",
					result: { status: 200, headers: {}, body: "old device" },
					errorCode: null,
					errorMessage: null,
				},
			});
		t.after(() => finish(result()));
		const authorization = "Bearer device-choice";
		t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/account")) return Response.json({ accountId });
			if (url.endsWith("/devices"))
				return Response.json({
					devices: [
						{ id: deviceId, displayName: "First Mac", status: "active" },
						{ id: otherId, displayName: "Second Mac", status: "active" },
						{
							id: "fbb14c9d-7c86-47eb-88ef-e8db2acd4875",
							displayName: "Revoked",
							status: "revoked",
						},
					],
				});
			if (url.endsWith("/status"))
				return Response.json({ connected: true, connector: null });
			if (url.endsWith("/commands")) {
				started();
				return pending;
			}
			throw new Error(`unexpected ${url}`);
		});
		await choosePersonalNodeDevice(authorization, deviceId);
		const old = personalNodeFetch("https://dev2-cohub.atou.cc/api/spaces", {
			headers: { authorization },
		});
		await Promise.race([
			ready,
			old.then(() => {
				throw new Error("read did not enter relay");
			}),
		]);
		await assert.rejects(
			choosePersonalNodeDevice(
				authorization,
				"fbb14c9d-7c86-47eb-88ef-e8db2acd4875",
			),
			/unavailable/i,
		);
		assert.equal(currentPersonalNodeScope()?.deviceId, deviceId);
		const rejected = assert.rejects(old, /account or device changed/i);
		await choosePersonalNodeDevice(authorization, otherId);
		assert.equal(currentPersonalNodeScope()?.deviceId, otherId);
		finish(result());
		await rejected;
	});

	test("device list remains available for an explicit choice after the preferred device disappears", async (t) => {
		const authorization = "Bearer missing-device-chooser";
		localStorage.setItem(
			`cohub:personal-node:active-device:${accountId}`,
			"669526bb-bf65-4013-a825-4f61adf199f8",
		);
		t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
			Response.json(
				String(input).endsWith("/account")
					? { accountId }
					: {
							devices: [
								{
									id: deviceId,
									displayName: "Available Mac",
									status: "active",
								},
							],
						},
			),
		);
		assert.equal(
			(await listPersonalNodeDevices(authorization)).devices[0].id,
			deviceId,
		);
		await choosePersonalNodeDevice(authorization, deviceId);
		assert.equal(
			localStorage.getItem(`cohub:personal-node:active-device:${accountId}`),
			deviceId,
		);
	});

	test("concurrent status prechecks share one request and retain the status through the old 3-second poll interval", async (t) => {
		let now = Date.now();
		let requests = 0;
		t.mock.method(Date, "now", () => now);
		t.mock.method(globalThis, "fetch", async () => {
			requests++;
			return Response.json({ connected: true, connector: null });
		});
		const authorization = "Bearer shared-status";
		await Promise.all(
			Array.from({ length: 20 }, () =>
				getPersonalNodeDeviceStatus(deviceId, authorization),
			),
		);
		assert.equal(requests, 1);
		now += 3_000;
		assert.equal(
			(await getPersonalNodeDeviceStatus(deviceId, authorization)).connected,
			true,
		);
		assert.equal(requests, 1);
		now += 15_000;
		await getPersonalNodeDeviceStatus(deviceId, authorization);
		assert.equal(requests, 2);
	});

	test("the device monitor and simultaneous API prechecks share account and device lookups", async (t) => {
		const requests: string[] = [];
		t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/account")) return Response.json({ accountId });
			if (url.endsWith("/devices"))
				return Response.json({
					devices: [{ id: deviceId, displayName: "Mac", status: "active" }],
				});
			throw new Error(`Unexpected request: ${url}`);
		});
		const authorization = "Bearer shared-registry";
		await Promise.all([
			listPersonalNodeDevices(authorization),
			resolvePersonalNodeDevice(authorization),
			listPersonalNodeDevices(authorization),
		]);
		assert.equal(requests.filter((url) => url.endsWith("/account")).length, 1);
		assert.equal(requests.filter((url) => url.endsWith("/devices")).length, 1);
	});

	test("maintenance errors preserve the error and suppress subsequent prechecks until Retry-After", async (t) => {
		let now = Date.now();
		let requests = 0;
		let restored = false;
		t.mock.method(Date, "now", () => now);
		t.mock.method(globalThis, "fetch", async () => {
			requests++;
			return restored
				? Response.json({ connected: true, connector: null })
				: new Response("Maintenance", {
						status: 503,
						headers: { "retry-after": "120" },
					});
		});
		const authorization = "Bearer maintenance-status";
		await assert.rejects(
			getPersonalNodeDeviceStatus(deviceId, authorization),
			/HTTP 503/,
		);
		for (let i = 0; i < 10; i++)
			await assert.rejects(
				getPersonalNodeDeviceStatus(deviceId, authorization),
				/HTTP 503/,
			);
		await assert.rejects(listPersonalNodeDevices(authorization), /HTTP 503/);
		assert.equal(requests, 1);
		now += 120_001;
		restored = true;
		assert.equal(
			(await getPersonalNodeDeviceStatus(deviceId, authorization)).connected,
			true,
		);
		assert.equal(requests, 2);
	});
});
