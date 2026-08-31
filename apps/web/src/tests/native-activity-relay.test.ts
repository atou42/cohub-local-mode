import assert from "node:assert/strict";
import test from "node:test";
import {
	NATIVE_STATE_RESET_TIMEOUT_MS,
	NativeStateResetAcknowledger,
	resetNativeAccountState,
} from "$lib/native-activity/account-reset";
import {
	DirtyAsyncCoordinator,
	NATIVE_REGISTRATION_HEARTBEAT_MS,
	NativeRegistrationHeartbeat,
	ProjectionRegistrationCoordinator,
	runWithBoundedRetry,
} from "$lib/native-activity/async-coordination";
import {
	nativeActivityEndMessage,
	nativeActivityStartMessage,
	nativePushRegisterMessage,
	nativeSnapshotReplaceMessage,
	nativeStateResetMessage,
} from "$lib/native-activity/messages";
import {
	buildNativeActivityPreferences,
	preferenceRegistrationKey,
	resolvePreferenceInstallationId,
} from "$lib/native-activity/preferences";
import { resolveNativeFreshness } from "$lib/native-activity/projection";
import {
	nativeRegistrationMetadataKey,
	readNativeRegistrationMetadata,
	writeNativeRegistrationMetadata,
} from "$lib/native-activity/registration-metadata";
import {
	createNativeRelayRegistrationAdapter,
	isNativePushToken,
	resolveNativeTokenEventEnvironment,
} from "$lib/native-activity/relay-registration";
import type { NativeActivitySnapshot } from "$lib/native-activity/types";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		storage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
			clear: () => values.clear(),
			key: (index: number) => [...values.keys()][index] ?? null,
			get length() {
				return values.size;
			},
		} as Storage,
		values,
	};
}

const snapshot: NativeActivitySnapshot = {
	schemaVersion: 1,
	revision: 1,
	generatedAt: "2026-08-31T10:00:00.000Z",
	freshness: "live",
	primarySpaceId: null,
	primarySessionId: null,
	otherActiveCount: 0,
	boardSpaceIds: [],
	spaces: [],
};

test("native bridge lifecycle messages use the exact schema v1 payloads", () => {
	assert.deepEqual(nativeSnapshotReplaceMessage(snapshot), {
		schemaVersion: 1,
		type: "snapshot.replace",
		snapshot,
	});
	assert.deepEqual(nativeActivityStartMessage(snapshot), {
		schemaVersion: 1,
		type: "activity.start",
		snapshot,
	});
	assert.deepEqual(nativeActivityEndMessage(), {
		schemaVersion: 1,
		type: "activity.end",
	});
	assert.deepEqual(nativePushRegisterMessage(), {
		schemaVersion: 1,
		type: "push.register",
	});
	assert.deepEqual(nativeStateResetMessage(), {
		schemaVersion: 1,
		type: "state.reset",
	});
});

test("native account reset deletes Relay registrations before clearing native state", async () => {
	const calls: string[] = [];
	await resetNativeAccountState({
		preferenceInstallationId: "00000000-0000-4000-8000-000000000001",
		device: {
			installationId: "00000000-0000-4000-8000-000000000001",
			environment: "development",
		},
		activities: [
			{
				installationId: "00000000-0000-4000-8000-000000000001",
				activityId: "00000000-0000-4000-8000-000000000002",
				environment: "production",
			},
		],
		relay: {
			deletePreferences: async () => {
				calls.push("delete-preferences");
			},
			deleteDevice: async () => {
				calls.push("delete-device");
			},
			deleteActivity: async () => {
				calls.push("delete-activity");
			},
		},
		resetNativeState: async () => {
			calls.push("state.reset");
		},
		retry: { maxAttempts: 1, baseDelayMs: 0 },
	});
	assert.deepEqual(calls, [
		"delete-preferences",
		"delete-device",
		"delete-activity",
		"state.reset",
	]);
});

test("dirty reconciliation runs again after tracked targets change mid-request", async () => {
	const coordinator = new DirtyAsyncCoordinator();
	let releaseFirst!: () => void;
	let runs = 0;
	const run = async () => {
		runs += 1;
		if (runs === 1) {
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
		}
	};
	const first = coordinator.request(run);
	await Promise.resolve();
	const second = coordinator.request(run);
	releaseFirst();
	await Promise.all([first, second]);
	assert.equal(runs, 2);
});

test("bounded Relay retry recovers after a 503 without committing early", async () => {
	let attempts = 0;
	const result = await runWithBoundedRetry(
		async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("503");
			return "registered";
		},
		{ maxAttempts: 3, baseDelayMs: 0 },
	);
	assert.equal(result, "registered");
	assert.equal(attempts, 2);
});

test("registration projection commits only after a retry succeeds", async () => {
	const coordinator = new ProjectionRegistrationCoordinator({
		maxAttempts: 3,
		baseDelayMs: 0,
	});
	let attempts = 0;
	let releaseFirst!: () => void;
	const pending = coordinator.request({
		key: "focus-b",
		register: async () => {
			attempts += 1;
			if (attempts === 1) {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
				throw new Error("503");
			}
		},
	});
	await Promise.resolve();
	assert.equal(coordinator.committedProjectionKey, "");
	releaseFirst();
	await pending;
	assert.equal(attempts, 2);
	assert.equal(coordinator.committedProjectionKey, "focus-b");
});

test("stopping registration cancels a pending retry timer", async () => {
	const coordinator = new ProjectionRegistrationCoordinator({
		maxAttempts: 3,
		baseDelayMs: 10_000,
	});
	let attempts = 0;
	const pending = coordinator.request({
		key: "focus-c",
		register: async () => {
			attempts += 1;
			throw new Error("503");
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	coordinator.stop();
	await pending;
	assert.equal(attempts, 1);
	assert.equal(coordinator.committedProjectionKey, "");
});

test("failed account cleanup does not clear native state", async () => {
	const messages: unknown[] = [];
	await assert.rejects(
		resetNativeAccountState({
			preferenceInstallationId: "00000000-0000-4000-8000-000000000001",
			device: {
				installationId: "00000000-0000-4000-8000-000000000001",
				environment: "development",
			},
			activities: [],
			relay: {
				deletePreferences: async () => undefined,
				deleteDevice: async () => {
					throw new Error("503");
				},
				deleteActivity: async () => undefined,
			},
			resetNativeState: async () => {
				messages.push("state.reset");
			},
			retry: { maxAttempts: 1, baseDelayMs: 0 },
		}),
		/503/,
	);
	assert.deepEqual(messages, []);
});

test("failed preference deletion prevents token deletion and native reset", async () => {
	const calls: string[] = [];
	await assert.rejects(
		resetNativeAccountState({
			preferenceInstallationId: "00000000-0000-4000-8000-000000000001",
			device: {
				installationId: "00000000-0000-4000-8000-000000000001",
			},
			activities: [
				{
					installationId: "00000000-0000-4000-8000-000000000001",
					activityId: "00000000-0000-4000-8000-000000000002",
				},
			],
			relay: {
				deletePreferences: async () => {
					calls.push("delete-preferences");
					throw new Error("preference delete failed");
				},
				deleteDevice: async () => {
					calls.push("delete-device");
				},
				deleteActivity: async () => {
					calls.push("delete-activity");
				},
			},
			resetNativeState: async () => {
				calls.push("state.reset");
			},
			retry: { maxAttempts: 1, baseDelayMs: 0 },
		}),
		/preference delete failed/,
	);
	assert.deepEqual(calls, ["delete-preferences"]);
});

test("state reset waits for the exact native completion event", async () => {
	const timers: Array<{
		callback: () => void;
		handle: number;
		delayMs: number;
	}> = [];
	const cleared: number[] = [];
	const acknowledger = new NativeStateResetAcknowledger({
		setTimeout: (callback, delayMs) => {
			const handle = timers.length + 1;
			timers.push({ callback, handle, delayMs });
			return handle;
		},
		clearTimeout: (handle) => cleared.push(handle as number),
	});
	const messages: unknown[] = [];
	const pending = acknowledger.request((message) => messages.push(message));
	assert.deepEqual(messages, [{ schemaVersion: 1, type: "state.reset" }]);
	assert.equal(timers[0]?.delayMs, NATIVE_STATE_RESET_TIMEOUT_MS);
	assert.equal(
		acknowledger.handleEvent({
			schemaVersion: 2,
			type: "state.reset.completed",
		}),
		false,
	);
	assert.equal(
		acknowledger.handleEvent({
			schemaVersion: 1,
			type: "state.reset.completed",
		}),
		true,
	);
	await pending;
	assert.deepEqual(cleared, [timers[0]?.handle]);
});

test("state reset rejects native failure and finite timeout", async () => {
	const timers: Array<() => void> = [];
	const acknowledger = new NativeStateResetAcknowledger({
		setTimeout: (callback) => {
			timers.push(callback);
			return timers.length;
		},
		clearTimeout: () => undefined,
	});
	const failed = acknowledger.request(() => undefined);
	acknowledger.handleEvent({
		schemaVersion: 1,
		type: "action.failed",
		action: "state.reset",
	});
	await assert.rejects(failed, /reset failed/);
	const timedOut = acknowledger.request(() => undefined);
	timers.at(-1)?.();
	await assert.rejects(timedOut, /timed out/);
});

test("registration metadata persists identifiers but never tokens", () => {
	const { storage, values } = memoryStorage();
	const secret = "ab".repeat(32);
	writeNativeRegistrationMetadata(storage, "registrations", {
		device: {
			installationId: "00000000-0000-4000-8000-000000000001",
			environment: "development",
			token: secret,
		} as never,
		activities: [
			{
				installationId: "00000000-0000-4000-8000-000000000001",
				activityId: "00000000-0000-4000-8000-000000000002",
				environment: "production",
				token: secret,
			} as never,
		],
	});
	const raw = values.get("registrations") ?? "";
	assert.equal(raw.includes(secret), false);
	assert.deepEqual(readNativeRegistrationMetadata(storage, "registrations"), {
		version: 1,
		device: {
			installationId: "00000000-0000-4000-8000-000000000001",
			environment: "development",
		},
		activities: [
			{
				installationId: "00000000-0000-4000-8000-000000000001",
				activityId: "00000000-0000-4000-8000-000000000002",
				environment: "production",
			},
		],
	});
});

test("registration metadata keys are isolated by user", () => {
	assert.notEqual(
		nativeRegistrationMetadataKey("user-a"),
		nativeRegistrationMetadataKey("user-b"),
	);
});

test("registration metadata rejects a persisted token", () => {
	const { storage } = memoryStorage();
	storage.setItem(
		"registrations",
		JSON.stringify({
			version: 1,
			device: {
				installationId: "00000000-0000-4000-8000-000000000001",
				token: "secret",
			},
			activities: [],
		}),
	);
	assert.throws(
		() => readNativeRegistrationMetadata(storage, "registrations"),
		/metadata is malformed/,
	);
});

test("native Relay activity registration forwards the production environment", async () => {
	const requests: Array<{ path: string; init?: RequestInit }> = [];
	const adapter = createNativeRelayRegistrationAdapter((async (
		path: RequestInfo | URL,
		init?: RequestInit,
	) => {
		requests.push({ path: String(path), init });
		return new Response("{}", { status: 200 });
	}) as typeof fetch);
	const token = "ab".repeat(32);
	await adapter.putActivity({
		installationId: "00000000-0000-4000-8000-000000000001",
		activityId: "00000000-0000-4000-8000-000000000002",
		token,
		environment: "production",
	});
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0]?.path,
		"/relay/v1/nodes/mac-mini/activity/registrations/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002",
	);
	assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
		token,
		environment: "production",
	});
});

test("native Relay preferences preserve mixed origins and a fourth focused Space", async () => {
	const requests: Array<{ path: string; init?: RequestInit }> = [];
	const adapter = createNativeRelayRegistrationAdapter((async (
		path: RequestInfo | URL,
		init?: RequestInit,
	) => {
		requests.push({ path: String(path), init });
		return new Response("{}", { status: 200 });
	}) as typeof fetch);
	const localSpaceId = "00000000-0000-4000-8000-000000000010";
	const cloudSpaceId = "00000000-0000-4000-8000-000000000011";
	const focusSpaceId = "00000000-0000-4000-8000-000000000013";
	const preferences = buildNativeActivityPreferences({
		spaces: [
			{ id: localSpaceId, name: "Local", origin: "local", isPinned: true },
			{ id: cloudSpaceId, name: "Cloud", origin: "cloud", isPinned: true },
			{
				id: "00000000-0000-4000-8000-000000000012",
				name: "Cloud two",
				origin: "cloud",
				isPinned: true,
			},
			{ id: focusSpaceId, name: "Focus", origin: "local", isPinned: false },
		],
		watchedSpaceIds: [
			localSpaceId,
			cloudSpaceId,
			"00000000-0000-4000-8000-000000000012",
		],
		focus: {
			spaceId: focusSpaceId,
			sessionId: "00000000-0000-4000-8000-000000000020",
			explicit: true,
		},
	});
	await adapter.putPreferences(
		"00000000-0000-4000-8000-000000000001",
		preferences,
	);
	assert.equal(
		requests[0]?.path,
		"/relay/v1/nodes/mac-mini/activity/preferences/00000000-0000-4000-8000-000000000001",
	);
	assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
		watchedSpaces: [
			{ spaceId: localSpaceId, origin: "local" },
			{ spaceId: cloudSpaceId, origin: "cloud" },
			{
				spaceId: "00000000-0000-4000-8000-000000000012",
				origin: "cloud",
			},
		],
		focus: {
			spaceId: focusSpaceId,
			origin: "local",
			sessionId: "00000000-0000-4000-8000-000000000020",
			explicit: true,
		},
	});
	await adapter.deletePreferences("00000000-0000-4000-8000-000000000001");
	assert.equal(requests[1]?.path, requests[0]?.path);
	assert.equal(requests[1]?.init?.method, "DELETE");
});

test("native preferences reject a missing or ambiguous catalog origin", () => {
	const spaceId = "00000000-0000-4000-8000-000000000010";
	assert.throws(
		() =>
			buildNativeActivityPreferences({
				spaces: [],
				watchedSpaceIds: [spaceId],
				focus: null,
			}),
		/Space origin is missing/,
	);
	assert.throws(
		() =>
			buildNativeActivityPreferences({
				spaces: [
					{ id: spaceId, name: "Local", origin: "local", isPinned: true },
					{ id: spaceId, name: "Cloud", origin: "cloud", isPinned: true },
				],
				watchedSpaceIds: [spaceId],
				focus: null,
			}),
		/Space origin is ambiguous/,
	);
});

test("native Relay preferences keep equal Space IDs distinct by origin", async () => {
	let body: unknown = null;
	const adapter = createNativeRelayRegistrationAdapter((async (
		_path: RequestInfo | URL,
		init?: RequestInit,
	) => {
		body = JSON.parse(String(init?.body));
		return new Response("{}", { status: 200 });
	}) as typeof fetch);
	const spaceId = "00000000-0000-4000-8000-000000000010";
	await adapter.putPreferences("00000000-0000-4000-8000-000000000001", {
		watchedSpaces: [
			{ spaceId, origin: "local" },
			{ spaceId, origin: "cloud" },
		],
		focus: {
			spaceId,
			origin: "cloud",
			sessionId: null,
			explicit: false,
		},
	});
	assert.deepEqual(body, {
		watchedSpaces: [
			{ spaceId, origin: "local" },
			{ spaceId, origin: "cloud" },
		],
		focus: {
			spaceId,
			origin: "cloud",
			sessionId: null,
			explicit: false,
		},
	});
});

test("native Relay preferences reject fields outside the exact contract", async () => {
	const adapter = createNativeRelayRegistrationAdapter(
		(async () => new Response("{}", { status: 200 })) as typeof fetch,
	);
	await assert.rejects(
		adapter.putPreferences("00000000-0000-4000-8000-000000000001", {
			watchedSpaces: [
				{
					spaceId: "00000000-0000-4000-8000-000000000010",
					origin: "local",
					name: "must not cross the boundary",
				} as never,
			],
			focus: null,
		}),
		/preferences are malformed/,
	);
});

test("preference registration keys coalesce unchanged state and refresh on demand", async () => {
	const preferences = {
		watchedSpaces: [
			{
				spaceId: "00000000-0000-4000-8000-000000000010",
				origin: "local" as const,
			},
		],
		focus: null,
	};
	const installationId = "00000000-0000-4000-8000-000000000001";
	const coordinator = new ProjectionRegistrationCoordinator({
		maxAttempts: 1,
		baseDelayMs: 0,
	});
	let puts = 0;
	const request = (force = false) =>
		coordinator.request({
			key: preferenceRegistrationKey(installationId, preferences),
			force,
			register: async () => {
				puts += 1;
			},
		});
	await Promise.all([request(), request()]);
	assert.equal(puts, 1);
	await request();
	assert.equal(puts, 1);
	await request(true);
	assert.equal(puts, 2);
});

test("preference installation identity accepts one stable native installation only", () => {
	const installationId = "00000000-0000-4000-8000-000000000001";
	assert.equal(
		resolvePreferenceInstallationId(
			{ installationId, environment: "development" },
			[
				{
					installationId,
					activityId: "00000000-0000-4000-8000-000000000002",
				},
			],
		),
		installationId,
	);
	assert.throws(
		() =>
			resolvePreferenceInstallationId(null, [
				{
					installationId,
					activityId: "00000000-0000-4000-8000-000000000002",
				},
				{
					installationId: "00000000-0000-4000-8000-000000000003",
					activityId: "00000000-0000-4000-8000-000000000004",
				},
			]),
		/installation identity is inconsistent/,
	);
});

test("native Relay device registration forwards the development environment", async () => {
	let body: unknown = null;
	const adapter = createNativeRelayRegistrationAdapter((async (
		_path: RequestInfo | URL,
		init?: RequestInit,
	) => {
		body = JSON.parse(String(init?.body));
		return new Response("{}", { status: 200 });
	}) as typeof fetch);
	await adapter.putDevice({
		installationId: "00000000-0000-4000-8000-000000000001",
		token: "ab".repeat(32),
		environment: "development",
	});
	assert.deepEqual(body, {
		token: "ab".repeat(32),
		environment: "development",
	});
});

test("missing and unknown native token environments are rejected as stale", () => {
	assert.deepEqual(resolveNativeTokenEventEnvironment(undefined), {
		accepted: false,
		environment: null,
		stale: true,
	});
	assert.deepEqual(resolveNativeTokenEventEnvironment("sandbox"), {
		accepted: false,
		environment: null,
		stale: true,
	});
	assert.deepEqual(resolveNativeTokenEventEnvironment("development"), {
		accepted: true,
		environment: "development",
		stale: false,
	});
	assert.deepEqual(resolveNativeTokenEventEnvironment("production"), {
		accepted: true,
		environment: "production",
		stale: false,
	});
	assert.equal(
		resolveNativeFreshness({
			online: true,
			connectionState: "open",
			reconciling: false,
			hasReconciled: true,
			reconcileFailed: resolveNativeTokenEventEnvironment(undefined).stale,
		}),
		"stale",
	);
});

test("native registration heartbeat refreshes online and stops its timer", async () => {
	type Scheduled = { callback: () => void; delayMs: number; handle: number };
	const scheduled: Scheduled[] = [];
	const cleared: number[] = [];
	let nextHandle = 1;
	const heartbeat = new NativeRegistrationHeartbeat({
		setTimeout: (callback, delayMs) => {
			const handle = nextHandle++;
			scheduled.push({ callback, delayMs, handle });
			return handle;
		},
		clearTimeout: (handle) => cleared.push(handle as number),
	});
	let eligible = true;
	let refreshes = 0;
	heartbeat.start({
		isEligible: () => eligible,
		refresh: async () => {
			refreshes += 1;
		},
	});
	assert.equal(scheduled[0]?.delayMs, NATIVE_REGISTRATION_HEARTBEAT_MS);
	scheduled.shift()?.callback();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(refreshes, 1);
	eligible = false;
	scheduled.shift()?.callback();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(refreshes, 1);
	const pending = scheduled[0];
	assert.ok(pending);
	heartbeat.stop();
	assert.deepEqual(cleared, [pending.handle]);
});

test("native Relay token validation rejects odd, short, and non-hex values", () => {
	assert.equal(isNativePushToken("ab".repeat(32)), true);
	assert.equal(isNativePushToken("ab".repeat(31)), false);
	assert.equal(isNativePushToken(`${"ab".repeat(32)}c`), false);
	assert.equal(isNativePushToken("zz".repeat(32)), false);
});

test("native Relay registration surfaces server failures without reading a body", async () => {
	let bodyRead = false;
	const adapter = createNativeRelayRegistrationAdapter((async () => {
		const response = new Response("sensitive", { status: 503 });
		const originalText = response.text.bind(response);
		response.text = async () => {
			bodyRead = true;
			return originalText();
		};
		return response;
	}) as typeof fetch);
	await assert.rejects(
		adapter.putDevice({
			installationId: "00000000-0000-4000-8000-000000000001",
			token: "ab".repeat(32),
			environment: "development",
		}),
		/registration failed \(503\)/,
	);
	assert.equal(bodyRead, false);
});
