import assert from "node:assert/strict";
import test from "node:test";
import { resolvePersonalNodeCloudAccessToken } from "./personal-node-cloud-auth.js";

const now = Date.parse("2026-09-03T00:00:00.000Z");

function stored(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    accessToken: "access-old",
    refreshToken: "refresh-old",
    accessTokenExpiresAt: now + 10 * 60_000,
    scope: "openid offline_access",
    updatedAt: now - 1_000,
    ...overrides,
  });
}

test("uses an unexpired Personal Node cloud token without refreshing", async () => {
  let refreshCalls = 0;
  let writeCalls = 0;
  const token = await resolvePersonalNodeCloudAccessToken({
    forceRefresh: false,
    now,
    readSecret: async () => stored(),
    writeSecret: async () => {
      writeCalls += 1;
    },
    refresh: async () => {
      refreshCalls += 1;
      return {};
    },
  });
  assert.equal(token, "access-old");
  assert.equal(refreshCalls, 0);
  assert.equal(writeCalls, 0);
});

test("refreshes an expired token and persists the rotated session", async () => {
  let written = "";
  const token = await resolvePersonalNodeCloudAccessToken({
    forceRefresh: false,
    now,
    readSecret: async () => stored({ accessTokenExpiresAt: now - 1 }),
    writeSecret: async (value) => {
      written = value;
    },
    refresh: async (refreshToken) => {
      assert.equal(refreshToken, "refresh-old");
      return {
        status: "complete",
        tokenType: "Bearer",
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiresInSeconds: 3_600,
        scope: "openid offline_access profile",
      };
    },
  });
  assert.equal(token, "access-new");
  assert.deepEqual(JSON.parse(written), {
    schemaVersion: 1,
    accessToken: "access-new",
    refreshToken: "refresh-new",
    accessTokenExpiresAt: now + 3_600_000,
    scope: "openid offline_access profile",
    updatedAt: now,
  });
});

test("does not replace a corrupt Personal Node auth record with a fallback", async () => {
  await assert.rejects(
    resolvePersonalNodeCloudAccessToken({
      forceRefresh: false,
      now,
      readSecret: async () => "{broken",
      writeSecret: async () => undefined,
      refresh: async () => ({}),
    }),
    /invalid JSON/,
  );
});

test("reports a missing Personal Node cloud session without refreshing", async () => {
  let refreshed = false;
  const token = await resolvePersonalNodeCloudAccessToken({
    forceRefresh: false,
    now,
    readSecret: async () => null,
    writeSecret: async () => undefined,
    refresh: async () => {
      refreshed = true;
      return {};
    },
  });
  assert.equal(token, null);
  assert.equal(refreshed, false);
});
