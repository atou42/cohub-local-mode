import assert from "node:assert/strict";
import test from "node:test";
import {
  SPACE_HOOKS_CACHE_TTL_SEC,
  SPACE_HOOKS_EMPTY_CACHE_TTL_SEC,
  isSpaceHooksConfigPath,
  shouldRefreshSpaceHooksCache,
} from "./src/space-hooks.js";

test("empty hook cache TTL is short and distinct from the positive TTL", () => {
  assert.equal(SPACE_HOOKS_EMPTY_CACHE_TTL_SEC, 30);
  assert.equal(SPACE_HOOKS_CACHE_TTL_SEC, 5 * 60);
  assert.notEqual(SPACE_HOOKS_EMPTY_CACHE_TTL_SEC, SPACE_HOOKS_CACHE_TTL_SEC);
});

test("isSpaceHooksConfigPath matches the hooks directory and files under it", () => {
  assert.equal(isSpaceHooksConfigPath(".cohub/hooks"), true);
  assert.equal(isSpaceHooksConfigPath(".cohub/hooks/on-fs.yml"), true);
  assert.equal(isSpaceHooksConfigPath("./.cohub/hooks/on-fs.yml"), true);
  assert.equal(isSpaceHooksConfigPath("/.cohub/hooks/on-fs.yml"), true);
  assert.equal(isSpaceHooksConfigPath(".cohub/hooks\\on-fs.yml"), true);
  assert.equal(isSpaceHooksConfigPath("src/a.ts"), false);
  assert.equal(isSpaceHooksConfigPath(".cohub/other.yml"), false);
});

test("shouldRefreshSpaceHooksCache treats workspace.ready and hook file changes as refresh", () => {
  assert.equal(shouldRefreshSpaceHooksCache({ type: "space.workspace.ready" }), true);
  assert.equal(
    shouldRefreshSpaceHooksCache({
      type: "space.fs.changed",
      paths: [".cohub/hooks/on-fs.yml"],
    }),
    true,
  );
  assert.equal(
    shouldRefreshSpaceHooksCache({
      type: "space.fs.changed",
      paths: ["src/a.ts"],
    }),
    false,
  );
  assert.equal(
    shouldRefreshSpaceHooksCache({
      type: "space.fs.changed",
      paths: [],
    }),
    false,
  );
  assert.equal(shouldRefreshSpaceHooksCache({ type: "session.turn.finalized" }), false);
  assert.equal(shouldRefreshSpaceHooksCache({ type: "checkpoint.created" }), false);
});
