import assert from "node:assert/strict";
import test from "node:test";
import {
  grokAuthenticationMethod,
  isExplicitSignOut,
  parseCliAuthenticationStatus,
  probeCliAuthentication,
} from "./harness-auth.js";

test("Codex uses the CLI's native cached identity without reading auth.json", async () => {
  const authenticated = await probeCliAuthentication("codex", {
    runStatus: async (command, args) => {
      assert.equal(command, "codex");
      assert.deepEqual(args, ["login", "status"]);
      return { code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" };
    },
  });
  assert.equal(authenticated, true);
});

test("Cursor uses native status including Keychain identities and disables updates", async () => {
  assert.equal(await probeCliAuthentication("cursor", {
    runStatus: async (_command, args) => {
      assert.deepEqual(args, ["--disable-auto-update", "status"]);
      return { code: 0, stdout: "\u001b[32mLogged in as account@example.com\u001b[0m", stderr: "" };
    },
  }), true);
});

test("explicit sign-out is distinct from CLI, network and Keychain errors", () => {
  for (const harness of ["codex", "cursor"] as const) {
    assert.equal(parseCliAuthenticationStatus(harness, { code: 1, stdout: "", stderr: "Not logged in" }), false);
    assert.throws(() => parseCliAuthenticationStatus(harness, { code: 1, stdout: "", stderr: "Keychain: Device not configured" }), /could not be confirmed/);
    assert.throws(() => parseCliAuthenticationStatus(harness, { code: 0, stdout: "CLI v1.0", stderr: "" }), /could not be confirmed/);
  }
  assert.equal(isExplicitSignOut("Authentication status timed out"), false);
  assert.equal(isExplicitSignOut("Authentication required"), true);
});

test("CLI errors never expose account or key output", () => {
  assert.throws(() => parseCliAuthenticationStatus("codex", {
    code: 2, stdout: "private@example.com", stderr: "sk-private-value",
  }), (error: Error) => {
    assert.equal(error.message.includes("private"), false);
    assert.match(error.message, /exit 2/);
    return true;
  });
});

test("Grok authenticates the existing CLI identity without starting a login flow", async () => {
  assert.equal(await probeCliAuthentication("grok_build", { grok: async () => true }), true);
  const advertised = { authMethods: [{ id: "cached_token" }, { id: "grok.com" }, { id: "xai.api_key" }] };
  assert.equal(grokAuthenticationMethod(advertised, false), "cached_token");
  assert.equal(grokAuthenticationMethod(advertised, true), "xai.api_key");
  assert.equal(grokAuthenticationMethod({ authMethods: [{ id: "grok.com" }] }, false), null);
  assert.throws(() => grokAuthenticationMethod({}, false), /invalid authentication methods/);
  assert.throws(() => grokAuthenticationMethod({ authMethods: [null] }, false), /invalid authentication methods/);
});
