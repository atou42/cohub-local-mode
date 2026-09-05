import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateDev2ResourceConfig } from "./dev2-resource-guard-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const relayPath = resolve(repoRoot, "apps/local-relay/wrangler.dev2.json");
const webPath = resolve(repoRoot, "apps/web/wrangler.dev2.json");
const relaySource = readFileSync(relayPath, "utf8");
const webSource = readFileSync(webPath, "utf8");
const relayConfig = JSON.parse(relaySource);
const webConfig = JSON.parse(webSource);

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function sourcePair(relay = relayConfig, web = webConfig) {
	return [JSON.stringify(relay), JSON.stringify(web)];
}

test("accepts the exact isolated Dev2 resources", () => {
	assert.deepEqual(validateDev2ResourceConfig(relaySource, webSource), {
		worker: "cohub-personal-node-dev2-relay",
		webWorker: "cohub-personal-node-dev2-web",
		origin: "https://dev2-cohub.atou.cc",
	});
});

test("rejects old development and production hostnames", () => {
	for (const hostname of ["dev-cohub.atou.cc", "cohub.atou.cc", "other.example"]) {
		const relay = clone(relayConfig);
		const web = clone(webConfig);
		relay.routes[0].pattern = `${hostname}/api/alpha/*`;
		relay.vars.ALLOWED_ORIGIN = `https://${hostname}`;
		web.routes[0].pattern = hostname;
		web.vars.PUBLIC_API_ORIGIN = `https://${hostname}`;
		assert.throws(() => validateDev2ResourceConfig(...sourcePair(relay, web)), /must equal/);
	}
});

test("rejects non-Dev2 worker and storage resources", () => {
	for (const mutate of [
		(config) => {
			config.name = "cohub-local-relay";
		},
		(config) => {
			config.queues.producers[0].queue = "cohub-local-relay-wakeups";
		},
		(config) => {
			config.queues.consumers[0].queue = "cohub-personal-node-alpha-dev-wakeups";
		},
		(config) => {
			config.r2_buckets[0].bucket_name = "cohub-local-relay-attachments";
		},
	]) {
		const relay = clone(relayConfig);
		mutate(relay);
		assert.throws(() => validateDev2ResourceConfig(...sourcePair(relay)), /must equal/);
	}
});

test("rejects shared Durable Object namespaces and unknown bindings", () => {
	const sharedScript = clone(relayConfig);
	sharedScript.durable_objects.bindings[0].script_name = "cohub-local-relay";
	assert.throws(() => validateDev2ResourceConfig(...sourcePair(sharedScript)), /unknown key/);

	const namespace = clone(relayConfig);
	namespace.durable_objects.namespace_id = "production-namespace";
	assert.throws(() => validateDev2ResourceConfig(...sourcePair(namespace)), /unknown key/);

	const extraRoute = clone(relayConfig);
	extraRoute.routes.push({ pattern: "dev2-cohub.atou.cc/extra", zone_name: "atou.cc" });
	assert.throws(() => validateDev2ResourceConfig(...sourcePair(extraRoute)), /exactly two/);

	const extraBinding = clone(relayConfig);
	extraBinding.queues.producers.push({ binding: "UNKNOWN", queue: "unknown" });
	assert.throws(() => validateDev2ResourceConfig(...sourcePair(extraBinding)), /exactly one/);
});

test("rejects environment overrides, missing fields, and malformed JSON", () => {
	const environment = clone(relayConfig);
	environment.env = { test: { name: "cohub-personal-node-dev2-relay" } };
	assert.throws(() => validateDev2ResourceConfig(...sourcePair(environment)), /unknown key/);

	const missing = clone(relayConfig);
	delete missing.durable_objects;
	assert.throws(() => validateDev2ResourceConfig(...sourcePair(missing)), /missing required key/);

	assert.throws(() => validateDev2ResourceConfig("{", webSource));
	assert.throws(() => validateDev2ResourceConfig(relaySource, "[]"), /web must be a JSON object/);
	assert.throws(() => validateDev2ResourceConfig(relaySource, ""));
});

test("rejects extra route fields and production web bindings", () => {
	const web = clone(webConfig);
	web.routes[0].service = "cohub-web";
	assert.throws(() => validateDev2ResourceConfig(relaySource, JSON.stringify(web)), /unknown key/);

	const relay = clone(relayConfig);
	relay.durable_objects.bindings.push({ name: "PRODUCTION", class_name: "LocalNodeRelay" });
	assert.throws(() => validateDev2ResourceConfig(JSON.stringify(relay), webSource), /exactly two/);
});
