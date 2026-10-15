import type { DecisionAnswer, Usage } from "@cohub/protocol";
import type { ResolvedDecisionModel } from "@cohub/infra/config-runtime/decisions";
import { RequestError } from "../lib/request-error.js";
import type { UpstreamDecisionState } from "./state.js";

const DECISIONS_PATH = "api/alpha/decisions";
const UPSTREAM_TIMEOUT_MS = 120_000;
/** Transport failures and 5xx retry once; the upstream may already have charged the failed call. */
const MAX_ATTEMPTS = 2;

export type DecisionAttempt = {
  status: number | null;
  body: unknown;
  error?: string;
  durationMs: number;
};

export type DecisionCallOutcome =
  | { status: "succeeded"; answers: Record<string, DecisionAnswer>; usage: Usage; attempts: DecisionAttempt[] }
  | { status: "failed"; error: RequestError; attempts: DecisionAttempt[] }
  | { status: "aborted"; attempts: DecisionAttempt[] };

export async function callDecisionUpstream(input: {
  model: ResolvedDecisionModel;
  state: UpstreamDecisionState;
  questions: Record<string, unknown>;
  userId: string;
  spaceId: string;
  decisionId: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<DecisionCallOutcome> {
  const fetchImpl = input.fetch ?? fetch;
  const url = new URL(DECISIONS_PATH, `${input.model.baseUrl.replace(/\/+$/, "")}/`);
  const request = {
    method: "POST",
    headers: {
      ...input.model.headers,
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.model.apiKey}`,
      "x-litellm-track-extra": JSON.stringify({
        user_uuid: input.userId,
        cohub_space_uuid: input.spaceId,
        cohub_decision_id: input.decisionId,
      }),
    },
    body: JSON.stringify({ model: input.model.id, state: input.state, questions: input.questions }),
  };

  const attempts: DecisionAttempt[] = [];
  let failure: RequestError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(url, { ...request, signal });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      attempts.push({ status: response.status, body, durationMs: Date.now() - startedAt });
      if (response.ok) {
        const parsed = parseUpstreamResponse(body);
        return parsed
          ? { status: "succeeded", ...parsed, attempts }
          : { status: "failed", error: new RequestError(502, "decision_failed", "Decision response was malformed."), attempts };
      }
      failure = upstreamError(response.status, body);
      if (response.status < 500) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ status: null, body: null, error: message, durationMs: Date.now() - startedAt });
      if (input.signal?.aborted) return { status: "aborted", attempts };
      failure = new RequestError(502, "decision_failed", timeout.aborted ? "Decision call timed out." : "Decision call failed.");
    }
  }
  return { status: "failed", error: failure ?? new RequestError(502, "decision_failed", "Decision call failed."), attempts };
}

function parseUpstreamResponse(body: Record<string, unknown> | null): { answers: Record<string, DecisionAnswer>; usage: Usage } | null {
  const answers = body?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const usage = body.usage as { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } | undefined;
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    answers: answers as Record<string, DecisionAnswer>,
    usage: {
      input,
      output,
      totalTokens: input + output,
      cost: typeof usage?.cost === "number" ? { total: usage.cost } : null,
    },
  };
}

function upstreamError(status: number, body: Record<string, unknown> | null): RequestError {
  if (status === 400) {
    return new RequestError(400, "invalid_decision_request", upstreamMessage(body) ?? "Invalid decision request.");
  }
  if (status === 401 || status === 403 || status === 404 || status === 503) {
    return new RequestError(503, "decisions_unavailable", "Decision models are temporarily unavailable.");
  }
  return new RequestError(502, "decision_failed", `Decision call failed (${status}).`);
}

function upstreamMessage(body: Record<string, unknown> | null): string | null {
  const error = body?.error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return null;
}
