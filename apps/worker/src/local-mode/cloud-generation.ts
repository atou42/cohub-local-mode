import { resolveAccessToken } from "@neta-art/cohub-cli/auth";
import type { GenerationContentBlock, GenerationTaskResult } from "@cohub/protocol/generation";
import { config } from "../config.js";

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 30 * 60 * 1_000;

type CloudTaskDetail = {
  run?: {
    taskType?: unknown;
    status?: unknown;
    result?: unknown;
    errorMessage?: unknown;
  };
};

type CloudGenerationInput = {
  userId: string;
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

let verifiedAccount: { token: string; userId: string; expiresAt: number } | null = null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

function bodyMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  return typeof record?.message === "string" && record.message.trim()
    ? record.message.trim()
    : fallback;
}

function parseTaskResult(value: unknown, model: string): GenerationTaskResult {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.output)) throw new Error("Cloud generation completed without a valid result.");
  const resultModel = typeof record.model === "string" ? record.model : model;
  return {
    model: resultModel,
    provider: typeof record.provider === "string" ? record.provider : null,
    output: record.output as GenerationContentBlock[],
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    ...(typeof record.cost === "number" && Number.isFinite(record.cost) ? { cost: record.cost } : {}),
    ...(record.billing && typeof record.billing === "object" && !Array.isArray(record.billing)
      ? { billing: record.billing as GenerationTaskResult["billing"] }
      : {}),
    ...(record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? { meta: record.meta as Record<string, unknown> }
      : {}),
  };
}

async function cloudToken(userId: string, forceRefresh = false): Promise<string> {
  const token = await resolveAccessToken({ forceRefresh }).catch((error) => {
    throw new Error(`Cloud account authentication failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!token) throw new Error("Cloud account is not connected. Run cohub auth login on the host.");
  if (!forceRefresh && verifiedAccount?.token === token && verifiedAccount.userId === userId && verifiedAccount.expiresAt > Date.now()) return token;

  const response = await fetch(new URL("/api/me", config.cloudApiOrigin), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 && !forceRefresh) return cloudToken(userId, true);
  if (!response.ok) throw new Error(`Cloud account verification returned HTTP ${response.status}.`);
  const body = await response.json().catch(() => null) as { uuid?: unknown } | null;
  if (body?.uuid !== userId) throw new Error("The connected cloud account does not match this Cohub user.");
  verifiedAccount = { token, userId, expiresAt: Date.now() + 60_000 };
  return token;
}

async function cloudRequest(userId: string, path: string, init: RequestInit = {}): Promise<Response> {
  let token = await cloudToken(userId);
  const request = () => fetch(new URL(path, config.cloudApiOrigin), {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  let response = await request();
  if (response.status === 401) {
    verifiedAccount = null;
    token = await cloudToken(userId, true);
    response = await request();
  }
  return response;
}

async function defaultCloudSpaceId(userId: string): Promise<string> {
  const response = await cloudRequest(userId, "/api/spaces/default");
  const body = await response.json().catch(() => null) as { space?: { id?: unknown } | null } | null;
  if (!response.ok) throw new Error(bodyMessage(body, `Cloud default Space returned HTTP ${response.status}.`));
  if (typeof body?.space?.id !== "string" || !body.space.id) throw new Error("Cloud account has no default Space for generation.");
  return body.space.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCloudGeneration(input: CloudGenerationInput): Promise<GenerationTaskResult> {
  const cloudSpaceId = await defaultCloudSpaceId(input.userId);
  const createdResponse = await cloudRequest(input.userId, "/api/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      spaceId: cloudSpaceId,
      model: input.model,
      content: input.content,
      ...(input.parameters ? { parameters: input.parameters } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    }),
  });
  const createdBody = await createdResponse.json().catch(() => null) as { taskRunId?: unknown; message?: unknown } | null;
  if (!createdResponse.ok || typeof createdBody?.taskRunId !== "string") {
    throw new Error(bodyMessage(createdBody, `Cloud generation request returned HTTP ${createdResponse.status}.`));
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const response = await cloudRequest(input.userId, `/api/tasks/${encodeURIComponent(createdBody.taskRunId)}`);
    const detail = await response.json().catch(() => null) as CloudTaskDetail | null;
    if (!response.ok) throw new Error(bodyMessage(detail, `Cloud generation task returned HTTP ${response.status}.`));
    const run = detail?.run;
    if (run?.taskType !== "generation") throw new Error("Cloud task is not a generation task.");
    if (run.status === "completed") return parseTaskResult(run.result, input.model);
    if (run.status === "failed") throw new Error(typeof run.errorMessage === "string" && run.errorMessage ? run.errorMessage : "Cloud generation task failed.");
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Cloud generation task timed out after ${POLL_TIMEOUT_MS}ms.`);
}
