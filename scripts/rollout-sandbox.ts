#!/usr/bin/env tsx
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

type CliOptions = {
  kubeconfig: string;
  apiNamespace: string;
  apiLabel: string;
  concurrency: number;
  limit: number;
  timeoutMs: number;
  settleMs: number;
  dryRun: boolean;
  spaceIds: string[];
  image?: "default" | "game";
};

const parseArgs = (argv: string[]) => {
  const options: CliOptions = {
    kubeconfig: process.env.KUBECONFIG || "~/.kube/config_us",
    apiNamespace: process.env.COHUB_API_NAMESPACE || "cohub",
    apiLabel: process.env.COHUB_API_LABEL || "app.kubernetes.io/name=cohub-api",
    concurrency: Number.parseInt(process.env.COHUB_SANDBOX_ROLLOUT_CONCURRENCY ?? "10", 10) || 10,
    limit: Number.parseInt(process.env.COHUB_SANDBOX_ROLLOUT_LIMIT ?? "0", 10) || 0,
    timeoutMs: Number.parseInt(process.env.COHUB_SANDBOX_ROLLOUT_TIMEOUT_MS ?? "180000", 10) || 180_000,
    settleMs: Number.parseInt(process.env.COHUB_SANDBOX_ROLLOUT_SETTLE_MS ?? "20000", 10) || 20_000,
    dryRun: false,
    spaceIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--kubeconfig" && next) {
      options.kubeconfig = next;
      index += 1;
      continue;
    }
    if (arg === "--namespace" && next) {
      options.apiNamespace = next;
      index += 1;
      continue;
    }
    if (arg === "--label" && next) {
      options.apiLabel = next;
      index += 1;
      continue;
    }
    if (arg === "--concurrency" && next) {
      options.concurrency = Math.max(1, Number.parseInt(next, 10) || options.concurrency);
      index += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      options.limit = Math.max(0, Number.parseInt(next, 10) || 0);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Math.max(30_000, Number.parseInt(next, 10) || options.timeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--settle-ms" && next) {
      options.settleMs = Math.max(0, Number.parseInt(next, 10) || options.settleMs);
      index += 1;
      continue;
    }
    if (arg === "--space-id" && next) {
      options.spaceIds.push(next.trim());
      index += 1;
      continue;
    }
    if (arg === "--image" && next) {
      if (next !== "default" && next !== "game") throw new Error("Unknown sandbox image");
      options.image = next;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  options.spaceIds = Array.from(new Set(options.spaceIds.filter((value) => value.length > 0)));
  return options;
};

const expandPath = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

const options = parseArgs(process.argv.slice(2));
options.kubeconfig = expandPath(options.kubeconfig);

const runKubectl = (args: string[]) => {
  return execFileSync(
    "kubectl",
    [...(options.kubeconfig ? ["--kubeconfig", options.kubeconfig] : []), ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
};

const runKubectlExec = (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "kubectl",
      [...(options.kubeconfig ? ["--kubeconfig", options.kubeconfig] : []), ...args],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs + 60_000);
    killTimer.unref();
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const more = process.stdout.write(chunk);
      if (!more) {
        child.stdout.pause();
        process.stdout.once("drain", () => {
          child.stdout.resume();
        });
      }
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve(Buffer.concat(chunks).toString().trim());
      else reject(new Error(`kubectl exec exited with code ${code}`));
    });
    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
  });
};

const apiPod = runKubectl([
  "-n",
  options.apiNamespace,
  "get",
  "pods",
  "-l",
  options.apiLabel,
  "-o",
  "jsonpath={.items[0].metadata.name}",
]);

if (!apiPod) {
  throw new Error(`No API pod found in namespace ${options.apiNamespace} with label ${options.apiLabel}`);
}

const tempDir = mkdtempSync(join(tmpdir(), "cohub-sandbox-rollout-"));
const localScriptPath = join(tempDir, "rollout-inner.mjs");
const remoteScriptPath = "/tmp/cohub-sandbox-rollout.mjs";

const innerScript = `
import { k8sCoreApi } from '/app/dist/k8s.js';
import { sessionsNamespace } from '/app/dist/config.js';
import { resolveSpaceSandboxPreferences } from '/app/dist/space-sandbox-preferences.js';
import { getSpaceSandboxBySpaceId, listSandboxRolloutTargets, reconcileSpaceSandbox, toSandboxImageVersion } from '/app/dist/space-sandboxes.js';

const concurrency = ${JSON.stringify(options.concurrency)};
const limit = ${JSON.stringify(options.limit)};
const timeoutMs = ${JSON.stringify(options.timeoutMs)};
const settleMs = ${JSON.stringify(options.settleMs)};
const dryRun = ${JSON.stringify(options.dryRun)};
const selectedSpaceIds = new Set(${JSON.stringify(options.spaceIds)});
const targetVersion = 'per-space';
const imageFilter = ${JSON.stringify(options.image ?? null)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const allCandidates = await listSandboxRolloutTargets({ limit: 10_000 });
const pending = allCandidates.map((candidate, order) => ({ ...candidate, order })).filter((candidate) => candidate.podName && ['ready', 'running'].includes(candidate.status)
  && (selectedSpaceIds.size === 0 || selectedSpaceIds.has(candidate.spaceId)));
const filteredCandidates = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
  while (cursor < pending.length) {
    const candidate = pending[cursor++];
    const resolved = await resolveSpaceSandboxPreferences(candidate.spaceId);
    if (!resolved.applicable || (imageFilter && resolved.effective.image !== imageFilter)) continue;
    const version = toSandboxImageVersion(resolved.imageRef);
    if (candidate.desiredImage !== version || candidate.reportedImageVersion !== version) {
      filteredCandidates.push({ ...candidate, targetVersion: version, image: resolved.effective.image });
    }
  }
}));
filteredCandidates.sort((a, b) => a.order - b.order);
const candidates = limit > 0 ? filteredCandidates.slice(0, limit) : filteredCandidates;

if (selectedSpaceIds.size > 0) {
  const matched = new Set(candidates.map((candidate) => candidate.spaceId));
  const missing = [...selectedSpaceIds].filter((spaceId) => !matched.has(spaceId));
  if (missing.length > 0) {
    console.error(JSON.stringify({ phase: 'missing', missing }));
  }
}

if (candidates.length === 0) {
  console.error(JSON.stringify({ ok: true, targetVersion, total: 0, message: 'No sandbox rollout needed', dryRun }));
  process.exit(0);
}

console.error(JSON.stringify({
  phase: 'plan',
  targetVersion,
  total: candidates.length,
  concurrency,
  timeoutMs,
  settleMs,
  dryRun,
  selectedSpaceIds: [...selectedSpaceIds],
  candidates: candidates.map((candidate) => ({
    spaceId: candidate.spaceId,
    podName: candidate.podName,
    status: candidate.status,
    desiredImage: candidate.desiredImage,
    reportedImageVersion: candidate.reportedImageVersion,
    targetVersion: candidate.targetVersion,
    image: candidate.image,
  })),
}));

if (dryRun) {
  console.log(JSON.stringify({
    phase: 'summary',
    ok: true,
    dryRun: true,
    targetVersion,
    total: candidates.length,
    successCount: 0,
    failureCount: 0,
    failures: [],
  }));
  process.exit(0);
}

const waitForSandboxReady = async (spaceId, targetVersion) => {
  const podName = 'sandbox-' + spaceId;
  const startedAt = Date.now();
  let runningAt = null;

  while (Date.now() - startedAt < timeoutMs) {
    const sandbox = await getSpaceSandboxBySpaceId(spaceId);
    if (sandbox?.status === 'error') {
      throw new Error('sandbox entered error state: ' + spaceId);
    }

    try {
      const pod = await k8sCoreApi.readNamespacedPod({ name: podName, namespace: sessionsNamespace });
      const image = pod?.spec?.containers?.[0]?.image ?? '';
      const imageVersion = toSandboxImageVersion(image);
      const phase = pod?.status?.phase ?? '';
      const isRunningTarget = phase === 'Running' && imageVersion === targetVersion;
      const isReportedReady = sandbox?.status === 'ready' && sandbox?.reportedImageVersion === targetVersion;

      if (isRunningTarget && runningAt === null) runningAt = Date.now();
      if (isRunningTarget && isReportedReady) {
        return { podName, imageVersion, phase, mode: 'reported_ready' };
      }
      if (isRunningTarget && runningAt !== null && Date.now() - runningAt >= settleMs) {
        return { podName, imageVersion, phase, mode: 'running_settled' };
      }
    } catch {
      // continue polling
    }

    await sleep(2000);
  }

  throw new Error('timeout waiting for sandbox ready: ' + spaceId);
};

const queue = [...candidates];
const failures = [];
const successes = [];

const worker = async (workerId) => {
  while (queue.length > 0) {
    const target = queue.shift();
    if (!target) return;
    console.error(JSON.stringify({ phase: 'start', workerId, spaceId: target.spaceId, from: target.reportedImageVersion, to: target.targetVersion }));
    try {
      await reconcileSpaceSandbox({
        spaceId: target.spaceId,
        userUuid: target.userUuid,
        mode: 'replace',
        reason: 'manual_recreate',
      });
      const ready = await waitForSandboxReady(target.spaceId, target.targetVersion);
      successes.push({ spaceId: target.spaceId, podName: ready.podName, mode: ready.mode });
      console.error(JSON.stringify({ phase: 'done', workerId, spaceId: target.spaceId, podName: ready.podName, mode: ready.mode }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ spaceId: target.spaceId, error: message });
      console.error(JSON.stringify({ phase: 'failed', workerId, spaceId: target.spaceId, error: message }));
    }
  }
};

await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, (_, index) => worker(index + 1)));

const summary = {
  ok: failures.length === 0,
  dryRun: false,
  targetVersion,
  total: candidates.length,
  successCount: successes.length,
  failureCount: failures.length,
  failures,
  successes: successes.slice(0, 20),
};
console.log(JSON.stringify({ phase: 'summary', ...summary }));
process.exit(failures.length > 0 ? 1 : 0);
`;

writeFileSync(localScriptPath, innerScript);

(async () => {
  try {
    runKubectl(["-n", options.apiNamespace, "cp", localScriptPath, `${apiPod}:${remoteScriptPath}`]);
    console.log(`Using API pod: ${apiPod}`);
    console.log(
      `Rollout options: namespace=${options.apiNamespace} concurrency=${options.concurrency} limit=${options.limit || "all"} timeoutMs=${options.timeoutMs} settleMs=${options.settleMs} dryRun=${options.dryRun} spaceIds=${options.spaceIds.length > 0 ? options.spaceIds.join(",") : "all"}`,
    );
    const output = await runKubectlExec(["-n", options.apiNamespace, "exec", apiPod, "--", "node", remoteScriptPath]);

    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    const summaryLine = [...lines].reverse().find((line) => line.includes('"phase":"summary"') || line.includes('"ok"'));
    if (summaryLine) {
      const parsed = JSON.parse(summaryLine) as {
        ok: boolean;
        dryRun?: boolean;
        targetVersion: string;
        total: number;
        successCount: number;
        failureCount: number;
        failures?: Array<{ spaceId: string; error: string }>;
      };
      console.log("---");
      console.log(
        `Sandbox rollout summary: ok=${parsed.ok} dryRun=${parsed.dryRun ?? false} target=${parsed.targetVersion} total=${parsed.total} success=${parsed.successCount} failure=${parsed.failureCount}`,
      );
      if ((parsed.failures?.length ?? 0) > 0) {
        console.log("Failures:");
        for (const failure of parsed.failures ?? []) {
          console.log(`- ${failure.spaceId}: ${failure.error}`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Rollout failed: ${message}`);
    process.exit(1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
})();
