import { sessionMessages } from "@cohub/db";
import { resolveWalletMessageEligibility } from "./message-policy.js";
export { resolveWalletMessageEligibility };
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export async function claimMessageWalletBilling(db: PostgresJsDatabase<Record<string, unknown>>, messageId: string): Promise<boolean> {
  const rows = await db.update(sessionMessages).set({
    meta: sql`coalesce(${sessionMessages.meta}, '{}'::jsonb) || '{"walletBillingAttempted":true}'::jsonb`,
  }).where(and(
    eq(sessionMessages.id, messageId),
    sql`${sessionMessages.meta}->>'walletBillingEligible' = 'true'`,
    sql`${sessionMessages.usageAggregatedAt} is null`,
    sql`not (coalesce(${sessionMessages.meta}, '{}'::jsonb) ? 'walletBillingAttempted')`,
  )).returning({ id: sessionMessages.id });
  return rows.length > 0;
}
