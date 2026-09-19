import assert from "node:assert/strict";
import test from "node:test";

const routingModulePath = "../harness-routing.ts";
const { resolveHarnessRoute } = await import(routingModulePath);

test("explicit Runtime harnesses take priority over the legacy Session harness", () => {
  assert.deepEqual(resolveHarnessRoute({ harness: "pi" }, "codex"), {
    kind: "runtime",
    harness: "pi",
  });
  assert.deepEqual(resolveHarnessRoute({ harness: "codex" }, "pi"), {
    kind: "runtime",
    harness: "codex",
  });
});

test("legacy Session harnesses stay in the external or service-side domain", () => {
  for (const harness of ["pi", "codex", "grok_build", "cursor"] as const) {
    assert.deepEqual(resolveHarnessRoute({ harness: "cohub" }, harness), {
      kind: "session",
      harness,
    });
  }
});

test("missing Turn harness never defaults into the Runtime path", () => {
  for (const harness of ["pi", "codex", "grok_build", "cursor"] as const) {
    assert.deepEqual(resolveHarnessRoute({}, harness), {
      kind: "session",
      harness,
    });
    assert.deepEqual(resolveHarnessRoute(null, harness), {
      kind: "session",
      harness,
    });
  }
});
