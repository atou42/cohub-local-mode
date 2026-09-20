import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harnessArchiveIndexSchema, validateArchiveBoundary, type HarnessArchiveIndex } from "./src/runtime/archive.js";
import { runtimeEventSchema } from "./src/runtime/index.js";

const base = (): HarnessArchiveIndex => ({ version: 1, sessionId: randomUUID(), turnId: randomUUID(), harness: "pi", nativeFormat: "pi.jsonl", nativeSessionId: "native", parentTurnId: null, sizeBytes: 4, sha256: "a".repeat(64), segments: [{ offset: 0, sizeBytes: 4, sha256: "a".repeat(64), md5: "b".repeat(32) }] });
test("archive manifests are bounded, local-only and contiguous", () => {
  const parent = base();
  validateArchiveBoundary(parent, null);
  const child = { ...parent, turnId: randomUUID(), parentTurnId: parent.turnId, sizeBytes: 8, segments: [{ ...parent.segments[0], offset: 4 }] } as HarnessArchiveIndex;
  validateArchiveBoundary(child, parent);
  assert.throws(() => validateArchiveBoundary({ ...child, segments: [{ ...child.segments[0], offset: 3 }] } as HarnessArchiveIndex, parent), /contiguous/);
  assert.throws(() => validateArchiveBoundary(child, { ...parent, sessionId: randomUUID() }), /identity/);
  assert.throws(() => validateArchiveBoundary({ ...child, segments: [] }, parent), /incomplete/);
  assert(!harnessArchiveIndexSchema.safeParse({ ...parent, harness: "cohub" }).success);
  assert(!harnessArchiveIndexSchema.safeParse({ ...parent, segments: [...Array(257)].fill(parent.segments[0]) }).success);
});

test("Runtime frames carry only archive identity, never native data", () => {
  const index = base();
  const event = { type: "turn.end", message: { ordinal: 0, content: [{ type: "text", text: "done" }] }, resume: "native",
    archive: { sessionId: index.sessionId, turnId: index.turnId, harness: "pi" } };
  assert(runtimeEventSchema.safeParse(event).success);
  assert(!runtimeEventSchema.safeParse({ ...event, archive: { ...event.archive, data: "native file" } }).success);
});
