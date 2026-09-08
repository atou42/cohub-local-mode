import assert from "node:assert/strict";
import test from "node:test";
import { parseDev2Release, releaseManifestKey, releaseObjectKey } from "./release.mjs";
import worker, { serveDev2Download } from "./worker.mjs";

const bytes = new TextEncoder().encode("verified-installer-file");
const release = {
	schemaVersion: 1, version: "0.3.0-dev2.13", filename: "Cohub-Dev2-0.3.0-dev2.13-arm64.dmg",
	sha256: "a".repeat(64), bytes: bytes.length, platform: "darwin", arch: "arm64",
	minimumSystemVersion: "13.0", signature: "ad-hoc", notarized: false, publishedAt: "2026-09-07T00:00:00.000Z",
};
const filePath = `/downloads/${release.filename}`;
const request = (path = filePath, init) => new Request(`https://dev2-cohub.atou.cc${path}`, init);

function bucket(options = {}) {
	const calls = [];
	const info = { size: bytes.length, etag: "version-etag", httpEtag: '"version-etag"', customMetadata: { sha256: release.sha256 } };
	return {
		calls,
		async head(key) {
			calls.push({ method: "head", key });
			assert.equal(key, releaseObjectKey(release));
			return options.missingFile ? null : { ...info, ...options.info };
		},
		async get(key, settings) {
			calls.push({ method: "get", key, settings });
			if (key === "latest.json" || key === releaseManifestKey(release.version)) {
				return options.missingManifest ? null : { size: 500, json: async () => options.manifest ?? release };
			}
			assert.equal(key, releaseObjectKey(release));
			assert.deepEqual(settings.onlyIf, { etagMatches: info.etag });
			if (options.changed) return info;
			const range = settings.range;
			const body = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
			return { ...info, body };
		},
	};
}

test("serves the verified installer with download identity and no payload buffering", async () => {
	const response = await serveDev2Download(request(), bucket());
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Length"), String(bytes.length));
	assert.equal(response.headers.get("X-Content-SHA256"), release.sha256);
	assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="${release.filename}"`);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("HEAD verifies metadata without loading the installer body", async () => {
	const storage = bucket();
	const response = await serveDev2Download(request(filePath, { method: "HEAD" }), storage);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "");
	assert.equal(storage.calls.filter(call => call.method === "get").length, 1);
});

test("supports bounded, open-ended and suffix ranges", async () => {
	for (const [range, start, end] of [["bytes=2-6", 2, 6], ["bytes=4-", 4, bytes.length - 1], ["bytes=-5", bytes.length - 5, bytes.length - 1], ["bytes=0-999", 0, bytes.length - 1]]) {
		const response = await serveDev2Download(request(filePath, { headers: { Range: range } }), bucket());
		assert.equal(response.status, 206);
		assert.equal(response.headers.get("Content-Range"), `bytes ${start}-${end}/${bytes.length}`);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(start, end + 1));
	}
});

test("rejects invalid and multiple ranges instead of returning incorrect bytes", async () => {
	for (const range of ["bytes=999-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "bytes=9007199254740992-"]) {
		const response = await serveDev2Download(request(filePath, { headers: { Range: range } }), bucket());
		assert.equal(response.status, 416, range);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
	}
});

test("honors cache validation and refuses a stale If-Range", async () => {
	assert.equal((await serveDev2Download(request(filePath, { headers: { "If-None-Match": '"version-etag"' } }), bucket())).status, 304);
	const response = await serveDev2Download(request(filePath, { headers: { Range: "bytes=0-1", "If-Range": '"old-etag"' } }), bucket());
	assert.equal(response.status, 200);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("latest aliases stay uncached and point to a versioned artifact", async () => {
	const response = await serveDev2Download(request("/downloads/latest.dmg"), bucket());
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("Location"), filePath);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(await (await serveDev2Download(request("/downloads/latest.json"), bucket())).json(), release);
});

test("does not expose storage keys, other buckets or write operations", async () => {
	const storage = bucket();
	for (const path of ["/downloads/", "/downloads/private.json", "/downloads/releases/secret", "/downloads/Cohub-Dev2-0.3.0-arm64.dmg", "/api/alpha/accounts"]) {
		assert.equal((await serveDev2Download(request(path), storage)).status, 404);
	}
	assert.equal((await serveDev2Download(request(filePath, { method: "PUT", body: "no" }), storage)).status, 405);
	assert.equal(storage.calls.length, 0);
});

test("missing, corrupt or changed release objects fail closed", async () => {
	assert.equal((await serveDev2Download(request("/downloads/latest.json"), bucket({ missingManifest: true }))).status, 503);
	assert.equal((await serveDev2Download(request(), bucket({ missingManifest: true }))).status, 404);
	assert.equal((await serveDev2Download(request(), bucket({ missingFile: true }))).status, 503);
	assert.equal((await serveDev2Download(request(), bucket({ changed: true }))).status, 503);
	for (const options of [{ manifest: { ...release, version: "broken" } }, { info: { size: 1 } }, { info: { customMetadata: { sha256: "b".repeat(64) } } }]) {
		const response = await worker.fetch(request(), { RELEASES: bucket(options) });
		assert.equal(response.status, 502);
		assert.equal(await response.text(), "The release could not be verified");
	}
});

test("release metadata rejects unsupported platforms, false signing claims and malformed identities", () => {
	for (const patch of [{ filename: "../private" }, { arch: "x64" }, { notarized: true }, { bytes: 0 }, { sha256: "bad" }, { signature: "signed" }, { minimumSystemVersion: "26.0" }, { token: "must-not-be-published" }]) {
		assert.throws(() => parseDev2Release({ ...release, ...patch }), /invalid/);
	}
});
