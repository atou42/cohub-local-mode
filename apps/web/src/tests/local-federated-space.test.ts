import assert from "node:assert/strict";
import test from "node:test";
import {
	buildLocalFederatedPromptContext,
	buildLocalFederatedPromptEnv,
} from "../lib/local-federated-space";

test("points a Cloud turn at the federated API only for an explicit Local mention", () => {
	assert.deepEqual(
		buildLocalFederatedPromptEnv({
			useLocalRelay: false,
			relayEnabled: true,
			mentions: [{ origin: "local" }],
			apiUrl: "https://relay-node.atou.cc",
		}),
		{ COHUB_API_URL: "https://relay-node.atou.cc" },
	);
	for (const input of [
		{
			useLocalRelay: true,
			relayEnabled: true,
			mentions: [{ origin: "local" }],
		},
		{
			useLocalRelay: false,
			relayEnabled: false,
			mentions: [{ origin: "local" }],
		},
		{
			useLocalRelay: false,
			relayEnabled: true,
			mentions: [{ origin: "cloud" }],
		},
	]) {
		assert.equal(
			buildLocalFederatedPromptEnv({
				...input,
				apiUrl: "https://relay-node.atou.cc",
			}),
			null,
		);
	}
});

test("adds hidden runtime instructions for the exact mentioned Local targets", () => {
	const context = buildLocalFederatedPromptContext([
		{ origin: "local", spaceId: "local-space-1" },
		{ origin: "cloud", spaceId: "cloud-space" },
		{ origin: "local", spaceId: "local-space-1" },
		{ origin: "local", spaceId: "local-space-2" },
	]);
	assert.ok(context);
	assert.equal(context._meta.attachmentKind, "viewport");
	assert.deepEqual(context._meta.viewports, []);
	assert.match(context.text, /local-space-1, local-space-2/);
	assert.doesNotMatch(context.text, /cloud-space/);
	assert.match(context.text, /COHUB_EXECUTION_TOKEN/);
	assert.match(context.text, /do not use the installed `cohub` CLI/);
	assert.equal(
		buildLocalFederatedPromptContext([
			{ origin: "cloud", spaceId: "cloud-space" },
		]),
		null,
	);
});

test("rejects a federated API URL that is not a bare HTTPS origin", () => {
	for (const apiUrl of [
		"http://relay-node.atou.cc",
		"https://relay-node.atou.cc/api",
		"not-a-url",
	]) {
		assert.throws(() =>
			buildLocalFederatedPromptEnv({
				useLocalRelay: false,
				relayEnabled: true,
				mentions: [{ origin: "local" }],
				apiUrl,
			}),
		);
	}
});
