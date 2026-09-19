import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscordNonce,
  classifyUpstreamChanges,
  parseCommitLog,
  renderFailureReport,
  renderSuccessReport,
  validateWatchState,
} from "./upstream-watch-core.mjs";

const fixCommit = {
  hash: "abcdef1234567890",
  date: "2026-08-26",
  subject: "fix: reconnect local relay turns",
};

test("no upstream commits produces an explicit observe verdict", () => {
  const result = classifyUpstreamChanges({ commits: [], upstreamPaths: [], localPaths: [] });
  assert.equal(result.verdict, "observe");
  assert.match(result.reasons[0], /没有/);
});

test("a direct local path overlap requires immediate rebase evaluation", () => {
  const result = classifyUpstreamChanges({
    commits: [{ ...fixCommit, subject: "feat: adjust composer" }],
    upstreamPaths: ["apps/web/src/lib/features/session-chat/controller.ts"],
    localPaths: ["apps/web/src/lib/features/session-chat/controller.ts"],
  });
  assert.equal(result.verdict, "rebase_now");
  assert.deepEqual(result.overlappingPaths, [
    "apps/web/src/lib/features/session-chat/controller.ts",
  ]);
});

test("a security commit requires immediate rebase evaluation", () => {
  const result = classifyUpstreamChanges({
    commits: [{ ...fixCommit, subject: "fix auth token validation" }],
    upstreamPaths: ["apps/gateway/src/auth.ts"],
    localPaths: [],
  });
  assert.equal(result.verdict, "rebase_now");
  assert.equal(result.securityCommits.length, 1);
});

test("critical path changes without a fix are queued for near-term review", () => {
  const result = classifyUpstreamChanges({
    commits: [{ ...fixCommit, subject: "refactor: reorganize protocol types" }],
    upstreamPaths: ["packages/protocol/src/index.ts"],
    localPaths: [],
  });
  assert.equal(result.verdict, "review_soon");
});

test("unrelated small changes remain observe", () => {
  const result = classifyUpstreamChanges({
    commits: [{ ...fixCommit, subject: "docs: revise pricing copy" }],
    upstreamPaths: ["docs/product/en/pricing.md"],
    localPaths: ["pnpm-lock.yaml"],
  });
  assert.equal(result.verdict, "observe");
});

test("reports remain within Discord limits and state rejects corruption", () => {
  const assessment = classifyUpstreamChanges({
    commits: [fixCommit],
    upstreamPaths: ["scripts/local-mode/run.mjs"],
    localPaths: ["scripts/local-mode/run.mjs"],
  });
  const report = renderSuccessReport({
    checkedAt: "2026-08-26T02:00:00.000Z",
    localHead: "1111111111111111",
    upstreamHead: "2222222222222222",
    previousUpstreamHead: "3333333333333333",
    commits: Array.from({ length: 100 }, (_, index) => ({
      ...fixCommit,
      hash: String(index).padStart(16, "0"),
      subject: `fix: ${"x".repeat(100)}`,
    })),
    newSinceLastCheck: 100,
    assessment,
  });
  assert.ok(report.length <= 2000);
  assert.throws(() => validateWatchState({ lastUpstreamHead: 42 }), /Invalid/);
  assert.throws(() => validateWatchState({ lastLocalHead: 42 }), /Invalid/);
  assert.throws(() => validateWatchState({ lastReportPath: 42 }), /Invalid/);
  assert.match(
    renderFailureReport({
      checkedAt: "2026-08-26T02:00:00.000Z",
      stage: "fetch",
      error: new Error("network down"),
      reportPath: "/tmp/report.json",
    }),
    /不能沿用旧结论/,
  );
});

test("git logs parse strictly and daily nonces are deterministic", () => {
  assert.deepEqual(parseCommitLog("abc\t2026-08-26\tfix: hello\n"), [
    { hash: "abc", date: "2026-08-26", subject: "fix: hello" },
  ]);
  assert.throws(() => parseCommitLog("broken"), /Malformed/);
  assert.equal(
    buildDiscordNonce("2026-08-26T02:00:00.000Z", "same"),
    buildDiscordNonce("2026-08-26T09:00:00.000Z", "same"),
  );
});
