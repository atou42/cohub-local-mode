import { parseDev2Release, releaseDownloadPath, releaseManifestKey, releaseObjectKey } from "./release.mjs";

function failure(message, status, extraHeaders = {}) {
	return new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", ...extraHeaders } });
}

function requestedRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2])) return null;
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
	return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

async function readRelease(bucket, key) {
	const object = await bucket.get(key);
	if (!object) return null;
	if (object.size > 4096) throw new Error("Release metadata is too large");
	return parseDev2Release(await object.json());
}

export async function serveDev2Download(request, bucket) {
	const url = new URL(request.url);
	if (request.method !== "GET" && request.method !== "HEAD") return failure("Method not allowed", 405, { Allow: "GET, HEAD" });
	const latest = url.pathname === "/downloads/latest.json" || url.pathname === "/downloads/latest.dmg";
	const match = /^\/downloads\/Cohub-Dev2-(\d+\.\d+\.\d+-dev2\.\d+)-arm64\.dmg$/.exec(url.pathname);
	if (!latest && !match) return failure("Not found", 404);
	if (!bucket) return failure("Downloads are unavailable", 503);
	const release = await readRelease(bucket, latest ? "latest.json" : releaseManifestKey(match[1]));
	if (!release) return failure(latest ? "No Dev2 release is available" : "Release not found", latest ? 503 : 404);
	if (match && release.version !== match[1]) throw new Error("Release identity mismatch");
	if (url.pathname === "/downloads/latest.json") {
		const body = JSON.stringify(release) + "\n";
		return new Response(request.method === "HEAD" ? null : body, {
			headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
		});
	}
	if (url.pathname === "/downloads/latest.dmg") {
		return new Response(null, { status: 302, headers: { Location: releaseDownloadPath(release), "Cache-Control": "no-store" } });
	}
	const key = releaseObjectKey(release);
	const info = await bucket.head(key);
	if (!info) return failure("The release file is unavailable", 503);
	if (info.size !== release.bytes || info.customMetadata?.sha256 !== release.sha256) throw new Error("Release object identity mismatch");
	const headers = new Headers({
		"Content-Type": "application/x-apple-diskimage",
		"Content-Disposition": `attachment; filename="${release.filename}"`,
		"Cache-Control": "public, max-age=31536000, immutable",
		"Accept-Ranges": "bytes",
		"ETag": info.httpEtag,
		"X-Content-SHA256": release.sha256,
		"X-Content-Type-Options": "nosniff",
	});
	if (request.headers.get("If-None-Match")?.split(",").some(value => value.trim() === info.httpEtag || value.trim() === "*")) {
		return new Response(null, { status: 304, headers });
	}
	let range;
	const rangeHeader = request.headers.get("Range");
	const ifRange = request.headers.get("If-Range");
	if (request.method !== "HEAD" && rangeHeader && (!ifRange || ifRange === info.httpEtag)) {
		range = requestedRange(rangeHeader, info.size);
		if (!range) return failure("Requested range is not satisfiable", 416, { "Content-Range": `bytes */${info.size}` });
		headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${info.size}`);
	}
	headers.set("Content-Length", String(range?.length ?? info.size));
	if (request.method === "HEAD") return new Response(null, { headers });
	const object = await bucket.get(key, { onlyIf: { etagMatches: info.etag }, ...(range ? { range } : {}) });
	if (!object || !("body" in object)) return failure("The release changed while downloading; try again", 503);
	if (object.size !== release.bytes || object.customMetadata?.sha256 !== release.sha256) throw new Error("Release changed while downloading");
	return new Response(object.body, { status: range ? 206 : 200, headers });
}

export default {
	async fetch(request, env) {
		try {
			return await serveDev2Download(request, env.RELEASES);
		} catch (error) {
			console.error("Dev2 download failed", error instanceof Error ? error.message : "Unknown storage error");
			return failure("The release could not be verified", 502);
		}
	},
};
