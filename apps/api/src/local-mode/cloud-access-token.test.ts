import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAccessTokenResolver } from "./cloud-access-token.js";

for (const token of ["desktop-token", null]) {
  test(`Personal Node token ${String(token)} does not use host credentials`, async () => {
    const resolve = createCloudAccessTokenResolver({
      resolvePersonalNodeCloudAccessTokenFromEnvironment: async () => token,
      resolveHostAccessToken: async () => { throw new Error("host credentials must not be read"); },
    });
    assert.equal(await resolve(), token);
  });
}

test("Personal Node authentication failure is not replaced by a different account", async () => {
  const failure = new Error("desktop credentials are invalid");
  const resolve = createCloudAccessTokenResolver({
    resolvePersonalNodeCloudAccessTokenFromEnvironment: async () => { throw failure; },
    resolveHostAccessToken: async () => { throw new Error("host credentials must not be read"); },
  });
  await assert.rejects(resolve(), failure);
});

test("only a non-desktop environment uses the CLI, forwarding refresh to both resolvers", async () => {
  const desktopRefreshes: boolean[] = [];
  const hostRefreshes: Array<boolean | undefined> = [];
  const resolve = createCloudAccessTokenResolver({
    resolvePersonalNodeCloudAccessTokenFromEnvironment: async (refresh) => { desktopRefreshes.push(refresh); return undefined; },
    resolveHostAccessToken: async (options) => { hostRefreshes.push(options?.forceRefresh); return "host-token"; },
  });
  for (const forceRefresh of [true, false]) assert.equal(await resolve({ forceRefresh }), "host-token");
  assert.deepEqual(desktopRefreshes, [true, false]);
  assert.deepEqual(hostRefreshes, [true, false]);
});
