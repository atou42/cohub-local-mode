import { readFile } from "node:fs/promises";
import { join } from "node:path";

const deploymentMessagePrefix = "cohub-local-web build ";

export function buildWebDeploymentMessage(version) {
  const normalized = String(version ?? "").trim();
  if (!normalized) throw new Error("The local web build version is empty");
  return `${deploymentMessagePrefix}${normalized}`;
}

function readDeploymentVersion(deployment) {
  const message = deployment?.annotations?.["workers/message"];
  if (typeof message !== "string" || !message.startsWith(deploymentMessagePrefix)) {
    return null;
  }
  const version = message.slice(deploymentMessagePrefix.length).trim();
  return version || null;
}

function newestDeployment(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("Cloudflare returned no cohub-local-web deployments");
  }
  return [...deployments].sort((left, right) => {
    const leftTime = Date.parse(left?.created_on ?? "");
    const rightTime = Date.parse(right?.created_on ?? "");
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
      throw new Error("Cloudflare returned a deployment without a valid creation time");
    }
    return rightTime - leftTime;
  })[0];
}

export function assertWebDeploymentMatches({ localVersion, deployments }) {
  const normalizedLocalVersion = String(localVersion ?? "").trim();
  if (!normalizedLocalVersion) {
    throw new Error("The local web build version is empty");
  }
  const deployment = newestDeployment(deployments);
  const publicVersion = readDeploymentVersion(deployment);
  if (!publicVersion) {
    throw new Error(
      "The latest public Worker deployment does not identify its web build. Run `pnpm local:release` before restarting Local Mode.",
    );
  }
  if (publicVersion !== normalizedLocalVersion) {
    throw new Error(
      `Refusing to restart Local Mode: local web build ${normalizedLocalVersion} does not match public Worker build ${publicVersion}. Run \`pnpm local:release\` to publish them together.`,
    );
  }
  return deployment;
}

export async function readLocalWebBuildVersion(repoRoot) {
  const versionPath = join(
    repoRoot,
    "apps/web/.svelte-kit/cloudflare/assets/_app/version.json",
  );
  const contents = await readFile(versionPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Local web build version is invalid JSON: ${versionPath}`, {
      cause: error,
    });
  }
  const version = String(parsed?.version ?? "").trim();
  if (!version) {
    throw new Error(`Local web build version is missing: ${versionPath}`);
  }
  return version;
}
