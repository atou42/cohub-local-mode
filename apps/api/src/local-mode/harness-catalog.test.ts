import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessCatalogError,
  getCatalogEfforts,
  parseCodexModelsCache,
  parseGrokModelsCache,
  parseCursorAcpModels,
  clearCursorModelCatalogCacheForTests,
  loadExternalHarnessCatalog,
  validateExternalHarnessSelection,
} from "./harness-catalog.js";

const now = new Date("2026-08-24T04:00:00.000Z");

test("Codex cache exposes only visible models with exact effort menus", () => {
  const catalog = parseCodexModelsCache(JSON.stringify({
    fetched_at: "2026-08-24T03:59:00.000Z",
    client_version: "0.148.0",
    models: [
      {
        slug: "hidden",
        display_name: "Hidden",
        visibility: "hide",
        priority: 0,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "medium" }],
      },
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        priority: 1,
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
          { effort: "max" },
          { effort: "ultra" },
        ],
        additional_speed_tiers: ["fast"],
        service_tiers: [{
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        }],
        default_service_tier: null,
        input_modalities: ["text", "image"],
      },
    ],
  }), { now });

  assert.deepEqual(catalog.map((entry) => entry.id), ["gpt-5.6-sol"]);
  const [sol] = catalog;
  assert.ok(sol);
  assert.equal(sol.provider, "codex");
  assert.deepEqual(getCatalogEfforts(sol), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(catalog[0]?.model.defaultThinkingLevel, "low");
  assert.deepEqual(catalog[0]?.model.serviceTiers, [{
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage",
  }]);
  assert.equal(catalog[0]?.model.defaultServiceTier, null);
});

test("Grok cache preserves the per-model effort difference", () => {
  const model = (id: string, efforts: string[]) => ({
    info: {
      id,
      name: id === "grok-4.6" ? "Grok 4.6" : "Grok 4.5",
      hidden: false,
      supported_in_api: true,
      supports_reasoning_effort: true,
      reasoning_effort: "high",
      reasoning_efforts: efforts.map((value) => ({ value })),
    },
  });
  const catalog = parseGrokModelsCache(JSON.stringify({
    fetched_at: "2026-08-24T03:59:00.000Z",
    grok_version: "1.0.5",
    models: {
      "grok-4.6": model("grok-4.6", ["xhigh", "high", "medium", "low"]),
      "grok-4.5": model("grok-4.5", ["high", "medium", "low"]),
    },
  }), { now });

  const [grok46, grok45] = catalog;
  assert.ok(grok46);
  assert.ok(grok45);
  assert.deepEqual(getCatalogEfforts(grok46), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(getCatalogEfforts(grok45), ["low", "medium", "high"]);
});

test("Cursor catalog exposes only the selected models with exact ACP ids and real effort variants", () => {
  const catalog = parseCursorAcpModels({
    models: {
      availableModels: [
        { modelId: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
        { modelId: "claude-fable-5-1[thinking=true,context=300k,effort=high]", name: "claude-fable-5-1" },
        { modelId: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", name: "GPT-5.6-Sol" },
      ],
    },
  }, now);
  assert.deepEqual(catalog.map((entry) => entry.id), [
    "grok-4.6[effort=high,fast=true]",
    "claude-fable-5-1[thinking=true,context=300k,effort=high]",
  ]);
  const [grok, fable] = catalog;
  assert.ok(grok);
  assert.ok(fable);
  assert.deepEqual(getCatalogEfforts(grok), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(getCatalogEfforts(fable), ["low", "medium", "high", "xhigh", "max"]);
});

test("Cursor catalog survives an API restart through the local disk cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-cursor-catalog-cache-"));
  const executable = join(root, "fake-agent.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) output({ jsonrpc: "2.0", id: 1, result: {} });
  else if (request.id === 2) output({ jsonrpc: "2.0", id: 2, result: {} });
  else if (request.id === 3) output({ jsonrpc: "2.0", id: 3, result: { models: { availableModels: [
    { modelId: "grok-4.6[effort=high,fast=true]", name: "grok-4.6" },
    { modelId: "claude-fable-5-1[thinking=true,context=300k,effort=high]", name: "claude-fable-5-1" },
  ] } } });
});
`, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  const previousCacheDir = process.env.LOCAL_HARNESS_CATALOG_CACHE_DIR;
  const previousCommand = process.env.CURSOR_AGENT_COMMAND;
  process.env.LOCAL_HARNESS_CATALOG_CACHE_DIR = root;
  process.env.CURSOR_AGENT_COMMAND = executable;
  clearCursorModelCatalogCacheForTests();
  try {
    const first = await loadExternalHarnessCatalog("cursor");
    assert.deepEqual(first.map((entry) => entry.model.name), ["grok-4.6", "claude-fable-5-1"]);
    const persisted = await readFile(join(root, "cache", "cursor-models.v2.json"), "utf8");
    assert.match(persisted, /"version":4/);

    clearCursorModelCatalogCacheForTests();
    process.env.CURSOR_AGENT_COMMAND = join(root, "missing-agent");
    const restored = await loadExternalHarnessCatalog("cursor");
    assert.deepEqual(restored.map((entry) => entry.id), first.map((entry) => entry.id));
  } finally {
    clearCursorModelCatalogCacheForTests();
    if (previousCacheDir === undefined) delete process.env.LOCAL_HARNESS_CATALOG_CACHE_DIR;
    else process.env.LOCAL_HARNESS_CATALOG_CACHE_DIR = previousCacheDir;
    if (previousCommand === undefined) delete process.env.CURSOR_AGENT_COMMAND;
    else process.env.CURSOR_AGENT_COMMAND = previousCommand;
  }
});

test("missing, malformed, stale, and unsupported catalog data fail closed", () => {
  const valid = {
    fetched_at: "2026-08-20T03:59:00.000Z",
    client_version: "0.148.0",
    models: [],
  };
  assert.throws(
    () => parseCodexModelsCache("not-json", { now }),
    HarnessCatalogError,
  );
  assert.throws(
    () => parseCodexModelsCache(JSON.stringify(valid), { now, maxAgeMs: 60_000 }),
    /stale/,
  );
  assert.throws(
    () => parseCodexModelsCache(JSON.stringify({ ...valid, fetched_at: now.toISOString(), models: [{
      slug: "future-model",
      display_name: "Future",
      visibility: "list",
      default_reasoning_level: "warp",
      supported_reasoning_levels: [{ effort: "warp" }],
    }] }), { now }),
    /unsupported: warp/,
  );
});

test("external selection rejects cross-harness models and unsupported effort", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-grok-catalog-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "models_cache.json"), JSON.stringify({
    fetched_at: new Date().toISOString(),
    grok_version: "1.0.5",
    models: {
      "grok-4.5": {
        info: {
          id: "grok-4.5",
          name: "Grok 4.5",
          hidden: false,
          supported_in_api: true,
          supports_reasoning_effort: true,
          reasoning_effort: "high",
          reasoning_efforts: ["low", "medium", "high"].map((value) => ({ value })),
        },
      },
    },
  }));
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = root;
  try {
    const crossHarness = await validateExternalHarnessSelection({
      harness: "grok_build",
      provider: "codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      serviceTier: null,
    });
    assert.deepEqual(crossHarness, {
      ok: false,
      code: "model_unavailable",
      message: "Select a model for the chosen agent",
    });

    const unsupported = await validateExternalHarnessSelection({
      harness: "grok_build",
      provider: "grok_build",
      model: "grok-4.5",
      thinkingLevel: "xhigh",
      serviceTier: null,
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, "effort_unavailable");

    const supported = await validateExternalHarnessSelection({
      harness: "grok_build",
      provider: "grok_build",
      model: "grok-4.5",
      thinkingLevel: "medium",
      serviceTier: null,
    });
    assert.equal(supported.ok, true);

    const syntheticFast = await validateExternalHarnessSelection({
      harness: "grok_build",
      provider: "grok_build",
      model: "grok-4.5",
      thinkingLevel: "low",
      serviceTier: "priority",
    });
    assert.equal(syntheticFast.ok, false);
    assert.equal(syntheticFast.code, "service_tier_unavailable");
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});

test("Codex selection accepts only service tiers declared by that model", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-catalog-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "models_cache.json"), JSON.stringify({
    fetched_at: new Date().toISOString(),
    client_version: "0.148.0",
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      additional_speed_tiers: ["fast"],
      service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
      default_service_tier: null,
    }, {
      slug: "gpt-5.4-mini",
      display_name: "GPT-5.4-Mini",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium" }],
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
    }],
  }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const fast = await validateExternalHarnessSelection({
      harness: "codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      serviceTier: "priority",
    });
    assert.equal(fast.ok, true);

    const unsupported = await validateExternalHarnessSelection({
      harness: "codex",
      provider: "codex",
      model: "gpt-5.4-mini",
      thinkingLevel: "medium",
      serviceTier: "priority",
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, "service_tier_unavailable");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
