import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeGroupOwner, parseRuntimeOwner, processFingerprints, processGroupPids, type RuntimeOwner } from "./runtime-owner.ts";

const owner: RuntimeOwner = {
	schemaVersion: 3, pid: 120, startedAt: "2026-09-06T06:00:00Z", processFingerprint: "manager original",
	members: [{ pid: 121, processFingerprint: "database original" }],
};

test("a surviving recorded member identifies the group without its leader", () => {
	assertRuntimeGroupOwner(owner, [{ pid: 121, processFingerprint: "database original" }, { pid: 130, processFingerprint: "new worker" }]);
});

test("a reused PID, a different group, and an unrecorded survivor never establish ownership", () => {
	assert.throws(() => assertRuntimeGroupOwner(owner, [{ pid: 121, processFingerprint: "another process" }]), /refusing/);
	assert.throws(() => assertRuntimeGroupOwner(owner, [{ pid: 140, processFingerprint: "database original" }]), /refusing/);
	assert.throws(() => assertRuntimeGroupOwner(owner, []), /refusing/);
	assert.throws(() => assertRuntimeGroupOwner(owner, [{ pid: 121, processFingerprint: "database original" }, { pid: 120, processFingerprint: "reused leader" }]), /refusing/);
});

test("legacy records still require the original live leader and invalid files stay invalid", () => {
	const legacy = { ...owner, schemaVersion: 2 as const, members: undefined };
	assert.equal(parseRuntimeOwner(legacy), legacy);
	assertRuntimeGroupOwner(legacy, [{ pid: 120, processFingerprint: "manager original" }]);
	assert.throws(() => assertRuntimeGroupOwner(legacy, owner.members!), /refusing/);
	for (const invalid of [null, {}, { ...owner, startedAt: "bad date" }, { ...owner, members: null }, { ...owner, pid: 1 }, { ...owner, members: [owner.members![0], owner.members![0]] }]) {
		assert.throws(() => parseRuntimeOwner(invalid), /invalid/);
	}
});

test("process snapshots restrict membership and preserve exact process fingerprints", () => {
	assert.deepEqual(processGroupPids(" 120 120\n 121 120\n 140 140\n", 120), [120, 121]);
	assert.deepEqual(processFingerprints(" 121 Sun Sep  6 14:14:08 2026     node /a path/manager.mjs\n"), [
		{ pid: 121, processFingerprint: "Sun Sep  6 14:14:08 2026     node /a path/manager.mjs" },
	]);
	assert.throws(() => processGroupPids("unexpected output", 120), /Cannot parse/);
	assert.throws(() => processFingerprints("bad output"), /Cannot parse/);
});
