#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDiscordNonce,
  classifyUpstreamChanges,
  parseCommitLog,
  parsePathList,
  renderFailureReport,
  renderSuccessReport,
  validateWatchState,
} from "./upstream-watch-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noFetch = args.has("--no-fetch");
const jsonOutput = args.has("--json");
const allowedArgs = new Set(["--dry-run", "--no-fetch", "--json"]);
for (const argument of args) {
  if (!allowedArgs.has(argument)) throw new Error(`Unknown argument: ${argument}`);
}

const remote = process.env.COHUB_UPSTREAM_WATCH_REMOTE?.trim() || "upstream";
const branch = process.env.COHUB_UPSTREAM_WATCH_BRANCH?.trim() || "main";
const upstreamRef = `${remote}/${branch}`;
const threadId =
  process.env.COHUB_UPSTREAM_WATCH_THREAD_ID?.trim() || "1540358055563100230";
const senderRoot = resolve(
  process.env.COHUB_UPSTREAM_WATCH_SENDER_ROOT?.trim() ||
    join(homedir(), "agents-in-discord"),
);
const senderScript = resolve(
  process.env.COHUB_UPSTREAM_WATCH_SENDER?.trim() ||
    join(senderRoot, "scripts/send-channel-message.mjs"),
);
const stateDir = resolve(
  process.env.COHUB_UPSTREAM_WATCH_STATE_DIR?.trim() ||
    join(homedir(), ".cohub-upstream-watch"),
);
const reportsDir = join(stateDir, "reports");
const statePath = join(stateDir, "state.json");
const checkedAt = new Date().toISOString();
const runId = checkedAt.replaceAll(/[-:.]/g, "");
const reportBase = join(reportsDir, runId);
let stage = "initialize";

await mkdir(reportsDir, { recursive: true });

try {
  stage = "read state";
  const previousState = await readState();

  if (!noFetch) {
    stage = `fetch ${remote}/${branch}`;
    await run("git", ["fetch", "--prune", remote, branch]);
  }

  stage = "inspect git history";
  const localHead = await gitText(["rev-parse", "HEAD"]);
  const upstreamHead = await gitText(["rev-parse", upstreamRef]);
  const mergeBase = await gitText(["merge-base", "HEAD", upstreamRef]);
  const commits = parseCommitLog(
    await gitText([
      "log",
      "--format=%H%x09%ad%x09%s",
      "--date=short",
      `HEAD..${upstreamRef}`,
    ]),
  );
  const upstreamPaths = parsePathList(
    await gitText(["diff", "--name-only", `${mergeBase}..${upstreamRef}`]),
  );
  const localPaths = parsePathList(
    await gitText(["diff", "--name-only", `${mergeBase}..HEAD`]),
  );
  const previousUpstreamHead = previousState.lastUpstreamHead || "";
  const previousComparison = previousUpstreamHead
    ? await comparePreviousUpstream(previousUpstreamHead, upstreamRef)
    : { count: commits.length, historyChanged: false };
  const assessment = classifyUpstreamChanges({ commits, upstreamPaths, localPaths });
  if (previousComparison.historyChanged) {
    assessment.verdict = "rebase_now";
    assessment.verdictLabel = "建议立即检查上游历史并评估 rebase";
    assessment.reasons.unshift("上游历史不再包含上次检查的版本，可能发生了历史改写");
  }

  if (
    !dryRun &&
    previousState.lastCheckedAt &&
    shanghaiDate(previousState.lastCheckedAt) === shanghaiDate(checkedAt) &&
    previousState.lastLocalHead === localHead &&
    previousState.lastUpstreamHead === upstreamHead &&
    previousState.lastMessageId &&
    previousState.lastReportPath
  ) {
    printResult({
      ok: true,
      duplicate: true,
      verdict: previousState.lastVerdict,
      upstreamHead,
      messageId: previousState.lastMessageId,
      reportPath: previousState.lastReportPath,
      reportText: "今天相同上游版本的检查结论已经投递，本次未重复发送。",
    });
    process.exit(0);
  }

  const reportText = renderSuccessReport({
    checkedAt,
    localHead,
    upstreamHead,
    previousUpstreamHead,
    commits,
    newSinceLastCheck: previousComparison.count,
    assessment,
  });
  const report = {
    status: "success",
    checkedAt,
    localHead,
    upstreamHead,
    mergeBase,
    previousUpstreamHead: previousUpstreamHead || null,
    newSinceLastCheck: previousComparison.count,
    historyChanged: previousComparison.historyChanged,
    commitCount: commits.length,
    commits,
    upstreamPaths,
    localPaths,
    assessment,
    reportText,
  };
  const reportJsonPath = `${reportBase}.json`;
  const reportTextPath = `${reportBase}.txt`;
  stage = "write report";
  await writeJsonAtomic(reportJsonPath, report);
  await writeFile(reportTextPath, `${reportText}\n`, { encoding: "utf8", mode: 0o600 });

  if (dryRun) {
    printResult({
      ok: true,
      dryRun: true,
      verdict: assessment.verdict,
      upstreamHead,
      reportPath: reportJsonPath,
      reportText,
    });
    process.exit(0);
  }

  stage = "deliver Discord report";
  let delivery;
  try {
    delivery = await sendDiscordReport({
      reportTextPath,
      nonce: buildDiscordNonce(checkedAt, `success:${localHead}:${upstreamHead}`),
    });
  } catch (error) {
    await writeDeliveryFailure({ error, reportJsonPath, reportTextPath });
    throw error;
  }

  stage = "write successful state";
  const nextState = {
    lastCheckedAt: checkedAt,
    lastLocalHead: localHead,
    lastUpstreamHead: upstreamHead,
    lastVerdict: assessment.verdict,
    lastMessageId: delivery.messageId,
    lastReportPath: reportJsonPath,
  };
  try {
    await writeJsonAtomic(statePath, nextState);
  } catch (error) {
    await deliverFailure({
      error,
      failureStage: stage,
      identity: `state:${upstreamHead}`,
    });
    throw error;
  }

  printResult({
    ok: true,
    dryRun: false,
    verdict: assessment.verdict,
    upstreamHead,
    messageId: delivery.messageId,
    reportPath: reportJsonPath,
    reportText,
  });
} catch (error) {
  if (stage !== "deliver Discord report" && stage !== "write successful state") {
    try {
      await deliverFailure({ error, failureStage: stage, identity: `${stage}:${error.message}` });
    } catch (deliveryError) {
      await writeDeliveryFailure({ error: deliveryError });
    }
  }
  console.error(`Upstream watch failed during ${stage}: ${error?.message || error}`);
  process.exitCode = 1;
}

async function readState() {
  try {
    return validateWatchState(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function comparePreviousUpstream(previousHead, currentRef) {
  const exists = await run("git", ["cat-file", "-e", `${previousHead}^{commit}`], {
    allowFailure: true,
  });
  if (exists.code !== 0) return { count: 0, historyChanged: true };
  const ancestor = await run(
    "git",
    ["merge-base", "--is-ancestor", previousHead, currentRef],
    { allowFailure: true },
  );
  if (ancestor.code === 1) return { count: 0, historyChanged: true };
  if (ancestor.code !== 0) {
    throw new Error(ancestor.stderr.trim() || "Unable to compare previous upstream head");
  }
  const count = Number(await gitText(["rev-list", "--count", `${previousHead}..${currentRef}`]));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Git returned an invalid upstream commit count");
  }
  return { count, historyChanged: false };
}

async function deliverFailure({ error, failureStage, identity }) {
  const failureJsonPath = `${reportBase}.failure.json`;
  const failureTextPath = `${reportBase}.failure.txt`;
  const reportText = renderFailureReport({
    checkedAt,
    stage: failureStage,
    error,
    reportPath: failureJsonPath,
  });
  const failureReport = {
    status: "failure",
    checkedAt,
    stage: failureStage,
    error: String(error?.message || error),
    reportText,
    delivery: null,
  };
  await writeJsonAtomic(failureJsonPath, failureReport);
  await writeFile(failureTextPath, `${reportText}\n`, { encoding: "utf8", mode: 0o600 });
  if (dryRun) {
    printResult({ ok: false, dryRun: true, reportPath: failureJsonPath, reportText });
    return;
  }
  const delivery = await sendDiscordReport({
    reportTextPath: failureTextPath,
    nonce: buildDiscordNonce(checkedAt, `failure:${identity}`),
  });
  failureReport.delivery = {
    channelId: delivery.channelId,
    messageId: delivery.messageId,
  };
  await writeJsonAtomic(failureJsonPath, failureReport);
  console.error(`Failure notice delivered to Discord message ${delivery.messageId}`);
}

async function sendDiscordReport({ reportTextPath, nonce }) {
  const result = await run(process.execPath, [
    senderScript,
    "--channel",
    threadId,
    "--content-file",
    reportTextPath,
    "--provider",
    "codex",
    "--nonce",
    nonce,
    "--json",
  ], { cwd: senderRoot });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Discord sender returned invalid JSON: ${result.stdout.slice(0, 300)}`);
  }
  if (!value.messageId || value.channelId !== threadId) {
    throw new Error("Discord sender did not confirm the expected channel and message");
  }
  return value;
}

async function writeDeliveryFailure({ error, reportJsonPath = null, reportTextPath = null }) {
  await writeJsonAtomic(`${reportBase}.delivery-error.json`, {
    status: "delivery_failure",
    checkedAt,
    stage,
    error: String(error?.message || error),
    reportJsonPath,
    reportTextPath,
    stateAdvanced: false,
  });
}

async function gitText(gitArgs) {
  const result = await run("git", gitArgs);
  return result.stdout.trim();
}

function run(program, programArgs, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, programArgs, {
      cwd: options.cwd || repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0 || options.allowFailure) {
        resolvePromise(result);
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          `${program} ${programArgs.join(" ")} failed with ${
            signal ? `signal ${signal}` : `code ${code}`
          }${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function printResult(value) {
  if (jsonOutput) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value.reportText);
  if (value.messageId) console.log(`Discord message: ${value.messageId}`);
  console.log(`Report: ${value.reportPath}`);
}

function shanghaiDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
