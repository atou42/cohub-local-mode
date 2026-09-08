import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEV2_RELEASE_BUCKET, validateDev2DownloadsConfig } from "./deployment.mjs";
import { publishDev2Release } from "./publish.mjs";
import { releaseManifestKey, releaseObjectKey } from "./release.mjs";

async function fixture(t, size = 48) {
	const directory = await mkdtemp(join(tmpdir(), "cohub-release-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "installer.dmg");
	const bytes = Buffer.alloc(size, 42);
	await writeFile(path, bytes);
	const release = {
		schemaVersion: 1, version: "0.3.0-dev2.13", filename: "Cohub-Dev2-0.3.0-dev2.13-arm64.dmg",
		sha256: createHash("sha256").update(bytes).digest("hex"), bytes: size, platform: "darwin", arch: "arm64",
		minimumSystemVersion: "13.0", signature: "ad-hoc", notarized: false, publishedAt: "2026-09-07T00:00:00.000Z",
	};
	const objects = new Map();
	const calls = [];
	const info = object => object && ({ size: object.body.length, etag: object.etag, customMetadata: object.customMetadata });
	let sequence = 0;
	const store = (key, body, customMetadata) => {
		const object = { body: Buffer.from(body), etag: String(++sequence), customMetadata };
		objects.set(key, object);
		return info(object);
	};
	const bucket = {
		async get(key) {
			const object = objects.get(key);
			return object ? { ...info(object), json: async () => JSON.parse(object.body.toString()) } : null;
		},
		async head(key) { return info(objects.get(key)) ?? null; },
		async put(key, value, options) {
			calls.push({ method: "put", key });
			const current = objects.get(key);
			if ((options.onlyIf.etagDoesNotMatch === "*" && current) || (options.onlyIf.etagMatches !== undefined && options.onlyIf.etagMatches !== current?.etag)) return null;
			return store(key, value);
		},
		async createMultipartUpload(key, options) {
			calls.push({ method: "create", key });
			const parts = [];
			return {
				async uploadPart(number, bytes) {
					calls.push({ method: "part", number, size: bytes.length });
					parts.push(Buffer.from(bytes));
					return { partNumber: number, etag: String(number) };
				},
				async complete(uploaded) {
					assert.equal(uploaded.length, parts.length);
					calls.push({ method: "complete" });
					return store(key, Buffer.concat(parts), options.customMetadata);
				},
				async abort() { calls.push({ method: "abort" }); },
			};
		},
	};
	return { path, bytes, release, objects, calls, bucket, store };
}

test("streams multipart bytes and publishes immutable version metadata before latest", async (t) => {
	const f = await fixture(t, 16 * 1024 * 1024 + 29);
	assert.deepEqual(await publishDev2Release(f.bucket, f.path, f.release), f.release);
	assert.deepEqual(f.objects.get(releaseObjectKey(f.release)).body, f.bytes);
	assert.deepEqual(f.calls.filter(call => call.method === "part").map(call => call.size), [16 * 1024 * 1024, 29]);
	assert.deepEqual(f.calls.filter(call => call.method === "put").map(call => call.key), [releaseManifestKey(f.release.version), "latest.json"]);
});

test("repeating a release preserves its timestamp and performs no writes", async (t) => {
	const f = await fixture(t);
	await publishDev2Release(f.bucket, f.path, f.release);
	f.calls.length = 0;
	assert.deepEqual(await publishDev2Release(f.bucket, f.path, { ...f.release, publishedAt: "2026-09-08T00:00:00.000Z" }), f.release);
	assert.equal(f.calls.length, 0);
});

test("verifies the stored HEAD when multipart completion omits custom metadata", async (t) => {
	const f = await fixture(t);
	const create = f.bucket.createMultipartUpload;
	f.bucket.createMultipartUpload = async (...args) => {
		const upload = await create(...args);
		const complete = upload.complete;
		upload.complete = async parts => { const object = await complete(parts); return { size: object.size, etag: object.etag }; };
		return upload;
	};
	assert.deepEqual(await publishDev2Release(f.bucket, f.path, f.release), f.release);
});

test("a version cannot be overwritten with different installer bytes", async (t) => {
	const f = await fixture(t);
	await publishDev2Release(f.bucket, f.path, f.release);
	f.calls.length = 0;
	await assert.rejects(publishDev2Release(f.bucket, f.path, { ...f.release, sha256: "b".repeat(64) }), /different release/);
	assert.equal(f.calls.length, 0);
});

test("a checksum failure aborts only the unfinished upload and publishes nothing", async (t) => {
	const f = await fixture(t);
	await assert.rejects(publishDev2Release(f.bucket, f.path, { ...f.release, sha256: "b".repeat(64) }), /changed while uploading/);
	assert.equal(f.objects.size, 0);
	assert.ok(f.calls.some(call => call.method === "abort"));
	assert.ok(!f.calls.some(call => call.method === "complete" || call.method === "put"));
});

test("corrupt stored metadata and inconsistent stored bytes are preserved", async (t) => {
	const f = await fixture(t);
	f.store("latest.json", "{corrupt");
	await assert.rejects(publishDev2Release(f.bucket, f.path, f.release), SyntaxError);
	assert.equal(f.objects.get("latest.json").body.toString(), "{corrupt");
	assert.equal(f.calls.length, 0);
	f.objects.delete("latest.json");
	f.store(releaseObjectKey(f.release), "damaged", { sha256: f.release.sha256 });
	await assert.rejects(publishDev2Release(f.bucket, f.path, f.release), /inconsistent/);
	assert.equal(f.objects.get(releaseObjectKey(f.release)).body.toString(), "damaged");
});

test("a concurrent latest change is not overwritten", async (t) => {
	const f = await fixture(t);
	const put = f.bucket.put;
	f.bucket.put = async (...args) => {
		if (args[0] === "latest.json") f.store("latest.json", JSON.stringify({ ...f.release, version: "0.3.0-dev2.14", filename: "Cohub-Dev2-0.3.0-dev2.14-arm64.dmg" }));
		return put(...args);
	};
	await assert.rejects(publishDev2Release(f.bucket, f.path, f.release), /changed concurrently/);
	assert.equal(JSON.parse(f.objects.get("latest.json").body.toString()).version, "0.3.0-dev2.14");
});

test("refuses to downgrade the latest release", async (t) => {
	const f = await fixture(t);
	f.store("latest.json", JSON.stringify({ ...f.release, version: "0.3.0-dev2.14", filename: "Cohub-Dev2-0.3.0-dev2.14-arm64.dmg" }));
	await assert.rejects(publishDev2Release(f.bucket, f.path, f.release), /newer release/);
	assert.equal(f.calls.length, 0);
});

test("deployment guard rejects production routes, shared storage and unknown bindings", () => {
	const config = { name: "cohub-personal-node-dev2-downloads", main: "worker.mjs", compatibility_date: "2026-08-25", workers_dev: false, routes: [{ pattern: "dev2-cohub.atou.cc/downloads/*", zone_name: "atou.cc" }], r2_buckets: [{ binding: "RELEASES", bucket_name: DEV2_RELEASE_BUCKET, remote: true }] };
	validateDev2DownloadsConfig(config);
	for (const patch of [{ routes: [{ pattern: "cohub.atou.cc/*", zone_name: "atou.cc" }] }, { workers_dev: true }, { r2_buckets: [{ binding: "RELEASES", bucket_name: "cohub-personal-node-dev2-attachments", remote: true }] }, { services: [{ binding: "PRODUCTION", service: "cohub" }] }]) {
		assert.throws(() => validateDev2DownloadsConfig({ ...config, ...patch }), /dedicated Dev2/);
	}
});
