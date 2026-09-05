const DEV2_ORIGIN = "https://dev2-cohub.atou.cc";
const DEV2_HOST = "dev2-cohub.atou.cc";
const DEV2_RELAY_WORKER = "cohub-personal-node-dev2-relay";
const DEV2_WEB_WORKER = "cohub-personal-node-dev2-web";
const DEV2_QUEUE = "cohub-personal-node-dev2-wakeups";
const DEV2_BUCKET = "cohub-personal-node-dev2-attachments";

const RELAY_ALLOWED_KEYS = [
	"$schema",
	"name",
	"main",
	"compatibility_date",
	"compatibility_flags",
	"workers_dev",
	"routes",
	"observability",
	"durable_objects",
	"migrations",
	"queues",
	"r2_buckets",
	"vars",
];
const RELAY_REQUIRED_KEYS = RELAY_ALLOWED_KEYS.filter((key) => key !== "$schema");
const WEB_ALLOWED_KEYS = [
	"$schema",
	"name",
	"main",
	"compatibility_date",
	"compatibility_flags",
	"workers_dev",
	"assets",
	"vars",
	"routes",
];
const WEB_REQUIRED_KEYS = WEB_ALLOWED_KEYS.filter((key) => key !== "$schema");

const RELAY_VAR_VALUES = {
	ALLOWED_ORIGIN: DEV2_ORIGIN,
	LOGTO_ENDPOINT: "https://auth.neta.art",
	LOGTO_API_RESOURCE: "https://api.talesofai",
	COMMAND_LEASE_MS: "60000",
	COMMAND_MAX_BODY_BYTES: "1048576",
	ATTACHMENT_MAX_BYTES: "104857600",
	ATTACHMENT_TTL_MS: "604800000",
	ACTIVITY_STALE_SECONDS: "120",
	ACTIVITY_REGISTRATION_TTL_SECONDS: "86400",
};
const WEB_VAR_VALUES = {
	PUBLIC_COHUB_LOCAL_MODE: "true",
	PUBLIC_PERSONAL_NODE_ALPHA: "true",
	PUBLIC_API_ORIGIN: DEV2_ORIGIN,
	PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
	PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
	PUBLIC_LOCAL_RELAY_ENABLED: "true",
	PUBLIC_LOGTO_ENDPOINT: "https://auth.neta.art",
	PUBLIC_LOGTO_API_RESOURCE: "https://api.talesofai",
};

function hasOwn(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function assertRecord(value, path) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be a JSON object`);
	}
}

function assertKeys(value, allowed, required, path) {
	assertRecord(value, path);
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			throw new Error(`${path} contains unknown key: ${key}`);
		}
	}
	for (const key of required) {
		if (!hasOwn(value, key)) {
			throw new Error(`${path} is missing required key: ${key}`);
		}
	}
}

function assertString(value, path) {
	if (typeof value !== "string") {
		throw new Error(`${path} must be a string`);
	}
}

function assertBoolean(value, path) {
	if (typeof value !== "boolean") {
		throw new Error(`${path} must be a boolean`);
	}
}

function assertNumber(value, path) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must be a finite number`);
	}
}

function assertExactString(value, expected, path) {
	assertString(value, path);
	if (value !== expected) {
		throw new Error(`${path} must equal ${expected}`);
	}
}

function assertExactBoolean(value, expected, path) {
	assertBoolean(value, path);
	if (value !== expected) {
		throw new Error(`${path} must equal ${expected}`);
	}
}

function assertExactNumber(value, expected, path) {
	assertNumber(value, path);
	if (value !== expected) {
		throw new Error(`${path} must equal ${expected}`);
	}
}

function assertExactStringArray(value, expected, path) {
	if (!Array.isArray(value) || value.length !== expected.length) {
		throw new Error(`${path} must contain exactly ${expected.length} string(s)`);
	}
	for (let index = 0; index < expected.length; index += 1) {
		assertExactString(value[index], expected[index], `${path}[${index}]`);
	}
}

function assertOptionalSchema(value, path) {
	if (hasOwn(value, "$schema")) {
		assertString(value.$schema, `${path}.$schema`);
	}
}

function assertVars(value, expected, path) {
	const keys = Object.keys(expected);
	assertKeys(value, keys, keys, path);
	for (const [key, expectedValue] of Object.entries(expected)) {
		assertExactString(value[key], expectedValue, `${path}.${key}`);
	}
}

function assertRelayRoutes(value) {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error("relay.routes must contain exactly two routes");
	}
	const expectedPatterns = [
		`${DEV2_HOST}/api/alpha/*`,
		`${DEV2_HOST}/healthz`,
	];
	for (let index = 0; index < value.length; index += 1) {
		const route = value[index];
		assertKeys(route, ["pattern", "zone_name"], ["pattern", "zone_name"], `relay.routes[${index}]`);
		assertExactString(route.pattern, expectedPatterns[index], `relay.routes[${index}].pattern`);
		assertExactString(route.zone_name, "atou.cc", `relay.routes[${index}].zone_name`);
	}
}

function assertWebRoutes(value) {
	if (!Array.isArray(value) || value.length !== 1) {
		throw new Error("web.routes must contain exactly one route");
	}
	const route = value[0];
	assertKeys(route, ["pattern", "custom_domain"], ["pattern", "custom_domain"], "web.routes[0]");
	assertExactString(route.pattern, DEV2_HOST, "web.routes[0].pattern");
	assertExactBoolean(route.custom_domain, true, "web.routes[0].custom_domain");
}

function assertDurableObjects(value) {
	assertKeys(value, ["bindings"], ["bindings"], "relay.durable_objects");
	if (!Array.isArray(value.bindings) || value.bindings.length !== 2) {
		throw new Error("relay.durable_objects.bindings must contain exactly two bindings");
	}
	const expected = [
		["ACCOUNTS", "PersonalAccount"],
		["NODES", "LocalNodeRelay"],
	];
	for (let index = 0; index < expected.length; index += 1) {
		const binding = value.bindings[index];
		const path = `relay.durable_objects.bindings[${index}]`;
		assertKeys(binding, ["name", "class_name"], ["name", "class_name"], path);
		assertExactString(binding.name, expected[index][0], `${path}.name`);
		assertExactString(binding.class_name, expected[index][1], `${path}.class_name`);
	}
}

function assertMigrations(value) {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error("relay.migrations must contain exactly two migrations");
	}
	const expected = [
		["dev2-v1", "PersonalAccount"],
		["dev2-v2", "LocalNodeRelay"],
	];
	for (let index = 0; index < expected.length; index += 1) {
		const migration = value[index];
		const path = `relay.migrations[${index}]`;
		assertKeys(migration, ["tag", "new_sqlite_classes"], ["tag", "new_sqlite_classes"], path);
		assertExactString(migration.tag, expected[index][0], `${path}.tag`);
		assertExactStringArray(migration.new_sqlite_classes, [expected[index][1]], `${path}.new_sqlite_classes`);
	}
}

function assertQueues(value) {
	assertKeys(value, ["producers", "consumers"], ["producers", "consumers"], "relay.queues");
	if (!Array.isArray(value.producers) || value.producers.length !== 1) {
		throw new Error("relay.queues.producers must contain exactly one producer");
	}
	const producer = value.producers[0];
	assertKeys(producer, ["binding", "queue"], ["binding", "queue"], "relay.queues.producers[0]");
	assertExactString(producer.binding, "COMMAND_WAKEUPS", "relay.queues.producers[0].binding");
	assertExactString(producer.queue, DEV2_QUEUE, "relay.queues.producers[0].queue");

	if (!Array.isArray(value.consumers) || value.consumers.length !== 1) {
		throw new Error("relay.queues.consumers must contain exactly one consumer");
	}
	const consumer = value.consumers[0];
	const consumerPath = "relay.queues.consumers[0]";
	assertKeys(
		consumer,
		["queue", "max_batch_size", "max_batch_timeout", "max_retries"],
		["queue", "max_batch_size", "max_batch_timeout", "max_retries"],
		consumerPath,
	);
	assertExactString(consumer.queue, DEV2_QUEUE, `${consumerPath}.queue`);
	assertExactNumber(consumer.max_batch_size, 10, `${consumerPath}.max_batch_size`);
	assertExactNumber(consumer.max_batch_timeout, 1, `${consumerPath}.max_batch_timeout`);
	assertExactNumber(consumer.max_retries, 5, `${consumerPath}.max_retries`);
}

function assertR2Buckets(value) {
	if (!Array.isArray(value) || value.length !== 1) {
		throw new Error("relay.r2_buckets must contain exactly one bucket");
	}
	const bucket = value[0];
	assertKeys(bucket, ["binding", "bucket_name"], ["binding", "bucket_name"], "relay.r2_buckets[0]");
	assertExactString(bucket.binding, "ATTACHMENTS", "relay.r2_buckets[0].binding");
	assertExactString(bucket.bucket_name, DEV2_BUCKET, "relay.r2_buckets[0].bucket_name");
}

function validateRelay(config) {
	assertKeys(config, RELAY_ALLOWED_KEYS, RELAY_REQUIRED_KEYS, "relay");
	assertOptionalSchema(config, "relay");
	assertExactString(config.name, DEV2_RELAY_WORKER, "relay.name");
	assertExactString(config.main, "src/alpha.ts", "relay.main");
	assertExactString(config.compatibility_date, "2026-08-25", "relay.compatibility_date");
	assertExactStringArray(config.compatibility_flags, ["nodejs_compat"], "relay.compatibility_flags");
	assertExactBoolean(config.workers_dev, true, "relay.workers_dev");
	assertRelayRoutes(config.routes);
	assertKeys(config.observability, ["enabled"], ["enabled"], "relay.observability");
	assertExactBoolean(config.observability.enabled, true, "relay.observability.enabled");
	assertDurableObjects(config.durable_objects);
	assertMigrations(config.migrations);
	assertQueues(config.queues);
	assertR2Buckets(config.r2_buckets);
	assertVars(config.vars, RELAY_VAR_VALUES, "relay.vars");
}

function validateWeb(config) {
	assertKeys(config, WEB_ALLOWED_KEYS, WEB_REQUIRED_KEYS, "web");
	assertOptionalSchema(config, "web");
	assertExactString(config.name, DEV2_WEB_WORKER, "web.name");
	assertExactString(config.main, "worker.local-mode.js", "web.main");
	assertExactString(config.compatibility_date, "2026-08-25", "web.compatibility_date");
	assertExactStringArray(config.compatibility_flags, ["nodejs_compat"], "web.compatibility_flags");
	assertExactBoolean(config.workers_dev, true, "web.workers_dev");
	assertKeys(config.assets, ["directory", "binding"], ["directory", "binding"], "web.assets");
	assertExactString(config.assets.directory, ".svelte-kit/cloudflare/assets", "web.assets.directory");
	assertExactString(config.assets.binding, "ASSETS", "web.assets.binding");
	assertVars(config.vars, WEB_VAR_VALUES, "web.vars");
	assertWebRoutes(config.routes);
}

function parseJson(source, label) {
	if (typeof source !== "string") {
		throw new TypeError(`${label} must be JSON text`);
	}
	return JSON.parse(source);
}

export function validateDev2ResourceConfig(source, webSource) {
	const relayConfig = parseJson(source, "Dev2 relay Cloudflare configuration");
	const webConfig = parseJson(webSource, "Dev2 web Cloudflare configuration");
	validateRelay(relayConfig);
	validateWeb(webConfig);
	return {
		worker: DEV2_RELAY_WORKER,
		webWorker: DEV2_WEB_WORKER,
		origin: DEV2_ORIGIN,
	};
}
