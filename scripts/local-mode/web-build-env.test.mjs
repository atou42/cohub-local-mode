import assert from "node:assert/strict";
import test from "node:test";
import { webBuildEnvironment } from "./web-build-env.mjs";

test("web builds exclude backend PUBLIC settings without changing the server environment", () => {
  const input = {
    PATH: "/test/bin",
    PUBLIC_API_ORIGIN: "https://example.test",
    PUBLIC_LOGTO_APP_ID: "public-app-id",
    PUBLIC_ASSET_OSS_ACCESS_KEY_ID: "fixture-access-key",
    PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY: "fixture-secret",
    PUBLIC_UNKNOWN_SETTING: "not-reviewed-for-browser-use",
    COHUB_WEB_BUILD_OUT_DIR: ".isolated-build",
  };
  const before = structuredClone(input);
  assert.deepEqual(webBuildEnvironment(input), {
    PATH: "/test/bin",
    PUBLIC_API_ORIGIN: "https://example.test",
    PUBLIC_LOGTO_APP_ID: "public-app-id",
    COHUB_WEB_BUILD_OUT_DIR: ".isolated-build",
  });
  assert.deepEqual(input, before);
});
