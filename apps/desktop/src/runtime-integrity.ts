import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

export type RuntimeIntegrityEntry =
	| { path: string; type: "directory" }
	| { path: string; type: "symlink"; target: string }
	| { path: string; type: "file"; size: number; executable: number; sha256: string };

type IntegrityFile = { path: string; fullPath: string };

function hashFiles(files: IntegrityFile[]): RuntimeIntegrityEntry[] {
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	return files.map((file) => {
		const before = lstatSync(file.fullPath);
		if (!before.isFile()) throw new Error(`Runtime integrity: file type changed: ${file.path}`);
		const hash = createHash("sha256");
		const descriptor = openSync(file.fullPath, "r");
		try {
			for (;;) {
				const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
				if (!bytes) break;
				hash.update(buffer.subarray(0, bytes));
			}
		} finally { closeSync(descriptor); }
		const after = lstatSync(file.fullPath);
		if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !after.isFile()) throw new Error(`Runtime integrity: file changed while checking: ${file.path}`);
		return { path: file.path, type: "file", size: after.size, executable: after.mode & 0o111, sha256: hash.digest("hex") };
	});
}

if (!isMainThread && workerData?.kind === "cohub-runtime-integrity-files") {
	parentPort?.postMessage(hashFiles(workerData.files));
}

async function hashFilesOffThread(files: IntegrityFile[], signal?: AbortSignal) {
	const count = Math.min(4, files.length);
	const workers: Worker[] = [];
	try {
		return (await Promise.all(Array.from({ length: count }, (_, index) => new Promise<RuntimeIntegrityEntry[]>((yes, no) => {
			signal?.throwIfAborted();
			const worker = new Worker(new URL(import.meta.url), {
				workerData: { kind: "cohub-runtime-integrity-files", files: files.filter((_, fileIndex) => fileIndex % count === index) },
			});
			workers.push(worker);
			let result: RuntimeIntegrityEntry[] | undefined;
			const abort = () => { void worker.terminate(); };
			signal?.addEventListener("abort", abort, { once: true });
			worker.once("message", (entries: RuntimeIntegrityEntry[]) => { result = entries; });
			worker.once("error", no);
			worker.once("exit", (code) => {
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) no(signal.reason);
				else if (code !== 0 || !result) no(new Error(`Runtime integrity worker exited without a result (${code})`));
				else yes(result);
			});
		})))).flat();
	} catch (error) {
		await Promise.all(workers.map((worker) => worker.terminate()));
		throw error;
	}
}

export async function collectRuntimeIntegrity(root: string, signal?: AbortSignal): Promise<RuntimeIntegrityEntry[]> {
	const directory = resolve(root);
	const entries: RuntimeIntegrityEntry[] = [];
	const files: IntegrityFile[] = [];
	let directories = [directory];
	while (directories.length) {
		const next: string[] = [];
		let directoryIndex = 0;
		await Promise.all(Array.from({ length: Math.min(16, directories.length) }, async () => {
			for (;;) {
				const current = directories[directoryIndex++];
				if (!current) return;
				signal?.throwIfAborted();
				for (const entry of await readdir(current, { withFileTypes: true })) {
					const fullPath = join(current, entry.name);
					const path = relative(directory, fullPath);
					if (path === ".cohub-runtime.json") continue;
					if (entry.isDirectory()) {
						entries.push({ path, type: "directory" });
						next.push(fullPath);
					} else if (entry.isSymbolicLink()) {
						const target = await readlink(fullPath);
						const resolved = relative(directory, resolve(dirname(fullPath), target));
						if (isAbsolute(target) || resolved === ".." || resolved.startsWith("../")) throw new Error(`Runtime integrity: symlink escapes the installation: ${path}`);
						entries.push({ path, type: "symlink", target });
					} else if (entry.isFile()) files.push({ path, fullPath });
					else throw new Error(`Runtime integrity: unsupported entry: ${path}`);
				}
			}
		}));
		directories = next;
	}
	// Keep the Electron main thread responsive while checking every executable byte.
	entries.push(...await hashFilesOffThread(files, signal));
	return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function parseRuntimeIntegrity(value: unknown): RuntimeIntegrityEntry[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Runtime integrity manifest is empty or invalid");
	const paths = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry.path !== "string" || !entry.path || entry.path === ".cohub-runtime.json" || isAbsolute(entry.path) || entry.path.split("/").some((part: string) => part === ".." || part === "." || !part) || paths.has(entry.path)) throw new Error("Runtime integrity manifest path is invalid");
		paths.add(entry.path);
		if (entry.type === "file") {
			if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isInteger(entry.executable) || (entry.executable & ~0o111) !== 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Runtime integrity file identity is invalid");
		} else if (entry.type === "symlink") {
			if (typeof entry.target !== "string" || !entry.target || isAbsolute(entry.target)) throw new Error("Runtime integrity symlink is invalid");
		} else if (entry.type !== "directory") throw new Error("Runtime integrity entry type is invalid");
	}
	return value;
}

export async function verifyRuntimeIntegrity(root: string, expected: RuntimeIntegrityEntry[], signal?: AbortSignal) {
	const actual = await collectRuntimeIntegrity(root, signal);
	const baseline = new Map(parseRuntimeIntegrity(expected).map((entry) => [entry.path, entry]));
	if (actual.length !== baseline.size) throw new Error("Runtime integrity: installed file inventory changed");
	for (const entry of actual) {
		const previous = baseline.get(entry.path);
		if (!previous || previous.type !== entry.type ||
			(entry.type === "file" && previous.type === "file" && (entry.sha256 !== previous.sha256 || entry.size !== previous.size || entry.executable !== previous.executable)) ||
			(entry.type === "symlink" && previous.type === "symlink" && entry.target !== previous.target)) throw new Error(`Runtime integrity checksum mismatch: ${entry.path}`);
	}
}
