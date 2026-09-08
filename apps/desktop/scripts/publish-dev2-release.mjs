import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { validateDev2DownloadsConfig } from "../distribution/deployment.mjs";
import { publishDev2Release } from "../distribution/publish.mjs";
import { connectDev2ReleaseBucket } from "../distribution/remote-r2.mjs";
import { parseDev2Release, releaseDownloadPath } from "../distribution/release.mjs";

const { values } = parseArgs({ options: { dmg: { type: "string" }, publish: { type: "boolean", default: false } } });
if (!values.dmg) throw new Error("Usage: node scripts/publish-dev2-release.mjs --dmg <verified.dmg> [--publish]");
const desktopRoot = resolve(import.meta.dirname, "..");
const configPath = resolve(desktopRoot, "distribution/wrangler.dev2.json");
validateDev2DownloadsConfig(JSON.parse(await readFile(configPath, "utf8")));
const { version } = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
const filePath = await realpath(values.dmg);
const file = await stat(filePath);
assert.ok(file.isFile(), "Installer must be a regular file");
assert.equal(basename(filePath), `Cohub-Dev2-${version}-arm64.dmg`, "Installer name must match the desktop version");
const hash = createHash("sha256");
for await (const chunk of createReadStream(filePath)) hash.update(chunk);
const release = parseDev2Release({
	schemaVersion: 1, version, filename: basename(filePath), sha256: hash.digest("hex"), bytes: file.size,
	platform: "darwin", arch: "arm64", minimumSystemVersion: "13.0", signature: "ad-hoc", notarized: false,
	publishedAt: new Date().toISOString(),
});
await promisify(execFile)("/usr/bin/hdiutil", ["verify", filePath], { maxBuffer: 4 * 1024 * 1024 });
console.log(JSON.stringify({ stage: "verified-installer", release, publish: values.publish }));
if (values.publish) {
	const proxy = await connectDev2ReleaseBucket();
	try {
		const published = await publishDev2Release(proxy.bucket, filePath, release, event => console.log(JSON.stringify(event)));
		console.log(JSON.stringify({ stage: "published", release: published, url: `https://dev2-cohub.atou.cc${releaseDownloadPath(published)}` }));
	} finally { await proxy.dispose(); }
}
