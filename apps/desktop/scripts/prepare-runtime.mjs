#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	lstat,
	mkdir,
	readFile,
	readlink,
	readdir,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const runtimePackage = join(repoRoot, "apps", "desktop-runtime");
const output = join(desktopRoot, "resources", "runtime");
const nativeBuild = join(desktopRoot, "resources", "native-build");
const runtimeArchive = join(desktopRoot, "resources", "runtime.tar");
const runtimeManifest = join(desktopRoot, "resources", "runtime-manifest.json");

function run(program, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = execFile(
			program,
			args,
			{ cwd: options.cwd ?? repoRoot, env: { ...process.env, ...options.env }, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${program} failed: ${stderr || error.message}`, { cause: error }));
				else resolvePromise(stdout);
			},
		);
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);
	});
}

async function sha256File(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

for (const packages of [
	["@cohub/protocol", "@cohub/identity"],
	["@cohub/db", "@cohub/infra", "@cohub/model-runtime"],
	["@cohub/sandbox-controller", "@cohub/sandbox-client"],
	["@cohub/core", "@neta-art/cohub"],
	["@neta-art/cohub-cli"],
	["@cohub/worker", "@cohub/agent", "@cohub/gateway"],
]) {
	await run(
		"pnpm",
		packages.flatMap((name) => ["--filter", name]).concat("build"),
	);
}
await run("pnpm", [
	"--filter",
	"@cohub/api",
	"exec",
	"tsc",
	"-p",
	"tsconfig.build.json",
	"--noCheck",
]);
await run("node", [join(desktopRoot, "scripts", "prepare-native-runtime.mjs")]);
await mkdir(nativeBuild, { recursive: true });
await run(
	"go",
	[
		"build",
		"-ldflags",
		"-X main.buildVersion=personal-node-alpha",
		"-o",
		join(nativeBuild, "cohub-sandboxd"),
		".",
	],
	{ cwd: join(repoRoot, "apps", "sandbox") },
);
await Promise.all([
	copyFile(
		join(repoRoot, "scripts", "local-mode", "sandbox-supervisor.mjs"),
		join(runtimePackage, "sandbox-supervisor.mjs"),
	),
	copyFile(
		join(repoRoot, "scripts", "local-mode", "sandbox-supervisor-core.mjs"),
		join(runtimePackage, "sandbox-supervisor-core.mjs"),
	),
]);
await rm(output, { recursive: true, force: true });
await run("pnpm", ["--filter", "@cohub/desktop-runtime", "deploy", "--prod", output]);
const virtualStore = join(output, "node_modules", ".pnpm");
const optionalBillingLinks = [
	join(virtualStore, "node_modules", "@talesofai-billing", "sdk"),
	...(await readdir(virtualStore, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) =>
			join(
				virtualStore,
				entry.name,
				"node_modules",
				"@talesofai-billing",
				"sdk",
			),
		),
];
for (const optionalBillingLink of optionalBillingLinks) {
	try {
		const stat = await lstat(optionalBillingLink);
		if (!stat.isSymbolicLink()) {
			throw new Error("The optional billing SDK path must be a symlink");
		}
		const target = resolve(
			dirname(optionalBillingLink),
			await readlink(optionalBillingLink),
		);
		try {
			await access(target);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			await unlink(optionalBillingLink);
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}
const sdkPackagePath = join(output, "node_modules", "@neta-art", "cohub", "package.json");
const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
if (!sdkPackage.publishConfig?.exports || !sdkPackage.publishConfig?.types) {
	throw new Error("The deployed Cohub SDK is missing its published entrypoint metadata");
}
sdkPackage.exports = sdkPackage.publishConfig.exports;
sdkPackage.types = sdkPackage.publishConfig.types;
await writeFile(sdkPackagePath, `${JSON.stringify(sdkPackage, null, 2)}\n`);
const postgresPackage = join(
	output,
	"node_modules",
	"@embedded-postgres",
	"darwin-arm64",
);
await run("node", [join(postgresPackage, "scripts", "hydrate-symlinks.js")], {
	cwd: postgresPackage,
});
const packagedNative = join(output, "native");
await mkdir(packagedNative, { recursive: true });
for (const name of ["valkey-server", "cohub-sandboxd"]) {
	await copyFile(join(nativeBuild, name), join(packagedNative, name));
	await chmod(join(packagedNative, name), 0o755);
}
await run("node", ["--check", join(output, "manager.mjs")]);
await Promise.all([
	rm(runtimeArchive, { force: true }),
	rm(runtimeManifest, { force: true }),
]);
await run("/usr/bin/tar", ["-cf", runtimeArchive, "-C", output, "."]);
const archiveStat = await stat(runtimeArchive);
await writeFile(
	runtimeManifest,
	`${JSON.stringify(
		{
			schemaVersion: 1,
			sha256: await sha256File(runtimeArchive),
			size: archiveStat.size,
		},
		null,
		2,
	)}\n`,
);
