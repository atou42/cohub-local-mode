import assert from "node:assert/strict";
import test from "node:test";
import { isManagedLocalSandboxRelayToken } from "./local-sandbox-supervisor-auth.js";

test("managed relay token is accepted only on a local node with an exact match", () => {
  const input = {
    expectedToken: "local-secret-value",
    providedToken: "local-secret-value",
  };
  assert.equal(
    isManagedLocalSandboxRelayToken({ ...input, nodeOrigin: "local" }),
    true,
  );
  assert.equal(
    isManagedLocalSandboxRelayToken({ ...input, nodeOrigin: "cloud" }),
    false,
  );
  assert.equal(
    isManagedLocalSandboxRelayToken({
      ...input,
      nodeOrigin: "local",
      providedToken: "local-secret-valuE",
    }),
    false,
  );
  assert.equal(
    isManagedLocalSandboxRelayToken({
      ...input,
      nodeOrigin: "local",
      providedToken: "",
    }),
    false,
  );
});
