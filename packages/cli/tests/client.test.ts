import assert from "node:assert/strict";
import test from "node:test";
import { shouldClearHostAuthOnUnauthorized } from "../src/client.js";

test("execution-token failures never clear the host cloud login", () => {
  assert.equal(
    shouldClearHostAuthOnUnauthorized({
      COHUB_EXECUTION_TOKEN: "scoped-local-execution-token",
    }),
    false,
  );
  assert.equal(shouldClearHostAuthOnUnauthorized({}), true);
});
