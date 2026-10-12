import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuntimeHarnesses } from "../src/runtime/launch.js";
import { formatNativeSync } from "../src/runtime/presentation.js";
import { installedHarnesses } from "../src/runtime/harness.js";

test("WorkBuddy is accepted as an explicit runtime harness and is named distinctly", () => {
  assert.deepEqual(parseRuntimeHarnesses(["workbuddy,codex", "workbuddy"]), ["workbuddy", "codex"]);
  assert.throws(() => parseRuntimeHarnesses(["codebuddy"]), /Harness/);
  const output = formatNativeSync({ version: 2, identity: "me", root: "/project", spaceId: "space", harnesses: ["workbuddy"], enabledAt: new Date().toISOString(), codexShared: false }, undefined);
  assert.match(output, /WorkBuddy/);
  assert.doesNotMatch(output, /Native sync {2}Codex/);
});

test("runtime discovers WorkBuddy separately from PATH and does not hide broken installs", async () => {
  assert.deepEqual(await installedHarnesses("/workspace", {}, "", async () => true), ["workbuddy"]);
  assert.deepEqual(await installedHarnesses("/workspace", {}, "", async () => false), []);
  await assert.rejects(installedHarnesses("/workspace", {}, "", async () => { throw new Error("Invalid product configuration"); }), /Invalid product configuration/);
  await assert.rejects(installedHarnesses("/workspace", { workbuddy: "/missing" }, "", async () => false), /requested path/);
});
