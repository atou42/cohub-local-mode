import { access, lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

async function existingDirectory(path) {
	try {
		const entry = await lstat(path);
		if (!entry.isDirectory()) throw new Error(`Bundled skills path is not a directory: ${path}`);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export async function resolveSkillsPath(dataRoot, home, configured) {
	for (const candidate of [configured, join(home, ".agents", "skills"), join(home, ".codex", "skills")]) {
		if (!candidate) continue;
		try {
			await access(candidate);
			return candidate;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	// The sandbox makes the skills parent read-only; it must not contain Spaces.
	const fallback = join(dataRoot, "configs", "platform", ".agents", "skills");
	const legacy = join(dataRoot, "skills");
	const hasLegacy = await existingDirectory(legacy);
	const hasCurrent = await existingDirectory(fallback);
	if (hasLegacy && hasCurrent) throw new Error("Both legacy and current bundled skills exist; both directories were preserved");
	if (hasLegacy) {
		await mkdir(dirname(fallback), { recursive: true });
		await rename(legacy, fallback);
	} else if (!hasCurrent) await mkdir(fallback, { recursive: true });
	return fallback;
}
