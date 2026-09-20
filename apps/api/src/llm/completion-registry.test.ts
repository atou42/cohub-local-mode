import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CompletionModelRegistry } from "./completion-registry.js";

function catalog(models: ModelsConfig["providers"][string]["models"]): ModelsConfig {
  return {
    providers: {
      cohub: { api: "openai-responses", baseUrl: "https://example.test", models },
    },
  };
}

test("hidden models stay resolvable by explicit id", () => {
  const registry = new CompletionModelRegistry([catalog([{ id: "visible" }, { id: "hidden", hidden: true }])]);

  assert.deepEqual(registry.getAvailable().map((model) => model.id), ["visible", "hidden"]);
  assert.equal(registry.find("cohub", "hidden")?.id, "hidden");
});

test("hidden models never become implicit defaults", () => {
  const registry = new CompletionModelRegistry([catalog([{ id: "hidden", hidden: true }, { id: "visible" }])]);

  assert.deepEqual(registry.getDiscoverable().map((model) => model.id), ["visible"]);
  assert.equal(registry.getDefault()?.id, "visible");
});

test("default falls back to hidden only when nothing else is available", () => {
  const registry = new CompletionModelRegistry([catalog([{ id: "hidden", hidden: true }])]);

  assert.deepEqual(registry.getDiscoverable(), []);
  assert.equal(registry.getDefault()?.id, "hidden");
});
