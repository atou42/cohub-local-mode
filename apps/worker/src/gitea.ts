import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const SAFE_REPO_NAME = /^[a-zA-Z0-9._-]+$/;

function localRepoPath(name: string) {
	if (!config.localGitRoot) return null;
	if (!SAFE_REPO_NAME.test(name) || name === "." || name === "..") {
		throw new Error("Invalid internal repository name");
	}
	return join(config.localGitRoot, `${name}.git`);
}

async function ensureLocalRepository(name: string) {
	const repoPath = localRepoPath(name);
	if (!repoPath || !config.localGitRoot) return null;
	await mkdir(config.localGitRoot, { recursive: true });
	const existing = await stat(repoPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	if (existing && !existing.isDirectory()) {
		throw new Error(`Internal repository path is not a directory: ${repoPath}`);
	}
	if (!existing) {
		await execFileAsync("git", ["init", "--bare", repoPath]);
		return { name, alreadyExists: false };
	}
	const { stdout } = await execFileAsync("git", [
		"--git-dir",
		repoPath,
		"rev-parse",
		"--is-bare-repository",
	]);
	if (stdout.trim() !== "true") {
		throw new Error(`Internal repository is corrupt: ${repoPath}`);
	}
	return { name, alreadyExists: true };
}

const authHeaders = () => {
  if (!config.giteaToken) throw new Error("GITEA_TOKEN is not configured");
  return { Authorization: `token ${config.giteaToken}` };
};

export const createInternalRepository = async (name: string, isPrivate = true) => {
  const local = await ensureLocalRepository(name);
  if (local) return local;
  const response = await fetch(`${config.giteaBaseUrl}/api/v1/orgs/${encodeURIComponent(config.giteaOrg)}/repos`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });

  if (response.status === 409) return { name, alreadyExists: true };
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Gitea create internal repo error: ${response.status} ${text}`);
  }

  return response.json();
};

export const buildInternalRepoRemoteUrl = (repoName: string) => {
  const repoPath = localRepoPath(repoName);
  if (repoPath) return pathToFileURL(repoPath).href;
  if (!config.giteaToken) throw new Error("GITEA_TOKEN is not configured");
  const base = new URL(config.giteaBaseUrl);
  base.username = "x-access-token";
  base.password = config.giteaToken;
  base.pathname = `/${config.giteaOrg}/${repoName}.git`;
  return base.toString();
};
