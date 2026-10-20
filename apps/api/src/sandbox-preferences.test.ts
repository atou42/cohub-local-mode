import assert from "node:assert/strict";
import test from "node:test";
import { parseSandboxPreferences, resolveSandboxPreferences } from "./sandbox-preferences.js";

const images = { default: "registry/sandbox@sha256:default", game: "registry/game@sha256:game" };

test("invalid sources remain readable but block provisioning until both fields are overridden", () => {
  const broken = { source: "mod:broken", preferences: {}, error: "Invalid JSON" };
  const input = { images, allowedSpec: "standard" as const, sources: [broken] };
  assert.equal(resolveSandboxPreferences(input).sources[0]?.error, "Invalid JSON");
  assert.throws(() => resolveSandboxPreferences({ ...input, strict: true }), /mod:broken/);
  assert.throws(() => resolveSandboxPreferences({ ...input, strict: true, sources: [broken, { source: "override", preferences: { image: "default" } }] }), /mod:broken/);
  const result = resolveSandboxPreferences({ ...input, strict: true, sources: [broken, { source: "override", preferences: { image: "default", spec: "standard" } }] });
  assert.deepEqual(result.effective, { image: "default", spec: "standard" });
});

test("config schema rejects unknown versions, arbitrary images and container settings", () => {
  for (const input of [null, [], { version: 2 }, { version: 1, image: "registry/custom" }, { version: 1, spec: "gpu" }, { version: 1, privileged: true }]) {
    assert.throws(() => parseSandboxPreferences(input, true));
  }
  assert.deepEqual(parseSandboxPreferences({ version: 1, image: "game" }, true), { image: "game" });
});
