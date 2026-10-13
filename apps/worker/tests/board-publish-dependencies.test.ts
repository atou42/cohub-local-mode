import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyBoardDocument, parseBoardDocument } from "@cohub/protocol";
import { collectBoardPublishReferences } from "../src/system/jobs/app-publish-asset/board-dependencies.js";

test("publishing captures transitive script dependencies once", async () => {
  const parsed = parseBoardDocument({ ...emptyBoardDocument(), items: {
    a: { type: "custom", script: { src: "a.js" } },
    b: { type: "custom", script: { src: "b.js", enabled: false } },
  } });
  assert.ok(parsed.ok);
  const files = new Map([
    ["a.js", 'export {value} from "./shared.mjs";'],
    ["b.js", 'export const load = () => import("./shared.mjs");'],
    ["shared.mjs", "export const value = 42;"],
  ]);
  const expected = [...files.keys()].sort();
  const refs = await collectBoardPublishReferences(parsed.document, async (path) => {
    const code = files.get(path);
    assert.ok(code !== undefined, `Missing or repeated read: ${path}`);
    files.delete(path);
    return code;
  }, 1000);
  assert.deepEqual(refs.files, expected);
});
