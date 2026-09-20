import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { sessionTurns } from "@cohub/db";
import type { RuntimeRecoveryState } from "@cohub/protocol";

export const runtimeRecoveryActive = inArray(sessionTurns.status, ["running", "abort_requested"]);
export const runtimeResolutionOpen = sql`coalesce(${sessionTurns.meta}->'runtimeRecovery'->>'state', '') <> 'confirmed_stopped'`;
export function readRuntimeRecovery(meta: unknown): RuntimeRecoveryState | null {
  const value = (meta as { runtimeRecovery?: RuntimeRecoveryState } | null)?.runtimeRecovery;
  return value && ["executing", "attention", "confirmed_stopped"].includes(value.state) ? value : null;
}
export type RuntimeRecoveryTurn = { id: string; meta: unknown };
export function runtimeRecoverySnapshot(turns: RuntimeRecoveryTurn[]) {
  const pending = turns.filter((turn) => readRuntimeRecovery(turn.meta)?.state === "attention");
  const revision = createHash("sha256").update(JSON.stringify(pending.map((turn) => turn.id).sort())).digest("hex");
  return { pending: pending.length, revision };
}
