import { createHash } from "node:crypto";

const IMMEDIATE_PATH_PREFIXES = [
  "apps/agent/",
  "apps/local-relay/",
  "apps/api/drizzle/",
  "apps/api/src/db/schema/",
  "apps/api/src/routes/local-mode",
  "apps/api/src/routes/sessions",
  "apps/web/src/lib/features/session-chat/",
  "deploy/local-mode/",
  "packages/model-runtime/",
  "packages/protocol/",
  "scripts/local-mode/",
];

const IMPORTANT_PATH_PREFIXES = [
  "apps/api/",
  "apps/gateway/",
  "apps/sandbox/",
  "apps/web/",
  "packages/core/",
  "packages/infra/",
];

const SECURITY_PATTERN =
  /\b(auth|permission|security|token|credential|vulnerab|cve|xss|csrf|ssrf|injection)\b/i;
const FIX_PATTERN = /\b(fix|bug|regression|crash|race|deadlock|timeout|latency)\b/i;

export function parseCommitLog(output) {
  return String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...subjectParts] = line.split("\t");
      if (!hash || !date || subjectParts.length === 0) {
        throw new Error(`Malformed git log line: ${line}`);
      }
      return { hash, date, subject: subjectParts.join("\t") };
    });
}

export function parsePathList(output) {
  return [...new Set(String(output || "").split("\n").map((path) => path.trim()).filter(Boolean))];
}

export function classifyUpstreamChanges({ commits, upstreamPaths, localPaths }) {
  const upstream = [...new Set(upstreamPaths)];
  const local = new Set(localPaths.filter(isRelevantOverlapPath));
  const overlappingPaths = upstream.filter(
    (path) => isRelevantOverlapPath(path) && local.has(path),
  );
  const immediatePaths = upstream.filter((path) =>
    IMMEDIATE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  const importantPaths = upstream.filter((path) =>
    IMPORTANT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  const securityCommits = commits.filter((commit) => SECURITY_PATTERN.test(commit.subject));
  const fixCommits = commits.filter((commit) => FIX_PATTERN.test(commit.subject));
  const reasons = [];

  if (commits.length === 0) {
    return {
      verdict: "observe",
      verdictLabel: "暂不需要 rebase",
      reasons: ["上游没有本地尚未包含的新提交"],
      overlappingPaths,
      immediatePaths,
      importantPaths,
      securityCommits,
      fixCommits,
    };
  }

  if (overlappingPaths.length > 0) {
    reasons.push(`上游与本地能力直接修改了 ${overlappingPaths.length} 个相同文件`);
  }
  if (securityCommits.length > 0) {
    reasons.push(`发现 ${securityCommits.length} 个认证或安全相关提交`);
  }
  if (immediatePaths.length > 0 && fixCommits.length > 0) {
    reasons.push("Agent、本地模式、会话、迁移或协议路径包含缺陷修复");
  }

  if (reasons.length > 0) {
    return {
      verdict: "rebase_now",
      verdictLabel: "建议立即评估并 rebase",
      reasons,
      overlappingPaths,
      immediatePaths,
      importantPaths,
      securityCommits,
      fixCommits,
    };
  }

  if (immediatePaths.length > 0) {
    reasons.push(`上游改动触及 ${immediatePaths.length} 个本地关键路径文件`);
  }
  if (importantPaths.length >= 10) {
    reasons.push(`上游在核心应用中修改了 ${importantPaths.length} 个文件`);
  }
  if (commits.length >= 20) {
    reasons.push(`本地已落后上游 ${commits.length} 个提交`);
  }

  if (reasons.length > 0) {
    return {
      verdict: "review_soon",
      verdictLabel: "暂不要求立即 rebase，建议近期复核",
      reasons,
      overlappingPaths,
      immediatePaths,
      importantPaths,
      securityCommits,
      fixCommits,
    };
  }

  return {
    verdict: "observe",
    verdictLabel: "暂不建议立即 rebase",
    reasons: ["新增改动未触及本地关键路径，也没有发现安全或高风险修复信号"],
    overlappingPaths,
    immediatePaths,
    importantPaths,
    securityCommits,
    fixCommits,
  };
}

export function renderSuccessReport({
  checkedAt,
  localHead,
  upstreamHead,
  previousUpstreamHead,
  commits,
  newSinceLastCheck,
  assessment,
}) {
  const lines = [
    `Cohub 上游检查 ${formatShanghaiTime(checkedAt)}`,
    `结论：${assessment.verdictLabel}`,
    `版本：本地 ${shortHash(localHead)}，上游 ${shortHash(upstreamHead)}，尚未包含 ${commits.length} 个提交`,
  ];

  if (previousUpstreamHead) {
    lines.push(
      `本轮变化：自上次检查新增 ${newSinceLastCheck} 个提交，上次上游 ${shortHash(previousUpstreamHead)}`,
    );
  }
  lines.push(`依据：${assessment.reasons.slice(0, 3).join("；")}`);

  if (assessment.overlappingPaths.length > 0) {
    lines.push(`直接重叠：${summarizeItems(assessment.overlappingPaths, 4)}`);
  } else if (assessment.immediatePaths.length > 0) {
    lines.push(`关键路径：${summarizeItems(assessment.immediatePaths, 4)}`);
  }

  if (commits.length > 0) {
    const recent = commits.slice(0, 3).map((commit) => `${shortHash(commit.hash)} ${commit.subject}`);
    lines.push(`近期提交：${summarizeItems(recent, 3)}`);
  }

  lines.push(
    assessment.verdict === "rebase_now"
      ? "建议动作：先做冲突和回归范围审计，再启动新一轮 rebase goal"
      : "建议动作：继续观察，不自动 rebase 或 push",
  );
  return limitDiscordMessage(lines.join("\n"));
}

export function renderFailureReport({ checkedAt, stage, error, reportPath }) {
  const lines = [
    `Cohub 上游检查失败 ${formatShanghaiTime(checkedAt)}`,
    "结论：本轮无法判断是否应该 rebase，不能沿用旧结论",
    `失败阶段：${stage}`,
    `错误：${sanitizeError(error)}`,
    `现场：${reportPath}`,
    "建议动作：修复后重试，本轮未自动 rebase 或 push",
  ];
  return limitDiscordMessage(lines.join("\n"));
}

export function validateWatchState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Upstream watch state must be a JSON object");
  }
  for (const key of [
    "lastCheckedAt",
    "lastLocalHead",
    "lastUpstreamHead",
    "lastVerdict",
    "lastMessageId",
    "lastReportPath",
  ]) {
    if (key in value && typeof value[key] !== "string") {
      throw new Error(`Invalid upstream watch state field: ${key}`);
    }
  }
  return value;
}

export function buildDiscordNonce(checkedAt, identity) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(checkedAt))
    .replaceAll("-", "");
  const digest = createHash("sha256").update(String(identity)).digest("hex").slice(0, 10);
  return `cu${date}${digest}`;
}

function isRelevantOverlapPath(path) {
  return (
    path !== "pnpm-lock.yaml" &&
    !path.startsWith("docs/") &&
    !path.endsWith(".md") &&
    !path.includes("/paraglide/messages/")
  );
}

function shortHash(value) {
  return String(value || "unknown").slice(0, 8);
}

function summarizeItems(items, limit) {
  const selected = items.slice(0, limit);
  const remaining = items.length - selected.length;
  return `${selected.join("；")}${remaining > 0 ? `；另有 ${remaining} 项` : ""}`;
}

function formatShanghaiTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, "https://")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 600);
}

function limitDiscordMessage(message) {
  if (message.length <= 2000) return message;
  return `${message.slice(0, 1980)}\n…内容已截断`;
}
