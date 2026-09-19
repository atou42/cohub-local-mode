import assert from "node:assert/strict";
import test from "node:test";
import { managedLocalSandboxError } from "../local-sandbox-status.js";

test("managed local startup failure is explicit and non-retryable", () => {
  const error = managedLocalSandboxError({
    provider: "local",
    status: "error",
    meta: {
      managedBy: "local-mode-supervisor",
      lastError: "relay rejected connection: unauthorized",
    },
  });
  assert.equal(
    error?.message,
    "local sandbox failed to start: relay rejected connection: unauthorized",
  );
});

test("ordinary provisioning and cloud errors are not reclassified", () => {
  assert.equal(
    managedLocalSandboxError({
      provider: "local",
      status: "provisioning",
      meta: { managedBy: "local-mode-supervisor", lastError: "old" },
    }),
    null,
  );
  assert.equal(
    managedLocalSandboxError({
      provider: "cloud",
      status: "error",
      meta: { managedBy: "local-mode-supervisor", lastError: "old" },
    }),
    null,
  );
});
