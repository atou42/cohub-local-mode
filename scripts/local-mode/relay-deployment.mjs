import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const deploymentMessagePrefix = "cohub-local-relay source ";
const requiredRelaySecrets = [
  "NODE_TOKEN",
  "OWNER_EMAIL",
  "OWNER_USER_ID",
  "POLICY_AUD",
  "TEAM_DOMAIN",
];

export function buildRelayDeploymentMessage(version) {
  const normalized = String(version ?? "").trim();
  if (!normalized) throw new Error("The local Relay source version is empty");
  return `${deploymentMessagePrefix}${normalized}`;
}

function readDeploymentVersion(deployment) {
  const message = deployment?.annotations?.["workers/message"];
  if (
    typeof message !== "string" ||
    !message.startsWith(deploymentMessagePrefix)
  ) {
    return null;
  }
  const version = message.slice(deploymentMessagePrefix.length).trim();
  return version || null;
}

function newestDeployment(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("Cloudflare returned no cohub-local-relay deployments");
  }
  return [...deployments].sort((left, right) => {
    const leftTime = Date.parse(left?.created_on ?? "");
    const rightTime = Date.parse(right?.created_on ?? "");
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
      throw new Error(
        "Cloudflare returned a Relay deployment without a valid creation time",
      );
    }
    return rightTime - leftTime;
  })[0];
}

function isFullyDeployed(deployment) {
  return (
    Array.isArray(deployment?.versions) &&
    deployment.versions.length === 1 &&
    deployment.versions[0]?.percentage === 100
  );
}

export function assertRelayDeploymentMatches({ localVersion, deployments }) {
  const normalizedLocalVersion = String(localVersion ?? "").trim();
  if (!normalizedLocalVersion) {
    throw new Error("The local Relay source version is empty");
  }
  const deployment = newestDeployment(deployments);
  if (!isFullyDeployed(deployment)) {
    throw new Error(
      "Refusing to restart Local Mode: the latest public Relay is not deployed at 100%.",
    );
  }
  const publicVersion = readDeploymentVersion(deployment);
  if (!publicVersion) {
    throw new Error(
      "The latest public Relay deployment does not identify its Relay source. Run `pnpm local:release` before restarting Local Mode.",
    );
  }
  if (publicVersion !== normalizedLocalVersion) {
    throw new Error(
      `Refusing to restart Local Mode: local Relay ${normalizedLocalVersion} does not match public Relay ${publicVersion}. Run \`pnpm local:release\` to publish them together.`,
    );
  }
  return deployment;
}

export function assertRelaySecrets(secrets) {
  const configured = new Set(
    Array.isArray(secrets)
      ? secrets.flatMap((secret) =>
          typeof secret?.name === "string" ? [secret.name] : [],
        )
      : [],
  );
  const missing = requiredRelaySecrets.filter((name) => !configured.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to deploy Local Mode Relay: missing required secrets: ${missing.join(", ")}`,
    );
  }
}

export function assertRelayHealth(health, expected) {
  if (!health || health.status !== "ready") {
    throw new Error("The public Local Mode Relay is not ready");
  }
  if (health.protocolVersion !== expected.protocolVersion) {
    throw new Error(
      `The public Relay protocol mismatch: node=${expected.protocolVersion} relay=${health.protocolVersion ?? "missing"}`,
    );
  }
  if (health.eventSchemaVersion !== expected.eventSchemaVersion) {
    throw new Error(
      `The public Relay event schema mismatch: node=${expected.eventSchemaVersion} relay=${health.eventSchemaVersion ?? "missing"}`,
    );
  }
}

export function relayHealthUrl(connectionUrl) {
  const url = new URL(connectionUrl);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("The Local Mode Relay connection URL must use WebSocket");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function waitForRelayHealth(input) {
  let lastError;
  for (let attempt = 0; attempt < (input.attempts ?? 12); attempt += 1) {
    try {
      const response = await (input.fetcher ?? fetch)(input.url, {
        cache: "no-store",
        signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        throw new Error(`Relay health returned HTTP ${response.status}`);
      }
      const health = await response.json();
      assertRelayHealth(health, input.expected);
      return health;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < (input.attempts ?? 12)) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      }
    }
  }
  throw new Error(
    `The public Local Mode Relay failed its health gate: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function listProductionFiles(root, directory) {
  const absolute = join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listProductionFiles(root, relative(root, path))));
      continue;
    }
    if (!entry.isFile() || /\.test\.[cm]?[jt]s$/.test(entry.name)) continue;
    if (!/\.(?:ts|mjs|json|toml)$/.test(entry.name)) continue;
    files.push(path);
  }
  return files;
}

export async function readLocalRelaySourceVersion(repoRoot) {
  const files = [
    ...(await listProductionFiles(repoRoot, "apps/local-relay/src")),
    ...(await listProductionFiles(repoRoot, "apps/local-relay/node")),
    join(repoRoot, "apps/local-relay/package.json"),
    join(repoRoot, "apps/local-relay/wrangler.toml"),
  ].sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(repoRoot, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}
