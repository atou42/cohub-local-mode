import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function sha256File(path: string, signal?: AbortSignal) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
	return hash.digest("hex");
}

export async function extractRuntime(archive: string, destination: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"/usr/bin/tar",
			["-xf", archive, "-C", destination],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		let processError: Error | null = null;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		const abort = () => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-16_384);
		});
		child.once("error", (error) => { processError = error; });
		child.once("close", (code, exitSignal) => {
			signal?.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
			if (signal?.aborted) reject(signal.reason);
			else if (processError) reject(processError);
			else if (code === 0) resolve();
			else {
				reject(
					new Error(
						`Bundled runtime extraction failed (${exitSignal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
					),
				);
			}
		});
	});
}

async function validateInstalledRuntime(directory: string) {
	for (const relative of [
		"manager.mjs",
		"web-entry.mjs",
		"node_modules/web/build/handler.js",
		"node_modules/s3rver/package.json",
		"node_modules/postgres/package.json",
		"node_modules/@embedded-postgres/darwin-arm64/package.json",
		"native/valkey-server",
		"native/cohub-sandboxd",
	]) {
		await access(join(directory, relative));
	}
}

export async function installRuntime(
	resourcesPath: string,
	userDataPath: string,
	signal?: AbortSignal,
	report: (message: string) => void = () => {},
) {
	const started = performance.now();
	const stage = (message: string) => report(`${message} (${Math.round(performance.now() - started)}ms)`);
	signal?.throwIfAborted();
	stage("Verifying runtime archive");
	const archive = join(resourcesPath, "runtime.tar");
	const manifestPath = join(resourcesPath, "runtime-manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		schemaVersion?: unknown;
		sha256?: unknown;
		size?: unknown;
	};
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(manifest.sha256) ||
		typeof manifest.size !== "number" ||
		!Number.isSafeInteger(manifest.size) ||
		manifest.size <= 0
	) {
		throw new Error("Bundled runtime manifest is invalid");
	}
	const archiveStat = await stat(archive);
	if (archiveStat.size !== manifest.size) {
		throw new Error("Bundled runtime archive size does not match its manifest");
	}
	if ((await sha256File(archive, signal)) !== manifest.sha256) {
		throw new Error("Bundled runtime archive checksum does not match its manifest");
	}
	stage("Runtime archive verified");

	const parent = join(userDataPath, "runtime");
	const installed = join(parent, manifest.sha256);
	let installedExists = true;
	try {
		await access(installed);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		installedExists = false;
	}
	if (installedExists) {
		let marker: { schemaVersion?: unknown; sha256?: unknown };
		try {
			marker = JSON.parse(
				await readFile(join(installed, ".cohub-runtime.json"), "utf8"),
			) as { schemaVersion?: unknown; sha256?: unknown };
		} catch (error) {
			throw new Error("Installed runtime marker cannot be read", {
				cause: error,
			});
		}
		if (marker.schemaVersion !== 1 || marker.sha256 !== manifest.sha256) {
			throw new Error("Installed runtime marker is invalid");
		}
		await validateInstalledRuntime(installed);
		signal?.throwIfAborted();
		stage("Existing runtime verified");
		return join(installed, "manager.mjs");
	}

	await mkdir(parent, { recursive: true });
	signal?.throwIfAborted();
	const temporary = await mkdtemp(`${installed}.tmp-`);
	try {
		stage("Extracting runtime");
		await extractRuntime(archive, temporary, signal);
		stage("Runtime extracted");
		await validateInstalledRuntime(temporary);
		signal?.throwIfAborted();
		await writeFile(
			join(temporary, ".cohub-runtime.json"),
			`${JSON.stringify({ schemaVersion: 1, sha256: manifest.sha256 })}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		signal?.throwIfAborted();
		await rename(temporary, installed);
		stage("Runtime installed");
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}; installation files preserved at ${temporary}`, { cause: error });
	}
	return join(installed, "manager.mjs");
}
