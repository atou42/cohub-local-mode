import {
  access,
  constants,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const WEB_IMMUTABLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const immutableRelativeRoot = "cloudflare/assets/_app/immutable";
const retentionMetadataRelativePath = "local-mode-retention.json";

const requiredFiles = [
  "cloudflare/_worker.js",
  "cloudflare/assets/_app/version.json",
  "cloudflare/assets/preboot-recovery.js",
  "cloudflare-tmp/manifest.js",
  "output/client/preboot-recovery.js",
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

async function isGeneratedSvelteKitDirectory(buildDir) {
  let tsconfigStat;
  let generatedStat;
  try {
    [tsconfigStat, generatedStat] = await Promise.all([
      stat(join(buildDir, "tsconfig.json")),
      stat(join(buildDir, "generated")),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!tsconfigStat.isFile() || !generatedStat.isDirectory()) return false;
  try {
    await access(join(buildDir, "cloudflare/_worker.js"));
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
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

function resolveBuildDependency(buildDir, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Staged web manifest has an invalid dependency ${String(relativePath)}`);
  }
  const root = resolve(buildDir);
  const dependency = resolve(root, relativePath);
  const pathFromRoot = relative(root, dependency);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Staged web manifest dependency escapes the client root: ${relativePath}`);
  }
  return dependency;
}

async function readManifestDependencies(buildDir) {
  const manifestPath = join(buildDir, "output/client/.vite/manifest.json");
  await assertNonEmptyFile(buildDir, "output/client/.vite/manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Staged web build has an invalid output/client/.vite/manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Staged web build has an invalid output/client/.vite/manifest.json root");
  }

  const dependencies = new Set();
  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Staged web build has an invalid manifest entry");
    }
    if ("file" in entry) {
      if (typeof entry.file !== "string") {
        throw new Error("Staged web build has an invalid manifest file dependency");
      }
      dependencies.add(entry.file);
    }
    for (const field of ["css", "assets"]) {
      if (!(field in entry)) continue;
      if (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== "string")) {
        throw new Error(`Staged web build has an invalid manifest ${field} dependency`);
      }
      for (const dependency of entry[field]) dependencies.add(dependency);
    }
  }

  return dependencies;
}

async function assertManifestDependencies(buildDir) {
  const dependencies = await readManifestDependencies(buildDir);
  for (const dependency of dependencies) {
    for (const root of ["output/client", "cloudflare/assets"]) {
      const dependencyRoot = join(buildDir, root);
      const dependencyPath = resolveBuildDependency(dependencyRoot, dependency);
      const relativeDependency = relative(buildDir, dependencyPath);
      try {
        const dependencyStat = await stat(dependencyPath);
        if (!dependencyStat.isFile() || dependencyStat.size === 0) {
          throw new Error(`Staged web build has an empty manifest dependency ${relativeDependency}`);
        }
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`Staged web build is missing manifest dependency ${relativeDependency}`);
        }
        throw error;
      }
    }
  }
}

export async function listAllWebImmutableAssets(buildDir) {
  const root = join(buildDir, immutableRelativeRoot);
  const assets = [];
  async function visit(relativeDir = "") {
    let entries;
    try {
      entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Web retention source is missing ${immutableRelativeRoot}`);
      }
      throw error;
    }
    for (const entry of entries) {
      const relativePath = join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      await assertNonEmptyFile(buildDir, join(immutableRelativeRoot, relativePath));
      assets.push(`_app/immutable/${relativePath.split("\\").join("/")}`);
    }
  }
  await visit();
  if (assets.length === 0) throw new Error("Web retention source has no immutable assets");
  return assets.sort();
}

async function readCurrentBuildImmutableAssets(buildDir) {
  const dependencies = await readManifestDependencies(buildDir);
  const assets = [...dependencies].filter((path) =>
    path.startsWith("_app/immutable/"),
  );
  if (assets.length === 0) {
    throw new Error("Web build manifest has no immutable assets");
  }
  for (const asset of assets) {
    await assertNonEmptyFile(buildDir, join("cloudflare/assets", asset));
  }
  return assets.sort();
}

function resolveRetainedAsset(buildDir, asset) {
  const prefix = "_app/immutable/";
  if (
    typeof asset !== "string" ||
    !asset.startsWith(prefix) ||
    isAbsolute(asset)
  ) {
    throw new Error(`Web retention metadata has an invalid asset path: ${String(asset)}`);
  }
  return resolveBuildDependency(
    join(buildDir, immutableRelativeRoot),
    asset.slice(prefix.length),
  );
}

async function copyRetainedAsset({ currentDir, stagedDir, asset }) {
  const source = resolveRetainedAsset(currentDir, asset);
  const sourceStat = await stat(source).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Web retention metadata references a missing asset: ${asset}`);
    }
    throw error;
  });
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`Web retention metadata references an empty asset: ${asset}`);
  }
  const destination = resolveRetainedAsset(stagedDir, asset);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await utimes(destination, sourceStat.atime, sourceStat.mtime);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const destinationStat = await stat(destination);
    if (!destinationStat.isFile() || destinationStat.size !== sourceStat.size) {
      throw new Error(`Web immutable asset collision differs: ${asset}`);
    }
    const [sourceDigest, destinationDigest] = await Promise.all([
      digestFile(source),
      digestFile(destination),
    ]);
    if (sourceDigest !== destinationDigest) {
      throw new Error(`Web immutable asset collision differs: ${asset}`);
    }
  }
}

async function digestFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function mergeRetainedImmutableAssets({ currentDir, stagedDir, now }) {
  const currentVersion = await readBuildVersion(currentDir);
  const currentAssets = await readCurrentBuildImmutableAssets(currentDir);
  const retainedVersions = (
    await readRetainedWebBuildVersions(currentDir, { now })
  ).filter(
    (record) => Date.parse(record.retainedAt) >= now - WEB_IMMUTABLE_RETENTION_MS,
  );
  const assets = new Set([
    ...currentAssets,
    ...retainedVersions.flatMap((record) =>
      record.assets.map((asset) => asset.path),
    ),
  ]);
  for (const asset of assets) {
    await copyRetainedAsset({ currentDir, stagedDir, asset });
  }
  return { currentVersion, currentAssets, retainedVersions };
}

async function readBuildVersion(buildDir) {
  const versionPath = join(
    buildDir,
    "cloudflare/assets/_app/version.json",
  );
  await assertNonEmptyFile(buildDir, "cloudflare/assets/_app/version.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(versionPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Web build has an invalid version file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = String(parsed?.version ?? "").trim();
  if (!version) throw new Error("Web build version is missing");
  return version;
}

export async function readRetainedWebBuildVersions(
  buildDir,
  { now = Date.now() } = {},
) {
  const metadataPath = join(buildDir, retentionMetadataRelativePath);
  let contents;
  try {
    contents = await readFile(metadataPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Web retention metadata is invalid JSON: ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed?.builds)) {
    throw new Error(`Web retention metadata has an invalid builds list: ${metadataPath}`);
  }
  const records = [];
  for (const record of parsed.builds) {
    const version = String(record?.version ?? "").trim();
    const retainedAt = String(record?.retainedAt ?? "").trim();
    const retainedTime = Date.parse(retainedAt);
    if (
      !version ||
      !Number.isFinite(retainedTime) ||
      retainedTime > now ||
      !Array.isArray(record?.assets) ||
      record.assets.length === 0
    ) {
      throw new Error(`Web retention metadata has an invalid build record: ${metadataPath}`);
    }
    const assets = [];
    const seenAssets = new Set();
    for (const asset of record.assets) {
      const path = String(asset?.path ?? "").trim();
      const sha256 = String(asset?.sha256 ?? "").trim();
      if (!/^[a-f0-9]{64}$/.test(sha256) || seenAssets.has(path)) {
        throw new Error(`Web retention metadata has an invalid asset record: ${metadataPath}`);
      }
      seenAssets.add(path);
      const assetPath = resolveRetainedAsset(buildDir, path);
      const assetStat = await stat(assetPath).catch((error) => {
        if (error?.code === "ENOENT") {
          throw new Error(`Web retention metadata references a missing asset: ${path}`);
        }
        throw error;
      });
      if (!assetStat.isFile() || assetStat.size === 0) {
        throw new Error(`Web retention metadata references an empty asset: ${path}`);
      }
      if ((await digestFile(assetPath)) !== sha256) {
        throw new Error(`Web retention metadata references a modified asset: ${path}`);
      }
      assets.push({ path, sha256 });
    }
    records.push({ version, retainedAt, assets });
  }
  return records;
}

export async function recordRetainedWebBuildVersion({
  buildDir,
  version,
  assets,
  retainedVersions = [],
  now = Date.now(),
}) {
  const normalizedVersion = String(version ?? "").trim();
  if (!normalizedVersion) throw new Error("Retained Web build version is empty");
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("Retained Web build assets are empty");
  }
  const assetRecords = [];
  for (const asset of assets) {
    const assetPath = resolveRetainedAsset(buildDir, asset);
    const assetStat = await stat(assetPath);
    if (!assetStat.isFile() || assetStat.size === 0) {
      throw new Error(`Retained Web build asset is empty: ${asset}`);
    }
    assetRecords.push({ path: asset, sha256: await digestFile(assetPath) });
  }
  const existing = await readRetainedWebBuildVersions(buildDir, { now });
  const cutoff = now - WEB_IMMUTABLE_RETENTION_MS;
  const builds = [
    ...retainedVersions.filter(
      (record) => Date.parse(record.retainedAt) >= cutoff,
    ),
    ...existing.filter((record) => Date.parse(record.retainedAt) >= cutoff),
    {
      version: normalizedVersion,
      retainedAt: new Date(now).toISOString(),
      assets: assetRecords.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    },
  ];
  const unique = new Map(builds.map((record) => [record.version, record]));
  await writeFile(
    join(buildDir, retentionMetadataRelativePath),
    `${JSON.stringify({ builds: [...unique.values()] }, null, 2)}\n`,
  );
}

export async function assertWebBuildReady(buildDir) {
  for (const relativePath of requiredFiles) {
    await assertNonEmptyFile(buildDir, relativePath);
  }
  await assertManifestDependencies(buildDir);
  const immutableRoot = immutableRelativeRoot;
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

export async function assertWebRetentionBaselineReady(buildDir) {
  for (const relativePath of [
    "cloudflare/assets/_app/version.json",
    "output/client/.vite/manifest.json",
  ]) {
    await assertNonEmptyFile(buildDir, relativePath);
  }
  await assertManifestDependencies(buildDir);
  await assertMatchingFile(
    buildDir,
    join(immutableRelativeRoot, "entry"),
    /^start\..+\.js$/,
    "client start entry",
  );
  await assertMatchingFile(
    buildDir,
    join(immutableRelativeRoot, "entry"),
    /^app\..+\.js$/,
    "client app entry",
  );
}

export async function publishWebBuild({
  currentDir,
  stagedDir,
  now = Date.now(),
  replaceGeneratedCurrent = false,
}) {
  let hasCurrent = true;
  try {
    await access(currentDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    hasCurrent = false;
  }
  const generatedCurrent =
    hasCurrent &&
    replaceGeneratedCurrent &&
    (await isGeneratedSvelteKitDirectory(currentDir));
  if (hasCurrent && !generatedCurrent) {
    const retention = await mergeRetainedImmutableAssets({
      currentDir,
      stagedDir,
      now,
    });
    await recordRetainedWebBuildVersion({
      buildDir: stagedDir,
      version: retention.currentVersion,
      assets: retention.currentAssets,
      retainedVersions: retention.retainedVersions,
      now,
    });
  }
  await assertWebBuildReady(stagedDir);
  const backupDir = `${currentDir}.previous-${process.pid}-${Date.now()}`;
  const hadCurrent = hasCurrent;

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
