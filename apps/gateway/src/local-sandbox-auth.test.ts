import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError } from "@cohub/identity";
import { gatewayConfig } from "./config.js";
import {
  LOCAL_SANDBOX_INVALID_TOKEN_MESSAGE,
  describeLocalSandboxTokenFailure,
  relayAuthClose,
  verifyLocalSandboxAccessToken,
} from "./local-sandbox-auth.js";

test("managed token is accepted only on a local node; invalid user tokens remain rejected", async () => {
  const original = { nodeOrigin: gatewayConfig.nodeOrigin, localSandboxRelayToken: gatewayConfig.localSandboxRelayToken };
  try {
    gatewayConfig.nodeOrigin = "local";
    gatewayConfig.localSandboxRelayToken = "isolated-managed-runner-secret";
    assert.deepEqual(await verifyLocalSandboxAccessToken("isolated-managed-runner-secret"), { ok: true });
    for (const token of ["", "incorrect", "isolated-managed-runner-secreX"]) {
      assert.equal((await verifyLocalSandboxAccessToken(token)).ok, false);
    }
    gatewayConfig.nodeOrigin = "cloud";
    assert.equal((await verifyLocalSandboxAccessToken("isolated-managed-runner-secret")).ok, false);
    gatewayConfig.nodeOrigin = "local";
    gatewayConfig.localSandboxRelayToken = "";
    assert.equal((await verifyLocalSandboxAccessToken("")).ok, false);
  } finally {
    Object.assign(gatewayConfig, original);
  }
});

test("expired or invalid tokens are rejected as 401 without calling the API", () => {
  assert.deepEqual(describeLocalSandboxTokenFailure(new AuthorizationError("Jwt is invalid", 401)), {
    ok: false,
    status: 401,
    message: LOCAL_SANDBOX_INVALID_TOKEN_MESSAGE,
  });
  assert.deepEqual(describeLocalSandboxTokenFailure(new Error("boom")), {
    ok: false,
    status: 401,
    message: LOCAL_SANDBOX_INVALID_TOKEN_MESSAGE,
  });
});

test("third-party access is rejected as 403", () => {
  assert.deepEqual(
    describeLocalSandboxTokenFailure(new AuthorizationError("Current service does not allow third-party access", 403)),
    { ok: false, status: 403, message: "forbidden" },
  );
});

test("relay close codes distinguish unauthorized from forbidden and unavailable", () => {
  assert.deepEqual(relayAuthClose(401), { code: 4401, reason: "unauthorized" });
  assert.deepEqual(relayAuthClose(403), { code: 4403, reason: "forbidden" });
  assert.deepEqual(relayAuthClose(409), { code: 4403, reason: "forbidden" });
  assert.deepEqual(relayAuthClose(500), { code: 1011, reason: "authorization unavailable" });
});
