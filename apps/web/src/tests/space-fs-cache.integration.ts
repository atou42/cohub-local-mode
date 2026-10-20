import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import type { SpaceFsEntry } from "@neta-art/cohub";

const entry = (name: string): SpaceFsEntry => ({ name, path: name, type: "file", size: 0, mimeType: null, mtimeMs: 0 });
let commits = 0;
let rejectCommit = false;
let cached = [entry("cached")];
const mocks = [
	mock.module("../lib/cache/db.ts", { namedExports: { deleteCacheDatabase: async () => {} } }),
	mock.module("../lib/cache/keys.ts", { namedExports: { getCacheUserKeyAsync: async () => "user", canUseUserScopedCache: () => true } }),
	mock.module("../lib/cache/repositories/space-fs-repo.ts", { namedExports: { spaceFsRepo: {
		getDir: async () => ({ entries: cached, stale: true }),
		getEpoch: async () => 1,
		setDirIfEpoch: async (_space: string, _path: string, entries: SpaceFsEntry[]) => {
			commits += 1;
			if (rejectCommit) { rejectCommit = false; return { committed: false }; }
			cached = entries;
			return { committed: true, snapshot: { entries } };
		},
	} } }),
];
after(() => { for (const item of mocks.reverse()) item.restore(); });
const { fetchSpaceFsDirWithCache } = await import("../lib/stores/space-fs-cache.ts");

test("truncated and failed directory reads never replace the cached directory", async () => {
	commits = 0;
	cached = [entry("cached")];
	const partial = await fetchSpaceFsDirWithCache("s", "", async () => ({ entries: [entry("new")], truncated: true }));
	assert.deepEqual(partial, [entry("cached"), entry("new")]);
	assert.deepEqual(cached, [entry("cached")]);
	await assert.rejects(fetchSpaceFsDirWithCache("s", "", async () => { throw new Error("Later page failed"); }));
	assert.equal(commits, 0);
});

test("complete directory reads still obey epoch rejection and retry", async () => {
	commits = 0;
	rejectCommit = true;
	let reads = 0;
	const result = await fetchSpaceFsDirWithCache("s", "", async () => ({ entries: [entry(String(++reads))], truncated: false }));
	assert.equal(reads, 2);
	assert.equal(commits, 2);
	assert.deepEqual(result, [entry("2")]);
});
