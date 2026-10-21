import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { claimMessageWalletBilling } from "./message-claim.js";

test("message replay and concurrent jobs can claim only one billing attempt without overwriting metadata", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(`CREATE SCHEMA v2; CREATE TABLE v2.session_messages (id uuid PRIMARY KEY, meta jsonb, usage_aggregated_at timestamptz);`);
    const id = "11111111-1111-4111-8111-111111111111";
    await engine.query("INSERT INTO v2.session_messages (id, meta) VALUES ($1, $2)", [id, { actorUserId: "actor", original: { retained: true }, walletBillingEligible: true }]);
    const db = drizzle(engine) as unknown as Parameters<typeof claimMessageWalletBilling>[0];
    const attempts = await Promise.all([claimMessageWalletBilling(db, id), claimMessageWalletBilling(db, id)]);
    assert.equal(attempts.filter(Boolean).length, 1);
    assert.equal(await claimMessageWalletBilling(db, id), false);
    const result = await engine.query<{ meta: unknown }>("SELECT meta FROM v2.session_messages WHERE id = $1", [id]);
    assert.deepEqual(result.rows[0]?.meta, { actorUserId: "actor", original: { retained: true }, walletBillingEligible: true, walletBillingAttempted: true });
    await engine.exec("UPDATE v2.session_messages SET meta = '{}'::jsonb, usage_aggregated_at = now()");
    assert.equal(await claimMessageWalletBilling(db, id), false);
    await engine.exec("UPDATE v2.session_messages SET usage_aggregated_at = null");
    assert.equal(await claimMessageWalletBilling(db, id), false);
  } finally { await engine.close(); }
});
