import { access, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const requiredFiles = [
  "cloudflare/_worker.js",
  "cloudflare/assets/_app/version.json",
  "cloudflare-tmp/manifest.js",
  "output/server/index.js",
];

async function assertNonEmptyFile(buildDir, relativePath) {
  const filePath = join(buildDir, relativePath);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Staged web build is missing ${relativePath}`);
    }
    throw error;
  }
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Staged web build has an empty ${relativePath}`);
  }
}

async function assertMatchingFile(buildDir, relativeDir, pattern, label) {
  const directory = join(buildDir, relativeDir);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Staged web build is missing ${relativeDir}`);
    }
    throw error;
  }
  const match = entries.find((entry) => entry.isFile() && pattern.test(entry.name));
  if (!match) throw new Error(`Staged web build is missing ${label}`);
  await assertNonEmptyFile(buildDir, join(relativeDir, match.name));
}

export async function assertWebBuildReady(buildDir) {
  for (const relativePath of requiredFiles) {
    await assertNonEmptyFile(buildDir, relativePath);
  }
  const immutableRoot = "cloudflare/assets/_app/immutable";
  await assertMatchingFile(
    buildDir,
    join(immutableRoot, "entry"),
    /^start\..+\.js$/,
    "client start entry",
  );
  await assertMatchingFile(
    buildDir,
    join(immutableRoot, "entry"),
    /^app\..+\.js$/,
    "client app entry",
  );
  await assertMatchingFile(
    buildDir,
    join(immutableRoot, "assets"),
    /\.css$/,
    "compiled stylesheet",
  );
}

export async function publishWebBuild({ currentDir, stagedDir }) {
  await assertWebBuildReady(stagedDir);
  const backupDir = `${currentDir}.previous-${process.pid}-${Date.now()}`;
  let hadCurrent = true;
  try {
    await access(currentDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    hadCurrent = false;
  }

  if (hadCurrent) await rename(currentDir, backupDir);
  try {
    await rename(stagedDir, currentDir);
  } catch (error) {
    if (hadCurrent) await rename(backupDir, currentDir);
    throw error;
  }
  if (hadCurrent) {
    try {
      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `Published the web build, but could not remove backup ${backupDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
