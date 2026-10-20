import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ResolvedDecisionModel } from "@cohub/infra/config-runtime/decisions";
import * as billing from "@cohub/billing";

process.env.LOG_LEVEL = "silent";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const models: ResolvedDecisionModel[] = [
  { provider: "cohub", id: "text", name: "Text", hidden: false, input: ["text"], maxImages: 0, baseUrl: "https://router.test", apiKey: "k" },
  { provider: "cohub", id: "vision", name: "Vision", hidden: false, input: ["text", "image"], maxImages: 2, baseUrl: "https://router.test", apiKey: "k" },
];
const recorded: Array<Record<string, unknown>> = [];
const archived: Array<Record<string, unknown>> = [];

mock.module("../src/lib/middleware.js", { namedExports: {
  useAuth: () => ({ uuid: "user-1" }),
  requireValidId: (id: string) => id === SPACE_ID,
  authzDenied: (c: { json: (body: unknown, status: number) => Response }) => c.json({ message: "forbidden" }, 403),
} });
mock.module("../src/permissions.js", { namedExports: { hasPermission: async () => true } });
mock.module("../src/space-sessions.js", { namedExports: { getSpaceById: async () => ({ id: SPACE_ID }) } });
mock.module("../src/decisions/models.js", { namedExports: { loadDecisionModels: async () => models } });
mock.module("../src/model-call-archive.js", { namedExports: {
  createModelCallId: () => "decision-1",
  archiveDecisionBestEffort: (record: Record<string, unknown>) => archived.push(record),
} });
mock.module("@cohub/billing", { namedExports: {
  ...billing,
  billingOperations: {
    status: { configured: true },
    getCreditStatus: async () => ({ netUsd: 10 }),
    recordUsage: async (input: Record<string, unknown>) => {
      recorded.push(input);
      return { status: "recorded" };
    },
  },
} });

mock.module("../src/space-wallet-billing.js", { namedExports: {
  spaceWalletBilling: {
    gate: { evaluate: async () => ({ status: "allowed" }) },
    recordUsage: async (input: Record<string, unknown>) => {
      recorded.push(input);
      return { status: "recorded" };
    },
  },
} });

const { default: router } = await import("../src/routes/spaces/decisions.route.js");
const { Hono } = await import("hono");
const app = new Hono().route("/spaces/:id/decisions", router);

const upstream = (body: unknown, status = 200) =>
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));

const post = (body: unknown) => app.request(`/spaces/${SPACE_ID}/decisions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const request = {
  state: { ticket: "I was charged twice." },
  questions: { refund: { type: "noul", instructions: "Refund?" } },
};

test("defaults to the first catalog model and bills the upstream cost", async (t) => {
  recorded.length = 0;
  archived.length = 0;
  const fetchMock = upstream({ answers: { refund: { type: "noul", noul: 1 } }, usage: { cost: 0.000038, input_tokens: 375, output_tokens: 0 } });
  t.after(() => fetchMock.mock.restore());

  const response = await post(request);
  assert.equal(response.status, 200);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.decisionId, "decision-1");
  assert.equal(result.model, "text");
  assert.deepEqual(result.answers, { refund: { type: "noul", noul: 1 } });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.amountUsd, 0.000038);
  assert.equal(recorded[0]?.operationId, "decision:decision-1");
  assert.equal(recorded[0]?.usageType, "generation.decision");
  assert.equal(archived[0]?.costUsd, 0.000038);
});

test("skips billing when the upstream omits cost", async (t) => {
  recorded.length = 0;
  const fetchMock = upstream({ answers: {}, usage: { input_tokens: 10 } });
  t.after(() => fetchMock.mock.restore());
  assert.equal((await post(request)).status, 200);
  assert.equal(recorded.length, 0);
});

test("rejects images beyond the model limit before calling upstream", async (t) => {
  const fetchMock = upstream({});
  t.after(() => fetchMock.mock.restore());
  const image = { type: "image_url", image_url: "data:image/png;base64,AAAA" };
  const textOnly = await post({ ...request, model: "text", state: ["Receipt", image] });
  assert.equal(textOnly.status, 400);
  assert.equal((await textOnly.json() as { error: { code: string } }).error.code, "decision_image_limit");
  const tooMany = await post({ ...request, model: "vision", state: [image, image, image] });
  assert.equal(tooMany.status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("validates questions and archives failed upstream calls without billing", async (t) => {
  const invalid = await post({ ...request, questions: { team: { type: "choice", instructions: "Team?", criteria: { billing: "Charges" } } } });
  assert.equal(invalid.status, 400);

  recorded.length = 0;
  archived.length = 0;
  const fetchMock = upstream({ error: { message: "Invalid token" } }, 401);
  t.after(() => fetchMock.mock.restore());
  const response = await post(request);
  assert.equal(response.status, 503);
  assert.equal(recorded.length, 0);
  assert.deepEqual(archived[0]?.error, { code: "decisions_unavailable", message: "Decision models are temporarily unavailable." });
});
