#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(desktopRoot, "resources", "native-build");
const valkeyVersion = "9.1.2";
const macosDeploymentTarget = "13.0";
const valkeyUrl = `https://api.github.com/repos/valkey-io/valkey/tarball/${valkeyVersion}`;
const valkeySha256 = "8e8557da7426a51b4e0fb514a65ef6241dc7c85cb408243af389070abf379cec";

function run(program, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		execFile(program, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${program} failed: ${stderr || error.message}`, { cause: error }));
			else resolvePromise(stdout);
		});
	});
}

async function sha256(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function download(url, destination) {
	const sourceArchive = process.env.COHUB_VALKEY_SOURCE_ARCHIVE;
	if (sourceArchive) {
		await copyFile(resolve(sourceArchive), destination, constants.COPYFILE_EXCL);
		return;
	}
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`Native dependency download returned HTTP ${response.status}`);
	await writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
}

await mkdir(outputDir, { recursive: true });
const output = join(outputDir, "valkey-server");
const manifestPath = join(outputDir, "manifest.json");
let manifest;
try {
	manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
	if (error?.code !== "ENOENT") throw error;
}
if (manifest !== undefined) {
	if (
		!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
		typeof manifest.valkeyVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.valkeyVersion) ||
		(manifest.macosDeploymentTarget !== undefined &&
			(typeof manifest.macosDeploymentTarget !== "string" || !/^\d+\.\d+$/.test(manifest.macosDeploymentTarget))) ||
		typeof manifest.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
		typeof manifest.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.binarySha256)
	) throw new Error("Native build manifest is invalid; existing files were preserved");
	if ((await sha256(output)) !== manifest.binarySha256) {
		throw new Error("Native binary checksum mismatch; existing files were preserved");
	}
	if (manifest.valkeyVersion === valkeyVersion && manifest.sourceSha256 === valkeySha256 && manifest.macosDeploymentTarget === macosDeploymentTarget) {
		process.exit(0);
	}
}

const temporary = await mkdtemp(join(tmpdir(), "cohub-valkey-build-"));
let completed = false;
try {
	const archive = join(temporary, "valkey.tar.gz");
	await download(valkeyUrl, archive);
	const downloadedSha = await sha256(archive);
	if (downloadedSha !== valkeySha256) {
		throw new Error(`Valkey source checksum mismatch: ${downloadedSha}`);
	}
	await run("/usr/bin/tar", ["-xzf", archive, "-C", temporary]);
	const sourceName = (await readdir(temporary)).find((name) => name.startsWith("valkey-io-valkey-"));
	if (!sourceName) throw new Error("Valkey source archive layout is invalid");
	const sourceRoot = join(temporary, sourceName);
	await run("/usr/bin/make", [
		"-C", sourceRoot, "-j4", "BUILD_TLS=no", "MALLOC=libc",
		`CFLAGS=-mmacosx-version-min=${macosDeploymentTarget}`,
		`LDFLAGS=-mmacosx-version-min=${macosDeploymentTarget}`,
		"valkey-server",
	], { env: { MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget } });
	const buildInfo = await run("/usr/bin/vtool", ["-show-build", join(sourceRoot, "src", "valkey-server")]);
	const targets = [...buildInfo.matchAll(/^\s*minos\s+(\d+\.\d+(?:\.\d+)?)\s*$/gm)];
	if (targets.length !== 1 || targets[0][1] !== macosDeploymentTarget) {
		throw new Error("Valkey deployment target does not match the supported macOS version");
	}
	if (manifest !== undefined) {
		const backup = await mkdtemp(join(outputDir, "previous-"));
		await copyFile(output, join(backup, "valkey-server"), constants.COPYFILE_EXCL);
		await copyFile(manifestPath, join(backup, "manifest.json"), constants.COPYFILE_EXCL);
	}
	const staged = `${output}.${process.pid}.next`;
	await copyFile(join(sourceRoot, "src", "valkey-server"), staged);
	await chmod(staged, 0o755);
	await rename(staged, output);
	const binarySha256 = await sha256(output);
	await writeFile(
		`${manifestPath}.${process.pid}.next`,
		`${JSON.stringify({ valkeyVersion, macosDeploymentTarget, sourceSha256: valkeySha256, binarySha256 }, null, 2)}\n`,
		{ flag: "wx" },
	);
	await rename(`${manifestPath}.${process.pid}.next`, manifestPath);
	completed = true;
} finally {
	if (completed) await rm(temporary, { recursive: true, force: true });
	else console.error(`Native build failed; working files preserved at ${temporary}`);
}
