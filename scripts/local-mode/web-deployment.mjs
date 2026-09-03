import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_IMMUTABLE_RETENTION_MS } from "./web-release.mjs";

const deploymentMessagePrefix = "cohub-local-web build ";
const deploymentMessagePattern =
  /^cohub-local-web build (\S+) relay-node (\d+) relay-browser (\d+) event-schema (\d+)$/;

function normalizeCompatibility(compatibility) {
  const values = {
    nodeProtocolVersion: compatibility?.nodeProtocolVersion,
    browserProtocolVersion: compatibility?.browserProtocolVersion,
    eventSchemaVersion: compatibility?.eventSchemaVersion,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`The local Web ${name} is invalid`);
    }
  }
  return values;
}

export function buildWebDeploymentMessage(version, compatibility) {
  const normalized = String(version ?? "").trim();
  if (!normalized) throw new Error("The local web build version is empty");
  const compatible = normalizeCompatibility(compatibility);
  return `${deploymentMessagePrefix}${normalized} relay-node ${compatible.nodeProtocolVersion} relay-browser ${compatible.browserProtocolVersion} event-schema ${compatible.eventSchemaVersion}`;
}

function readDeploymentMarker(deployment) {
  const message = deployment?.annotations?.["workers/message"];
  if (typeof message !== "string") {
    return null;
  }
  const match = message.match(deploymentMessagePattern);
  if (!match) return null;
  return {
    version: match[1],
    nodeProtocolVersion: Number(match[2]),
    browserProtocolVersion: Number(match[3]),
    eventSchemaVersion: Number(match[4]),
  };
}

function readDeploymentVersion(deployment) {
  const marker = readDeploymentMarker(deployment);
  if (marker) return marker.version;
  const message = deployment?.annotations?.["workers/message"];
  if (typeof message !== "string") return null;
  const legacyMatch = message.match(/^cohub-local-web build (\S+)$/);
  return legacyMatch?.[1] ?? null;
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

export function assertWebDeploymentMatches({
  localVersion,
  compatibility,
  deployments,
}) {
  const normalizedLocalVersion = String(localVersion ?? "").trim();
  if (!normalizedLocalVersion) {
    throw new Error("The local web build version is empty");
  }
  const deployment = newestDeployment(deployments);
  if (
    !Array.isArray(deployment?.versions) ||
    deployment.versions.length !== 1 ||
    deployment.versions[0]?.percentage !== 100
  ) {
    throw new Error(
      "Refusing to restart Local Mode: the latest public Web Worker is not deployed at 100%.",
    );
  }
  const marker = readDeploymentMarker(deployment);
  if (!marker) {
    throw new Error(
      "The latest public Worker deployment does not identify its Web build and Relay compatibility. Run `pnpm local:release` before restarting Local Mode.",
    );
  }
  if (marker.version !== normalizedLocalVersion) {
    throw new Error(
      `Refusing to restart Local Mode: local web build ${normalizedLocalVersion} does not match public Worker build ${marker.version}. Run \`pnpm local:release\` to publish them together.`,
    );
  }
  const expected = normalizeCompatibility(compatibility);
  for (const name of [
    "nodeProtocolVersion",
    "browserProtocolVersion",
    "eventSchemaVersion",
  ]) {
    if (marker[name] !== expected[name]) {
      throw new Error(
        `Refusing to restart Local Mode: public Web ${name} ${marker[name]} does not match local ${expected[name]}.`,
      );
    }
  }
  return deployment;
}

export function assertWebRetentionBaseline({
  localVersion,
  retainedVersions = [],
  deployments,
  now = Date.now(),
}) {
  const normalizedLocalVersion = String(localVersion ?? "").trim();
  if (!normalizedLocalVersion) {
    throw new Error("The local web retention baseline version is empty");
  }
  const deployment = newestDeployment(deployments);
  if (
    !Array.isArray(deployment?.versions) ||
    deployment.versions.length !== 1 ||
    deployment.versions[0]?.percentage !== 100
  ) {
    throw new Error(
      "Refusing to build Local Mode: the current public Web Worker is not deployed at 100%.",
    );
  }
  const publicVersion = readDeploymentVersion(deployment);
  if (!publicVersion) {
    throw new Error(
      "Refusing to build Local Mode: the current public Web deployment has no auditable build version.",
    );
  }
  const cutoff = now - WEB_IMMUTABLE_RETENTION_MS;
  const retained = new Set();
  for (const entry of retainedVersions) {
    const version = String(entry?.version ?? "").trim();
    const retainedAt = Date.parse(String(entry?.retainedAt ?? ""));
    if (
      !version ||
      !Number.isFinite(retainedAt) ||
      retainedAt < cutoff ||
      retainedAt > now ||
      !Array.isArray(entry?.assets) ||
      entry.assets.length === 0
    ) {
      continue;
    }
    retained.add(version);
  }
  if (publicVersion !== normalizedLocalVersion && !retained.has(publicVersion)) {
    throw new Error(
      `Refusing to build Local Mode: local build ${normalizedLocalVersion} does not retain public Web build ${publicVersion}. Restore the deployed build before releasing.`,
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
