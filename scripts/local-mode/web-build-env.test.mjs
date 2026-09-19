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

test("existing local deployments resolve new public build settings without exposing storage credentials", () => {
  const result = webBuildEnvironment({
    PUBLIC_COHUB_LOCAL_MODE: "true",
    PUBLIC_API_ORIGIN: "https://local.example.test",
    PUBLIC_ASSET_CDN_BASE_URL: "https://local.example.test/assets",
    PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY: "must-not-leak",
  });
  assert.equal(result.PUBLIC_FILES_ORIGIN, "https://local.example.test/assets");
  assert.equal(result.PUBLIC_PREVIEW_ORIGIN, "https://local.example.test");
  assert.equal(result.PUBLIC_MARKETPLACE_APP_ID, "");
  assert.equal(result.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY, undefined);
  assert.equal(result.PUBLIC_ASSET_CDN_BASE_URL, undefined);
  const explicit = webBuildEnvironment({ ...result, PUBLIC_FILES_ORIGIN: "https://files.example.test", PUBLIC_MARKETPLACE_APP_ID: "configured-app" });
  assert.equal(explicit.PUBLIC_FILES_ORIGIN, "https://files.example.test");
  assert.equal(explicit.PUBLIC_MARKETPLACE_APP_ID, "configured-app");
});
