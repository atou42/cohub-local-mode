import assert from "node:assert/strict";
import test from "node:test";
import { validateAlphaResourceConfig } from "./alpha-resource-guard-core.mjs";

const valid = `
name = "cohub-personal-node-alpha-dev"
[[routes]]
pattern = "dev-cohub.atou.cc/api/alpha/*"
pattern = "dev-cohub.atou.cc/healthz"
[[durable_objects.bindings]]
name = "ACCOUNTS"
class_name = "PersonalAccount"
[[durable_objects.bindings]]
name = "NODES"
class_name = "LocalNodeRelay"
[[queues.producers]]
binding = "COMMAND_WAKEUPS"
queue = "cohub-personal-node-alpha-dev-wakeups"
[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "cohub-personal-node-alpha-dev-attachments"
[vars]
ALLOWED_ORIGIN = "https://dev-cohub.atou.cc"
`;

const validWeb = `
name = "cohub-personal-node-alpha-web-dev"
[[routes]]
pattern = "dev-cohub.atou.cc"
custom_domain = true
[vars]
PUBLIC_COHUB_LOCAL_MODE = "true"
PUBLIC_PERSONAL_NODE_ALPHA = "true"
PUBLIC_API_ORIGIN = "https://dev-cohub.atou.cc"
`;

test("accepts the isolated Personal Node Alpha resources", () => {
	assert.deepEqual(validateAlphaResourceConfig(valid, validWeb), {
		worker: "cohub-personal-node-alpha-dev",
		webWorker: "cohub-personal-node-alpha-web-dev",
		origin: "https://dev-cohub.atou.cc",
	});
});

test("rejects every current production resource marker", () => {
	for (const marker of [
		'name = "cohub-local-relay"',
		'name = "cohub-local-web"',
		'pattern = "cohub.atou.cc/relay/*"',
		'pattern = "relay-node.atou.cc"',
		'queue = "cohub-local-relay-wakeups"',
		'bucket_name = "cohub-local-relay-attachments"',
		'NODE_ID = "mac-mini"',
		'OWNER_EMAIL = "owner@example.com"',
	]) {
		assert.throws(() =>
			validateAlphaResourceConfig(`${valid}\n${marker}\n`, validWeb),
		);
	}
});

test("rejects an incomplete development resource declaration", () => {
	assert.throws(
		() =>
			validateAlphaResourceConfig(
				valid.replace("dev-cohub.atou.cc", "other.example"),
				validWeb,
			),
		/missing/,
	);
});

test("rejects a production or incomplete Alpha Web deployment", () => {
	assert.throws(() =>
		validateAlphaResourceConfig(
			valid,
			validWeb.replace("cohub-personal-node-alpha-web-dev", "cohub-local-web"),
		),
	);
	assert.throws(() =>
		validateAlphaResourceConfig(
			valid,
			validWeb.replace('PUBLIC_PERSONAL_NODE_ALPHA = "true"', ""),
		),
	);
});
