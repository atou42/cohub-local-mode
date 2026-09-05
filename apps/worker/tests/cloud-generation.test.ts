import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

const taskId = "cloud-task/id 42";
const output = [{ type: "image", url: "https://asset.invalid/generated.png" }];
const completed = { body: { run: { taskType: "generation", status: "completed", result: { model: "actual-model", provider: "actual-provider", output, requestId: "request-42", cost: 2 } } } };
const running = { body: { run: { taskType: "generation", status: "running" } } };
type Step = { body?: unknown; status?: number; raw?: string; networkError?: string };
type Outcome = {
  result?: unknown;
  error?: { message: string; cause?: { message: string; cause?: { message: string } } };
  calls: { path: string; method: string; authorization: string }[];
  warnings: string[];
  delays: number[];
  authCalls: { forceRefresh: boolean }[];
};

async function runScenario(scenario: { polls: Step[]; repeatPoll?: Step; me?: Step[]; post?: Step; clockStep?: number; authError?: string }): Promise<Outcome> {
  const home = await mkdtemp(join(tmpdir(), "cohub-cloud-generation-"));
  let worker: Worker | undefined;
  try {
    return await new Promise<Outcome>((resolve, reject) => {
      worker = new Worker(new URL("./fixtures/cloud-generation-worker.mjs", import.meta.url), {
        workerData: scenario,
        env: { HOME: home, COHUB_TEST_ALLOW_NETWORK: "0" },
        execArgv: ["--experimental-strip-types", "--import", new URL("../../../scripts/test/no-network.mjs", import.meta.url).href],
      });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Cloud generation worker exited before returning a result: ${code}`)));
    });
  } finally {
    await worker?.terminate();
    await rm(home, { recursive: true, force: true });
  }
}

function assertRequests(outcome: Outcome, polls: number) {
  assert.equal(outcome.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(outcome.calls.filter((call) => call.path.startsWith("/api/tasks/")), Array.from({ length: polls }, () => ({
    path: `/api/tasks/${encodeURIComponent(taskId)}`, method: "GET", authorization: "Bearer fake-token",
  })));
}

function assertResult(outcome: Outcome) {
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.result, { model: "actual-model", provider: "actual-provider", output, requestId: "request-42", cost: 2 });
}

test("a network poll failure recovers the same cloud task without another paid POST", async () => {
  const outcome = await runScenario({ polls: [{ networkError: "fetch failed" }, completed] });
  assertResult(outcome);
  assertRequests(outcome, 2);
  assert.deepEqual(outcome.delays, [1500]);
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /cloud-task\/id 42.*fetch failed/);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} polling recovers without resubmission`, async () => {
    const outcome = await runScenario({ polls: [{ status, raw: "temporarily unavailable" }, completed] });
    assertResult(outcome);
    assertRequests(outcome, 2);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], new RegExp(`HTTP ${status}`));
  });
}

test("three consecutive transport failures fail with task ID and original cause", async () => {
  const outcome = await runScenario({ polls: [], repeatPoll: { networkError: "fetch failed" } });
  assertRequests(outcome, 3);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /cloud-task\/id 42.*fetch failed/);
  assert.match(JSON.stringify(outcome.error), /ECONNRESET/);
  assert.equal(outcome.warnings.length, 3);
  assert.deepEqual(outcome.delays, [1500, 1500]);
});

test("HTTP retry failures are bounded and carry cloud task ID", async () => {
  const outcome = await runScenario({ polls: [], repeatPoll: { status: 503, raw: "unavailable" } });
  assertRequests(outcome, 3);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /cloud-task\/id 42.*HTTP 503/);
  assert.equal(outcome.warnings.length, 3);
});

test("a valid poll resets consecutive retry failures", async () => {
  const failure = { networkError: "fetch failed" };
  const outcome = await runScenario({ polls: [failure, failure, running, failure, failure, completed] });
  assertResult(outcome);
  assertRequests(outcome, 6);
  assert.equal(outcome.warnings.length, 4);
});

test("pending, queued, running and completed retain the normal poll interval", async () => {
  const outcome = await runScenario({ polls: [
    { body: { run: { taskType: "generation", status: "pending" } } },
    { body: { run: { taskType: "generation", status: "queued" } } }, running, completed,
  ] });
  assertResult(outcome);
  assertRequests(outcome, 4);
  assert.deepEqual(outcome.delays, [1500, 1500, 1500]);
  assert.deepEqual(outcome.warnings, []);
});

for (const [label, step, message] of [
  ["forbidden", { status: 403, body: { message: "Forbidden" } }, /Forbidden/],
  ["not found", { status: 404, body: { message: "Not found" } }, /Not found/],
  ["bad JSON", { raw: "not json" }, /JSON|Unexpected token/],
  ["missing run", { body: {} }, /generation task|valid/],
  ["wrong task type", { body: { run: { taskType: "command", status: "running" } } }, /generation task/],
  ["missing status", { body: { run: { taskType: "generation" } } }, /status/],
  ["unknown status", { body: { run: { taskType: "generation", status: "corrupt" } } }, /status/],
  ["invalid result", { body: { run: { taskType: "generation", status: "completed", result: {} } } }, /valid result/],
  ["remote failure", { body: { run: { taskType: "generation", status: "failed", errorMessage: "Provider rejected prompt" } } }, /Provider rejected prompt/],
] as const) {
  test(`${label} fails immediately with cloud task ID`, async () => {
    const outcome = await runScenario({ polls: [step] });
    assertRequests(outcome, 1);
    assert.ok(outcome.error);
    assert.match(outcome.error.message, /cloud-task\/id 42/);
    assert.match(outcome.error.message, message);
    assert.deepEqual(outcome.warnings, []);
    assert.deepEqual(outcome.delays, []);
  });
}

test("account mismatch during refresh fails immediately without retrying the task", async () => {
  const outcome = await runScenario({ polls: [{ status: 401, body: {} }], me: [{ body: { uuid: "user-test" } }, { body: { uuid: "other-user" } }] });
  assertRequests(outcome, 1);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /cloud-task\/id 42.*does not match/);
  assert.deepEqual(outcome.authCalls, [{ forceRefresh: false }, { forceRefresh: false }, { forceRefresh: false }, { forceRefresh: true }]);
  assert.deepEqual(outcome.delays, []);
});

test("identity verification network failure is not a poll transport retry", async () => {
  const outcome = await runScenario({ polls: [{ status: 401, body: {} }], me: [{ body: { uuid: "user-test" } }, { networkError: "identity fetch failed" }] });
  assertRequests(outcome, 1);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /cloud-task\/id 42.*identity fetch failed/);
  assert.deepEqual(outcome.delays, []);
  assert.deepEqual(outcome.warnings, []);
});

test("POST network failure is never resubmitted", async () => {
  const outcome = await runScenario({ polls: [], post: { networkError: "creation fetch failed" } });
  assertRequests(outcome, 0);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /creation fetch failed/);
  assert.deepEqual(outcome.delays, []);
});

test("initial account mismatch cannot create a paid task", async () => {
  const outcome = await runScenario({ polls: [], me: [{ body: { uuid: "other-user" } }] });
  assert.deepEqual(outcome.calls.map((call) => call.path), ["/api/me"]);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /does not match/);
});

test("overall timeout remains thirty minutes including retry waits", async () => {
  const outcome = await runScenario({ polls: [{ networkError: "fetch failed" }], clockStep: 1_800_000 });
  assertRequests(outcome, 1);
  assert.ok(outcome.error);
  assert.match(outcome.error.message, /cloud-task\/id 42.*timed out after 1800000ms/);
  assert.deepEqual(outcome.delays, [1500]);
});
