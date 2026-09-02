import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPersonalNodeApiCommand,
	buildPersonalNodeReadCommand,
	isPersonalNodeCommandTerminal,
	personalNodeCommandResponse,
	personalNodeProjectionResponse,
	selectPersonalNodeDevice,
} from "$lib/personal-node-transport-core";

const firstId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const secondId = "669526bb-bf65-4013-a825-4f61adf199f8";

test("selects an active preferred Personal Node and ignores revoked devices", () => {
	const devices = [
		{
			id: firstId,
			displayName: "Old Mac",
			status: "active" as const,
			updatedAt: "2026-09-01T00:00:00.000Z",
		},
		{
			id: secondId,
			displayName: "New Mac",
			status: "active" as const,
			updatedAt: "2026-09-02T00:00:00.000Z",
		},
		{
			id: crypto.randomUUID(),
			displayName: "Revoked Mac",
			status: "revoked" as const,
		},
	];
	assert.equal(selectPersonalNodeDevice(devices, firstId)?.id, firstId);
	assert.equal(selectPersonalNodeDevice(devices, null)?.id, secondId);
	assert.equal(
		selectPersonalNodeDevice(
			devices.map((device) => ({ ...device, status: "revoked" as const })),
			null,
		),
		null,
	);
});

test("marks cached Cloudflare projections without changing Local API bytes", async () => {
	const response = personalNodeProjectionResponse({
		path: "/api/spaces",
		result: {
			status: 200,
			headers: { "content-type": "application/json" },
			body: '[{"id":"space-1"}]',
		},
		updatedAt: "2026-09-02T00:00:00.000Z",
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("x-cohub-personal-node-cache"), "hit");
	assert.equal(
		response.headers.get("x-cohub-personal-node-cache-updated-at"),
		"2026-09-02T00:00:00.000Z",
	);
	assert.deepEqual(await response.json(), [{ id: "space-1" }]);
});

test("builds an idempotent read command without forwarding browser headers", () => {
	const command = buildPersonalNodeReadCommand("/api/models?harness=cursor");
	assert.match(command.idempotencyKey, /^[0-9a-f-]{36}$/);
	assert.deepEqual(command.request, {
		method: "GET",
		path: "/api/models?harness=cursor",
		headers: {},
		body: "",
	});
	assert.throws(() =>
		buildPersonalNodeReadCommand("https://attacker.example/api/models"),
	);
});

test("builds mutation commands without forwarding browser credentials", () => {
	const command = buildPersonalNodeApiCommand({
		method: "PATCH",
		path: `/api/sessions/${firstId}`,
		body: '{"title":"Renamed"}',
	});
	assert.equal(command.request.method, "PATCH");
	assert.equal(command.request.path, `/api/sessions/${firstId}`);
	assert.deepEqual(command.request.headers, {});
	assert.equal(command.request.body, '{"title":"Renamed"}');
});

test("restores exact Local API responses and exposes terminal relay failures", async () => {
	const success = personalNodeCommandResponse({
		id: "command-1",
		status: "succeeded",
		result: {
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"models":[]}',
		},
		errorCode: null,
		errorMessage: null,
	});
	assert.equal(success.status, 200);
	assert.deepEqual(await success.json(), { models: [] });
	const failedCommand = {
		id: "command-2",
		status: "failed" as const,
		result: null,
		errorCode: "local_api_unavailable",
		errorMessage: "Local API is unavailable",
	};
	assert.equal(isPersonalNodeCommandTerminal(failedCommand), true);
	const failure = personalNodeCommandResponse(failedCommand);
	assert.equal(failure.status, 502);
	assert.deepEqual(await failure.json(), {
		code: "local_api_unavailable",
		message: "Local API is unavailable",
	});
});
