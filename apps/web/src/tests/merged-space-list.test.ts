import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceRecord } from "@neta-art/cohub";
import { listMergedSpaces, PartialSpaceListError } from "../lib/merged-space-list.ts";
import { getRegisteredSpaceOrigin } from "../lib/space-origin.ts";

const space = (id: string) => ({ id, name: id }) as SpaceRecord;

test("both healthy sources are tagged and registered", async () => {
	const result = await listMergedSpaces(async () => [space("healthy-local")], async () => [space("healthy-cloud")]);
	assert.deepEqual(result.map(({ id, origin }) => [id, origin]), [["healthy-local", "local"], ["healthy-cloud", "cloud"]]);
});

for (const failingOrigin of ["local", "cloud"] as const) {
	test(`${failingOrigin} failure retains the healthy list and original error`, async () => {
		const failure = new Error(`${failingOrigin} unavailable`);
		const healthyOrigin = failingOrigin === "local" ? "cloud" : "local";
		const id = `partial-${healthyOrigin}`;
		const fail = async () => { throw failure; };
		const success = async () => [space(id)];
		await assert.rejects(listMergedSpaces(
			failingOrigin === "local" ? fail : success,
			failingOrigin === "cloud" ? fail : success,
		), (error: unknown) => {
			assert.ok(error instanceof PartialSpaceListError);
			assert.deepEqual(error.spaces.map(({ id, origin }) => [id, origin]), [[id, healthyOrigin]]);
			assert.deepEqual(error.failures, [{ origin: failingOrigin, error: failure }]);
			assert.equal(getRegisteredSpaceOrigin(id), healthyOrigin);
			return true;
		});
	});
}

test("two failed sources reject without pretending to have a list", async () => {
	const local = new Error("local failed");
	const cloud = new Error("cloud failed");
	await assert.rejects(listMergedSpaces(async () => { throw local; }, async () => { throw cloud; }), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [local, cloud]);
		return true;
	});
});

test("a corrupt successful response is not downgraded to an unavailable source", async () => {
	await assert.rejects(listMergedSpaces(async () => null as unknown as SpaceRecord[], async () => [space("valid-cloud")]), TypeError);
	await assert.rejects(listMergedSpaces(async () => [{} as SpaceRecord], async () => [space("valid-cloud")]), TypeError);
});
