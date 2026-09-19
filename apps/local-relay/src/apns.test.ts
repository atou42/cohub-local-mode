import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { importSPKI, jwtVerify } from "jose";
import { buildActivityPushPayload, classifyApnsResponse } from "./activity.ts";
import {
	apnsHost,
	ApnsConfigurationError,
	createApnsProviderToken,
	parseApnsRetryAfter,
	sendActivityPush,
	validateApnsConfig,
} from "./apns.ts";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
	namedCurve: "P-256",
});
const config = validateApnsConfig({
	teamId: "TEAM123456",
	keyId: "KEY1234567",
	privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	environment: "development",
	topic: "cc.atou.cohub.push-type.liveactivity",
	attributesType: "CohubAgentPulseAttributes",
});
const payload = buildActivityPushPayload(
	{
		id: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
		kind: "turn.lifecycle",
		nodeId: "mac-mini",
		origin: "local",
		spaceId: "2f4cb274-7f80-4a4b-b326-22d4af6a9873",
		sessionId: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02",
		turnId: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
		status: "running",
		observedAt: "2026-08-31T10:00:00.000Z",
		spaceName: "Local Mac",
		sessionTitle: "Ship Agent Pulse",
	},
	1,
	120,
);

test("creates a verifiable ES256 APNs provider JWT", async () => {
	const nowMs = Date.parse("2026-08-31T10:00:00.000Z");
	const token = await createApnsProviderToken(config, nowMs);
	const verificationKey = await importSPKI(
		publicKey.export({ type: "spki", format: "pem" }).toString(),
		"ES256",
	);
	const verified = await jwtVerify(token, verificationKey, { algorithms: ["ES256"] });
	assert.equal(verified.payload.iss, config.teamId);
	assert.equal(verified.payload.iat, Math.floor(nowMs / 1_000));
	assert.equal(verified.protectedHeader.kid, config.keyId);
});

test("uses explicit APNs hosts, fixed liveactivity headers, and exact payload", async () => {
	assert.equal(apnsHost("development"), "https://api.sandbox.push.apple.com");
	assert.equal(apnsHost("production"), "https://api.push.apple.com");
	const requests: Array<{ url: string; init: RequestInit }> = [];
	const result = await sendActivityPush({
		config,
		deviceToken: "ab".repeat(32),
		payload,
		providerToken: "provider-jwt",
		apnsRequestId: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
		fetcher: async (url, init) => {
			requests.push({ url: String(url), init: init ?? {} });
			return new Response(null, { status: 200, headers: { "apns-id": "push-id" } });
		},
	});
	assert.equal(result.disposition, "delivered");
	const request = requests[0];
	assert.ok(request);
	assert.equal(request.url, `${apnsHost("development")}/3/device/${"ab".repeat(32)}`);
	const headers = new Headers(request.init.headers);
	assert.equal(headers.get("apns-push-type"), "liveactivity");
	assert.equal(headers.get("apns-topic"), config.topic);
	assert.equal(headers.get("authorization"), "bearer provider-jwt");
	assert.equal(headers.get("apns-id"), "3bb14c9d-7c86-47eb-88ef-e8db2acd4875");
	assert.deepEqual(JSON.parse(String(request.init.body)), payload);
});

test("classifies APNs invalidation, deployment, and retry responses", () => {
	assert.equal(classifyApnsResponse(400, "BadDeviceToken"), "invalidate_registration");
	assert.equal(classifyApnsResponse(400, "BadTopic"), "invalidate_registration");
	assert.equal(classifyApnsResponse(410, "Unregistered"), "invalidate_registration");
	assert.equal(classifyApnsResponse(403, "InvalidProviderToken"), "deployment_failure");
	assert.equal(classifyApnsResponse(429, "TooManyRequests"), "retry");
	assert.equal(classifyApnsResponse(500, "InternalServerError"), "retry");
});

test("parses Retry-After seconds and HTTP dates", () => {
	const nowMs = Date.parse("2026-08-31T10:00:00.000Z");
	assert.equal(parseApnsRetryAfter("12", nowMs), 12_000);
	assert.equal(parseApnsRetryAfter("Mon, 31 Aug 2026 10:00:30 GMT", nowMs), 30_000);
	assert.equal(parseApnsRetryAfter("invalid", nowMs), null);
});

test("missing APNs secret and invalid environment are explicit configuration errors", () => {
	assert.throws(
		() => validateApnsConfig({ ...config, privateKey: "" }),
		(error: unknown) =>
			error instanceof ApnsConfigurationError && error.message.includes("privateKey"),
	);
	assert.throws(
		() => validateApnsConfig({ ...config, environment: "staging" as never }),
		(error: unknown) => error instanceof ApnsConfigurationError,
	);
});
