import { AuthorizationError, verifyUserAccessToken } from "@cohub/identity";
import { timingSafeEqual } from "node:crypto";
import { gatewayConfig } from "./config.js";

export const LOCAL_SANDBOX_INVALID_TOKEN_MESSAGE = "access token is invalid or expired";

export type LocalSandboxTokenCheck =
  | { ok: true }
  | { ok: false; status: number; message: string };

export const describeLocalSandboxTokenFailure = (error: unknown): Extract<LocalSandboxTokenCheck, { ok: false }> => {
  const status = error instanceof AuthorizationError ? error.status : 401;
  if (status === 403) return { ok: false, status: 403, message: "forbidden" };
  return { ok: false, status: 401, message: LOCAL_SANDBOX_INVALID_TOKEN_MESSAGE };
};

// Reject expired or invalid user tokens on the gateway so leftover local
// runners do not hammer API /internal/gateway/local-sandbox/authorize.
export const verifyLocalSandboxAccessToken = async (token: string): Promise<LocalSandboxTokenCheck> => {
  // Managed local runners use a host secret, not a user JWT. The API still
  // checks the target Space's local provider before authorizing the connection.
  const expected = Buffer.from(gatewayConfig.localSandboxRelayToken);
  const provided = Buffer.from(token);
  if (gatewayConfig.nodeOrigin === "local" && expected.length > 0 &&
      expected.length === provided.length && timingSafeEqual(expected, provided)) {
    return { ok: true };
  }
  try {
    await verifyUserAccessToken({ token, logtoEndpoint: gatewayConfig.logtoEndpoint });
    return { ok: true };
  } catch (error) {
    return describeLocalSandboxTokenFailure(error);
  }
};

export const relayAuthClose = (status: number): { code: number; reason: string } => {
  if (status >= 500) return { code: 1011, reason: "authorization unavailable" };
  if (status === 401) return { code: 4401, reason: "unauthorized" };
  return { code: 4403, reason: "forbidden" };
};
