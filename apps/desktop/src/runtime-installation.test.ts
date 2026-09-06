import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { extractRuntime, installRuntime } from "./runtime-installation.ts";

async function fixture(complete = true) {
	const root = await mkdtemp(join(tmpdir(), "cohub-runtime-install-"));
	const resources = join(root, "resources");
	const data = join(root, "data");
	const source = join(root, "source");
	await mkdir(resources);
	await mkdir(source);
	for (const file of complete ? [
		"manager.mjs", "web-entry.mjs", "node_modules/web/build/handler.js",
		"node_modules/s3rver/package.json", "node_modules/postgres/package.json",
		"node_modules/@embedded-postgres/darwin-arm64/package.json",
		"native/valkey-server", "native/cohub-sandboxd",
	] : ["manager.mjs"]) {
		await mkdir(dirname(join(source, file)), { recursive: true });
		await writeFile(join(source, file), `fixture: ${file}\n`);
	}
	execFileSync("/usr/bin/tar", ["-cf", join(resources, "runtime.tar"), "-C", source, "."]);
	const archive = await readFile(join(resources, "runtime.tar"));
	const sha256 = createHash("sha256").update(archive).digest("hex");
	await writeFile(join(resources, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, sha256, size: archive.length }));
	return { root, resources, data, sha256 };
}

test("a failed extraction can retry without overwriting its diagnostic directory", async () => {
	const f = await fixture(false);
	await assert.rejects(installRuntime(f.resources, f.data), /handler|web-entry|ENOENT/);
	const [first] = await readdir(join(f.data, "runtime"));
	const marker = join(f.data, "runtime", first, "manager.mjs");
	const original = await readFile(marker);
	await assert.rejects(installRuntime(f.resources, f.data), (error: Error) => {
		assert.doesNotMatch(error.message, /EEXIST/);
		assert.match(error.message, /handler|web-entry|ENOENT/);
		return true;
	});
	assert.deepEqual(await readFile(marker), original);
	assert.equal((await readdir(join(f.data, "runtime"))).length, 2);
});

test("install and reuse preserve an existing version and user data", async () => {
	const f = await fixture();
	await mkdir(join(f.data, "runtime", "previous-version"), { recursive: true });
	await writeFile(join(f.data, "runtime", "previous-version", "marker"), "old version");
	await writeFile(join(f.data, "personal-node.json"), "existing identity");
	const manager = await installRuntime(f.resources, f.data);
	assert.equal(manager, join(f.data, "runtime", f.sha256, "manager.mjs"));
	assert.equal(await installRuntime(f.resources, f.data), manager);
	assert.equal(await readFile(join(f.data, "personal-node.json"), "utf8"), "existing identity");
	assert.equal(await readFile(join(f.data, "runtime", "previous-version", "marker"), "utf8"), "old version");
	await writeFile(join(dirname(manager), ".cohub-runtime.json"), "broken marker");
	await assert.rejects(installRuntime(f.resources, f.data), /marker cannot be read/);
	assert.equal(await readFile(join(dirname(manager), ".cohub-runtime.json"), "utf8"), "broken marker");
});

test("cancelled installation does not create an installed runtime", async () => {
	const f = await fixture();
	const controller = new AbortController();
	controller.abort(new Error("Installer stopped"));
	await assert.rejects(installRuntime(f.resources, f.data, controller.signal), /Installer stopped/);
	await assert.rejects(access(join(f.data, "runtime", f.sha256)), { code: "ENOENT" });
});

test("cancelling a blocked real tar process waits for its termination", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-extract-cancel-"));
	const archive = join(root, "blocked.tar");
	execFileSync("/usr/bin/mkfifo", [archive]);
	const controller = new AbortController();
	const extracting = extractRuntime(archive, root, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const pid = Number(execFileSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", archive], { encoding: "utf8" }).trim());
	assert.ok(pid > 1);
	controller.abort(new Error("Installer stopped during extraction"));
	await assert.rejects(extracting, /Installer stopped during extraction/);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
