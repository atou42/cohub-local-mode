import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadCodexUserRules() {
	const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
	try {
		const rules = readFileSync(join(codexHome, "AGENTS.md"), "utf8").trim();
		return rules || null;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code)
			: undefined;
		if (code === "ENOENT") return null;
		throw error;
	}
}

export function buildGrokAppServerArgv(
	accessMode: "full_access" | "read_only",
	sandboxProfile = "workspace",
) {
	const argv = [
		"grok",
		"--sandbox",
		accessMode === "read_only" ? "read-only" : sandboxProfile,
	];
	if (accessMode === "full_access") argv.push("--always-approve");
	else argv.push("--tools", "read_file,grep,list_dir,web_search,web_fetch");

	const codexUserRules = loadCodexUserRules();
	if (codexUserRules) argv.push("--rules", codexUserRules);
	argv.push("agent", "stdio");
	return argv;
}
