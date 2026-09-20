import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyEnvPresent, shouldRelaunchWithEnvProxy } from "../src/env-proxy.js";

test("relaunches with --use-env-proxy only when Node supports it", () => {
  const proxy = { HTTPS_PROXY: "http://127.0.0.1:8080" };
  assert.equal(proxyEnvPresent({}), false);
  assert.equal(proxyEnvPresent(proxy), true);
  assert.equal(shouldRelaunchWithEnvProxy([], proxy, "24.20.0"), true);
  assert.equal(shouldRelaunchWithEnvProxy(["--use-env-proxy"], proxy, "24.20.0"), false);
  assert.equal(shouldRelaunchWithEnvProxy([], proxy, "22.21.0"), true);
  assert.equal(shouldRelaunchWithEnvProxy([], proxy, "22.20.0"), false);
});
