#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(desktopRoot, "resources", "native-build");
const valkeyVersion = "9.1.2";
const valkeyUrl = `https://api.github.com/repos/valkey-io/valkey/tarball/${valkeyVersion}`;
const valkeySha256 = "8e8557da7426a51b4e0fb514a65ef6241dc7c85cb408243af389070abf379cec";

function run(program, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		execFile(program, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${program} failed: ${stderr || error.message}`, { cause: error }));
			else resolvePromise(stdout);
		});
	});
}

async function sha256(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function download(url, destination) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`Native dependency download returned HTTP ${response.status}`);
	await writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
}

await mkdir(outputDir, { recursive: true });
const output = join(outputDir, "valkey-server");
const manifestPath = join(outputDir, "manifest.json");
try {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (
		manifest.valkeyVersion === valkeyVersion &&
		manifest.sourceSha256 === valkeySha256 &&
		(await sha256(output)) === manifest.binarySha256
	) {
		process.exit(0);
	}
} catch (error) {
	if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
}

const temporary = await mkdtemp(join(tmpdir(), "cohub-valkey-build-"));
try {
	const archive = join(temporary, "valkey.tar.gz");
	await download(valkeyUrl, archive);
	const downloadedSha = await sha256(archive);
	if (downloadedSha !== valkeySha256) {
		throw new Error(`Valkey source checksum mismatch: ${downloadedSha}`);
	}
	await run("/usr/bin/tar", ["-xzf", archive, "-C", temporary]);
	const sourceName = (await run("/bin/ls", ["-1", temporary]))
		.split("\n")
		.find((name) => name.startsWith("valkey-io-valkey-"));
	if (!sourceName) throw new Error("Valkey source archive layout is invalid");
	const sourceRoot = join(temporary, sourceName);
	await run("/usr/bin/make", ["-C", sourceRoot, "-j4", "BUILD_TLS=no", "MALLOC=libc", "valkey-server"]);
	const staged = `${output}.${process.pid}.next`;
	await copyFile(join(sourceRoot, "src", "valkey-server"), staged);
	await chmod(staged, 0o755);
	await rm(output, { force: true });
	await copyFile(staged, output);
	await rm(staged, { force: true });
	const binarySha256 = await sha256(output);
	await writeFile(
		manifestPath,
		`${JSON.stringify({ valkeyVersion, sourceSha256: valkeySha256, binarySha256 }, null, 2)}\n`,
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
