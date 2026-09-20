import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { runtimeRecoverySnapshot, readRuntimeRecovery, runtimeResolutionOpen } from "./runtime-recovery.js";
import { runtimeStopConfirmationSchema } from "@cohub/protocol";

test("Runtime confirmation snapshots bind one Session execution revision", () => {
  const turn = (id: string, state: string) => ({ id, sessionId: "session", userUuid: "owner", meta: { runtimeRecovery: { state } } });
  const pending = turn("pending", "attention"), live = turn("live", "executing"), resolved = turn("resolved", "confirmed_stopped");
  assert.deepEqual(runtimeRecoverySnapshot([pending, live, resolved]), runtimeRecoverySnapshot([resolved, live, pending]));
  assert.equal(runtimeRecoverySnapshot([pending, live]).pending, 1);
  assert.equal(runtimeRecoverySnapshot([pending]).revision, runtimeRecoverySnapshot([pending, live]).revision);
  assert.notEqual(runtimeRecoverySnapshot([pending]).revision, runtimeRecoverySnapshot([pending, turn("later", "attention")]).revision);
  assert.equal(readRuntimeRecovery({ runtimeRecovery: "bad" }), null);
  assert.equal(runtimeStopConfirmationSchema.safeParse({ action: "recover" }).success, false);
  assert.equal(runtimeStopConfirmationSchema.safeParse({ revision: "snapshot" }).success, false);
  assert.equal(runtimeStopConfirmationSchema.safeParse({ revision: "snapshot", confirmed: true }).success, false);
  assert.equal(runtimeStopConfirmationSchema.safeParse({ expectedTurnId: crypto.randomUUID(), revision: "snapshot", confirmed: true }).success, true);
});

test("native finalization fence excludes manually resolved executions", () => {
  const query = new PgDialect().sqlToQuery(runtimeResolutionOpen);
  assert(query.sql.includes("runtimeRecovery"));
  assert(query.sql.includes("confirmed_stopped"));
});
