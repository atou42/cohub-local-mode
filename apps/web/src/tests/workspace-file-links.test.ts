import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeWorkspaceFileLink,
  normalizeWorkspaceFileLinkTarget,
} from "../lib/workspace-file-links.ts";

test("decodes workspace filenames once, after parsing URL and line suffixes", () => {
  for (const [href, path] of [
    ["/workspace/output/report%231%3F.txt", "output/report#1?.txt"],
    ["/workspace/output/note%3A7", "output/note:7"],
    ["/workspace/output/literal%252e.txt", "output/literal%2e.txt"],
    ["/workspace/output/trailing%20space%20", "output/trailing space "],
    ["/workspace/%252e%252e/file", "%2e%2e/file"],
    ["note%3A7", "note:7"],
    ["%23file", "#file"],
  ]) {
    assert.deepEqual(normalizeWorkspaceFileLinkTarget(href), { path, position: undefined }, href);
  }
  assert.deepEqual(normalizeWorkspaceFileLinkTarget("/workspace/note%3A7:12:3?download=1#section"), {
    path: "note:7", position: { line: 12, column: 3 },
  });
});

test("keeps workspace aliases, relative links, queries and line positions", () => {
  assert.equal(normalizeWorkspaceFileLink("/workspace/docs/report%20%28final%29.md"), "docs/report (final).md");
  assert.equal(normalizeWorkspaceFileLink("workspace/docs/report.md?download=1#section"), "docs/report.md");
  assert.equal(normalizeWorkspaceFileLink("../report.md", { basePath: "docs/notes/readme.md" }), "docs/report.md");
  assert.equal(normalizeWorkspaceFileLink("/workspace/docs/%2e%2e/report.md"), "report.md");
  assert.deepEqual(normalizeWorkspaceFileLinkTarget("/workspace/src/main.ts:12:3"), {
    path: "src/main.ts", position: { line: 12, column: 3 },
  });
});

test("rejects external paths, escaped separators, traversal and controls", () => {
  for (const href of [
    "https://example.com/file", "file:///etc/passwd", "//example.com/file", "#section",
    "/etc/passwd", "/workspace", "/workspace/", "/workspace/../secret",
    "/workspace/%2e%2e/secret", "../../secret", "/workspace/a%2fb", "/workspace/a%2Fb",
    "/workspace/a%5cb", "/workspace/a\\b", "/workspace/a%00b", "/workspace/a%0Ab",
    "/workspace/a%7Fb", "/workspace/a%ZZ", "/workspace/a%",
  ]) assert.equal(normalizeWorkspaceFileLinkTarget(href), null, href);
});
