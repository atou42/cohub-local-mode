import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDeviceRegistration } from "./registration-state.ts";

async function fixture() {
	const userDataPath = await mkdtemp(join(tmpdir(), "cohub-registration-"));
	const credentials = new Map<string, string>();
	return {
		userDataPath, accountId: "a".repeat(64), existing: null,
		readCredential: async (id: string) => {
			const value = credentials.get(id);
			if (!value) throw new Error("Credential missing");
			return value;
		},
		writeCredential: async (id: string, value: string) => { credentials.set(id, value); },
	};
}

test("registration retry after a lost response reuses its saved identity and credential", async () => {
	const options = await fixture();
	const first = await prepareDeviceRegistration(options);
	assert.equal(await options.readCredential(first.installationId), first.credential);
	// No successful personal-node.json exists after a lost server response or restart.
	const retried = await prepareDeviceRegistration({ ...options });
	assert.deepEqual(retried, first);
	const pending = await readFile(join(options.userDataPath, "pending-registration.json"), "utf8");
	assert.ok(!pending.includes(first.credential));
	await assert.rejects(prepareDeviceRegistration({ ...options, accountId: "b".repeat(64) }), /another account/);
	assert.equal(await readFile(join(options.userDataPath, "pending-registration.json"), "utf8"), pending);
});

test("a corrupt pending identity is not replaced with a new device", async () => {
	const options = await fixture();
	const path = join(options.userDataPath, "pending-registration.json");
	await writeFile(path, "broken state");
	await assert.rejects(prepareDeviceRegistration(options), /pending registration/i);
	assert.equal(await readFile(path, "utf8"), "broken state");
});

test("registered devices retain their identity and missing credentials are not regenerated", async () => {
	const options = await fixture();
	const existing = { accountId: options.accountId, installationId: "11111111-1111-4111-8111-111111111111" };
	await assert.rejects(prepareDeviceRegistration({ ...options, existing }), /Credential missing/);
	await options.writeCredential(existing.installationId, "existing credential");
	assert.deepEqual(await prepareDeviceRegistration({ ...options, existing }), {
		installationId: existing.installationId, credential: "existing credential",
	});
});
