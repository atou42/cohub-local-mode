import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseDev2Release, releaseManifestKey, releaseObjectKey } from "./release.mjs";

async function storedRelease(bucket, key) {
	const object = await bucket.get(key);
	if (!object) return null;
	if (object.size > 4096) throw new Error("Stored release metadata is too large");
	return { release: parseDev2Release(await object.json()), etag: object.etag };
}

function compareVersions(left, right) {
	const parts = value => value.replace("-dev2.", ".").split(".").map(Number);
	const a = parts(left);
	const b = parts(right);
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
	}
	return 0;
}

export async function publishDev2Release(bucket, filePath, input, report = () => {}) {
	let release = parseDev2Release(input);
	const versionKey = releaseManifestKey(release.version);
	const existing = await storedRelease(bucket, versionKey);
	if (existing) {
		if (!isDeepStrictEqual({ ...existing.release, publishedAt: release.publishedAt }, release)) {
			throw new Error("This version already identifies a different release; publish a new version instead");
		}
		release = existing.release;
	}
	const current = await storedRelease(bucket, "latest.json");
	if (current && compareVersions(current.release.version, release.version) > 0) throw new Error("Refusing to replace a newer release");
	const key = releaseObjectKey(release);
	const previousObject = await bucket.head(key);
	if (previousObject && (previousObject.size !== release.bytes || previousObject.customMetadata?.sha256 !== release.sha256)) {
		throw new Error("Stored release object is inconsistent; existing bytes were preserved");
	}
	if (!previousObject) {
		const file = await open(filePath, "r");
		let upload;
		let completed = false;
		try {
			const before = await file.stat();
			if (!before.isFile() || before.size !== release.bytes) throw new Error("Installer size changed before uploading");
			upload = await bucket.createMultipartUpload(key, {
				httpMetadata: { contentType: "application/x-apple-diskimage", contentDisposition: `attachment; filename="${release.filename}"` },
				customMetadata: { sha256: release.sha256 },
			});
			const parts = [];
			const hash = createHash("sha256");
			let offset = 0;
			while (offset < release.bytes) {
				const chunk = Buffer.alloc(Math.min(16 * 1024 * 1024, release.bytes - offset));
				let filled = 0;
				while (filled < chunk.length) {
					const { bytesRead } = await file.read(chunk, filled, chunk.length - filled, offset + filled);
					if (!bytesRead) throw new Error("Installer ended while uploading");
					filled += bytesRead;
				}
				hash.update(chunk);
				parts.push(await upload.uploadPart(parts.length + 1, chunk));
				offset += chunk.length;
				report({ stage: "uploaded-part", part: parts.length, bytes: offset, total: release.bytes });
			}
			const after = await file.stat();
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || hash.digest("hex") !== release.sha256) {
				throw new Error("Installer changed while uploading; release was not published");
			}
			await upload.complete(parts);
			completed = true;
			// R2's completion response can omit metadata; verify the stored object itself.
			const object = await bucket.head(key);
			if (!object || object.size !== release.bytes || object.customMetadata?.sha256 !== release.sha256) throw new Error("Uploaded object identity does not match the installer");
		} finally {
			await file.close();
			if (upload && !completed) await upload.abort();
		}
	}
	const content = JSON.stringify(release) + "\n";
	const metadata = { contentType: "application/json; charset=utf-8", cacheControl: "no-store" };
	if (!existing) {
		const saved = await bucket.put(versionKey, content, { httpMetadata: metadata, onlyIf: { etagDoesNotMatch: "*" } });
		if (!saved) throw new Error("Release version was published concurrently; latest was not changed");
	}
	if (current && isDeepStrictEqual(current.release, release)) return release;
	const saved = await bucket.put("latest.json", content, {
		httpMetadata: metadata,
		onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
	});
	if (!saved) throw new Error("Latest release changed concurrently; it was not overwritten");
	return release;
}
