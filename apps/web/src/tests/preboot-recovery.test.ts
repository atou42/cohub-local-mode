import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

type Listener = (event?: Record<string, unknown>) => void;

async function createHarness(initialStorage: Record<string, string> = {}) {
	const source = await readFile(
		new URL("../../static/preboot-recovery.js", import.meta.url),
		"utf8",
	);
	const listeners = new Map<string, Listener[]>();
	const values = new Map(Object.entries(initialStorage));
	const rendered: Array<{ tagName: string; textContent: string }> = [];
	let replaces = 0;
	let updates = 0;
	let skipWaitingMessages = 0;

	const addEventListener = (type: string, listener: Listener) => {
		listeners.set(type, [...(listeners.get(type) ?? []), listener]);
	};
	const document = {
		readyState: "complete",
		visibilityState: "visible",
		documentElement: {
			removeAttribute() {},
			setAttribute() {},
		},
		body: {
			replaceChildren(node: { tagName: string; textContent: string }) {
				rendered.push(node);
			},
		},
		addEventListener,
		createElement(tagName: string) {
			return {
				tagName,
				textContent: "",
				style: {},
				append(...children: Array<{ textContent?: string }>) {
					this.textContent += children
						.map((child) => child.textContent ?? "")
						.join("");
				},
				addEventListener() {},
			};
		},
	};
	const location = {
		href: "https://cohub.test/spaces/test",
		origin: "https://cohub.test",
		replace() {
			replaces += 1;
		},
	};
	const emit = (type: string, event: Record<string, unknown> = {}) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	const registration = {
		waiting: {
			postMessage(message: { type?: string }) {
				if (message.type === "SKIP_WAITING") skipWaitingMessages += 1;
				emit("controllerchange");
			},
		},
		async update() {
			updates += 1;
		},
	};
	const context = {
		console: { error() {} },
		document,
		location,
		navigator: {
			serviceWorker: {
				controller: {},
				addEventListener,
				async getRegistration() {
					return registration;
				},
			},
		},
		sessionStorage: {
			getItem(key: string) {
				return values.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				values.set(key, value);
			},
			removeItem(key: string) {
				values.delete(key);
			},
		},
		setTimeout() {
			return 1;
		},
		clearTimeout() {},
		addEventListener,
		URL,
	};
	Object.assign(context, { window: context, globalThis: context });
	vm.runInNewContext(source, context);

	return {
		api: (
			context as unknown as {
				__cohubPrebootRecovery: {
					reportFailure(reason: unknown): Promise<void>;
					markHealthy(): void;
				};
			}
		).__cohubPrebootRecovery,
		values,
		rendered,
		get replaces() {
			return replaces;
		},
		get updates() {
			return updates;
		},
		get skipWaitingMessages() {
			return skipWaitingMessages;
		},
		emit(type: string, event: Record<string, unknown>) {
			emit(type, event);
		},
	};
}

test("the first boot failure updates the worker and replaces the page once", async () => {
	const harness = await createHarness();

	await harness.api.reportFailure(
		new Error("Failed to fetch dynamically imported module"),
	);
	await harness.api.reportFailure(
		new Error("Failed to fetch dynamically imported module"),
	);

	assert.equal(harness.updates, 1);
	assert.equal(harness.replaces, 1);
	assert.equal(harness.skipWaitingMessages, 1);
	assert.equal(harness.values.get("cohub:preboot-recovery-attempted"), "1");
});

test("a second boot failure renders a framework-free recovery state", async () => {
	const harness = await createHarness({
		"cohub:preboot-recovery-attempted": "1",
	});

	await harness.api.reportFailure("script failed");

	assert.equal(harness.replaces, 0);
	assert.equal(harness.rendered.length, 1);
	assert.match(harness.rendered[0]?.textContent ?? "", /Cohub could not start/);
});

test("an empty script error still starts recovery from its target URL", async () => {
	const harness = await createHarness();
	let prevented = false;

	harness.emit("error", {
		target: {
			tagName: "SCRIPT",
			src: "https://cohub.test/_app/immutable/entry/start.stale.js",
		},
		preventDefault() {
			prevented = true;
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(prevented, true);
	assert.equal(harness.replaces, 1);
});

test("third-party scripts and Space styles never trigger client recovery", async () => {
	const harness = await createHarness();

	harness.emit("error", {
		target: {
			tagName: "SCRIPT",
			src: "https://connect.facebook.net/en_US/fbevents.js",
		},
		preventDefault() {
			throw new Error("unrelated resource errors must not be intercepted");
		},
	});
	harness.emit("error", {
		target: {
			tagName: "LINK",
			rel: "stylesheet",
			href: "https://cohub.test/api/spaces/test/style.css",
		},
		preventDefault() {
			throw new Error("unrelated resource errors must not be intercepted");
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(harness.replaces, 0);
	assert.equal(harness.rendered.length, 0);
	assert.equal(harness.values.has("cohub:preboot-recovery-attempted"), false);
});

test("a generic network Load failed rejection never reloads a healthy page", async () => {
	const harness = await createHarness();
	harness.api.markHealthy();

	harness.emit("unhandledrejection", {
		reason: new Error("Load failed"),
		preventDefault() {
			throw new Error("ordinary network errors must not be intercepted");
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(harness.replaces, 0);
	assert.equal(harness.rendered.length, 0);
});

test("a healthy mount clears only recovery markers", async () => {
	const harness = await createHarness({
		"cohub:preboot-recovery-attempted": "1",
		"cohub:failed-dynamic-import": "/_app/immutable/nodes/stale.js",
		"cohub:server-error-recovery": "1",
		cohub_token: "keep-auth",
		"cohub:draft": "keep-draft",
	});

	harness.api.markHealthy();

	assert.deepEqual(Object.fromEntries(harness.values), {
		cohub_token: "keep-auth",
		"cohub:draft": "keep-draft",
	});

	await harness.api.reportFailure("a later route chunk failed");
	assert.equal(harness.replaces, 1);
	assert.equal(harness.values.get("cohub_token"), "keep-auth");
	assert.equal(harness.values.get("cohub:draft"), "keep-draft");
});
