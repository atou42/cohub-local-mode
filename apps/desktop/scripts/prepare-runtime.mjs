#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRuntimeIntegrity } from "../src/runtime-integrity.ts";
import { webBuildEnvironment } from "../../../scripts/local-mode/web-build-env.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const runtimePackage = join(repoRoot, "apps", "desktop-runtime");
const output = join(desktopRoot, "resources", "runtime");
const nativeBuild = join(desktopRoot, "resources", "native-build");
const runtimeArchive = join(desktopRoot, "resources", "runtime.tar");
const runtimeManifest = join(desktopRoot, "resources", "runtime-manifest.json");
const runtimeFiles = join(desktopRoot, "resources", "runtime-files.json");

const desktopWebEnv = {
	COHUB_WEB_TARGET: "desktop",
	PUBLIC_COHUB_ENV: "prod",
	PUBLIC_COHUB_LOCAL_MODE: "true",
	PUBLIC_PERSONAL_NODE_ALPHA: "false",
	PUBLIC_DESKTOP_CLIENT: "true",
	PUBLIC_API_ORIGIN: "",
	PUBLIC_GATEWAY_ORIGIN: "",
	PUBLIC_MARKETPLACE_APP_ID: "",
	PUBLIC_PREVIEW_ORIGIN: "",
	PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
	PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
	PUBLIC_LOGTO_ENDPOINT: "https://auth.neta.art",
};

function run(program, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = execFile(
			program,
			args,
			{ cwd: options.cwd ?? repoRoot, env: options.webBuild ? webBuildEnvironment({ ...process.env, ...options.env }) : { ...process.env, ...options.env }, maxBuffer: 32 * 1024 * 1024 },
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
	["@cohub/billing"],
	["@cohub/core", "@neta-art/cohub"],
	["@neta-art/cohub-cli"],
	["@cohub/worker", "@cohub/agent", "@cohub/gateway"],
]) {
	await run(
		"pnpm",
		packages.flatMap((name) => ["--filter", name]).concat("build"),
	);
}
await run("pnpm", ["--filter", "web", "build"], { env: desktopWebEnv, webBuild: true });
await run("pnpm", [
	"--filter",
	"@cohub/api",
	"exec",
	"tsc",
	"-p",
	"tsconfig.build.json",
]);
await run("node", [join(desktopRoot, "scripts", "prepare-native-runtime.mjs")]);
await mkdir(nativeBuild, { recursive: true });
await run(
	"go",
	[
		"build",
		"-ldflags",
		"-X main.buildVersion=dev2",
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
// Ship executable bytes and links, not the build machine's AppleDouble metadata.
await run("/usr/bin/tar", ["--no-mac-metadata", "--no-xattrs", "-cf", runtimeArchive, "-C", output, "."], {
	env: { COPYFILE_DISABLE: "1" },
});
const archiveStat = await stat(runtimeArchive);
const fileManifest = `${JSON.stringify(await collectRuntimeIntegrity(output))}\n`;
await writeFile(runtimeFiles, fileManifest);
await writeFile(
	runtimeManifest,
	`${JSON.stringify(
		{
			schemaVersion: 2,
			sha256: await sha256File(runtimeArchive),
			size: archiveStat.size,
			filesSha256: createHash("sha256").update(fileManifest).digest("hex"),
		},
		null,
		2,
	)}\n`,
);
