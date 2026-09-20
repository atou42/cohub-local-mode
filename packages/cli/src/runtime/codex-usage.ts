import type { RuntimeMessage } from "@neta-art/cohub";
import { record } from "./json-rpc.js";

const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "totalTokens"] as const;
export type CodexTokenTotals = Record<typeof fields[number], number>;
const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
export const codexTokenTotals = (value: unknown): CodexTokenTotals => {
  const input = record(value);
  return Object.fromEntries(fields.map((key) => [key, tokens(input[key])])) as CodexTokenTotals;
};
export const subtractCodexTokens = (total: CodexTokenTotals, base: CodexTokenTotals): CodexTokenTotals =>
  Object.fromEntries(fields.map((key) => [key, Math.max(0, total[key] - base[key])])) as CodexTokenTotals;

export function codexUsage(total: CodexTokenTotals): NonNullable<RuntimeMessage["usage"]> {
  return { input: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens), output: total.outputTokens, cacheRead: total.cachedInputTokens, cacheWrite: total.cacheWriteInputTokens, totalTokens: total.totalTokens };
}

/** Seed portable imports from the original native counters, not a prior turn's `last`. */
export function codexArchiveTotals(records: Record<string, unknown>[]): CodexTokenTotals | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const entry = records[i];
    if (entry?.type !== "token_usage_record") continue;
    const value = record(record(entry.payload).thread_token_usage);
    if (typeof value.total_tokens !== "number") continue;
    return codexTokenTotals({ inputTokens: value.input_tokens, outputTokens: value.output_tokens, cachedInputTokens: value.cached_input_tokens, cacheWriteInputTokens: value.cache_write_input_tokens, totalTokens: value.total_tokens });
  }
}
