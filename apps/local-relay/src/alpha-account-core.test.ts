import assert from "node:assert/strict";
import test from "node:test";
import {
	alphaDeviceCredentialMatches,
	createAlphaDeviceRecord,
	parseAlphaDeviceRegistration,
	publicAlphaDevice,
	revokeAlphaDevice,
	rotateAlphaDeviceCredential,
	updateAlphaDeviceRegistration,
} from "./alpha-account-core.ts";
import { RelayProtocolError } from "./protocol.ts";

const installationId = "3bb14c9d-7c86-47eb-88ef-e8db2acd4875";
const deviceId = "669526bb-bf65-4013-a825-4f61adf199f8";
const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);

function registration() {
	return parseAlphaDeviceRegistration({
		installationId,
		displayName: "  Atou's Mac mini  ",
		platform: "macos",
		appVersion: "0.1.0",
		credentialHash: firstHash.toUpperCase(),
	});
}

test("parses a macOS registration and exposes no credential hash", () => {
	const parsed = registration();
	assert.deepEqual(parsed, {
		installationId,
		displayName: "Atou's Mac mini",
		platform: "macos",
		appVersion: "0.1.0",
		credentialHash: firstHash,
	});
	const device = createAlphaDeviceRecord({
		registration: parsed,
		deviceId,
		now: "2026-09-02T00:00:00.000Z",
	});
	assert.equal(device.status, "active");
	assert.equal("credentialHash" in publicAlphaDevice(device), false);
	assert.equal(alphaDeviceCredentialMatches(device, firstHash), true);
	assert.equal(alphaDeviceCredentialMatches(device, secondHash), false);
});

test("rejects unsupported platforms and malformed registration identity", () => {
	for (const input of [
		{
			installationId: "not-a-uuid",
			displayName: "Mac",
			platform: "macos",
			credentialHash: firstHash,
		},
		{
			installationId,
			displayName: "Mac",
			platform: "windows",
			credentialHash: firstHash,
		},
		{
			installationId,
			displayName: "Mac",
			platform: "macos",
			credentialHash: "bad",
		},
	]) {
		assert.throws(
			() => parseAlphaDeviceRegistration(input),
			(error: unknown) => error instanceof RelayProtocolError,
		);
	}
});

test("registration is idempotent only for the same credential", () => {
	const existing = createAlphaDeviceRecord({
		registration: registration(),
		deviceId,
		now: "2026-09-02T00:00:00.000Z",
	});
	const updated = updateAlphaDeviceRegistration({
		existing,
		registration: { ...registration(), displayName: "Renamed Mac" },
		now: "2026-09-02T00:01:00.000Z",
	});
	assert.equal(updated.id, existing.id);
	assert.equal(updated.displayName, "Renamed Mac");
	assert.throws(
		() =>
			updateAlphaDeviceRegistration({
				existing,
				registration: { ...registration(), credentialHash: secondHash },
				now: "2026-09-02T00:01:00.000Z",
			}),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "alpha_device_credential_conflict",
	);
});
test("credential rotation and revocation fail closed", () => {
	const existing = createAlphaDeviceRecord({
		registration: registration(),
		deviceId,
		now: "2026-09-02T00:00:00.000Z",
	});
	const rotated = rotateAlphaDeviceCredential({
		existing,
		credentialHash: secondHash,
		now: "2026-09-02T00:01:00.000Z",
	});
	assert.equal(alphaDeviceCredentialMatches(rotated, firstHash), false);
	assert.equal(alphaDeviceCredentialMatches(rotated, secondHash), true);
	const revoked = revokeAlphaDevice(rotated, "2026-09-02T00:02:00.000Z");
	assert.equal(revoked.status, "revoked");
	assert.equal(alphaDeviceCredentialMatches(revoked, secondHash), false);
	assert.throws(
		() =>
			rotateAlphaDeviceCredential({
				existing: revoked,
				credentialHash: firstHash,
				now: "2026-09-02T00:03:00.000Z",
			}),
		(error: unknown) =>
			error instanceof RelayProtocolError &&
			error.code === "alpha_device_revoked",
	);
});
