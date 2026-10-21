import assert from "node:assert/strict";
import { test } from "node:test";
import { batchUploadEntries } from "./src/upload-errors.js";

const sizeOf = (entry: { size: number }) => entry.size;
const entries = (...sizes: number[]) => sizes.map((size) => ({ size }));

test("keeps entries in order and under the caps", () => {
  const maxBatchBytes = 100;
  const maxBatchFiles = 2;
  assert.deepEqual(
    batchUploadEntries(entries(10, 20, 30, 40, 50), sizeOf, { maxBatchBytes, maxBatchFiles }),
    [entries(10, 20), entries(30, 40), entries(50)],
  );
});

test("splits on the byte cap even when the file count allows more", () => {
  assert.deepEqual(
    batchUploadEntries(entries(60, 60), sizeOf, { maxBatchBytes: 100, maxBatchFiles: 10 }),
    [entries(60), entries(60)],
  );
});

test("gives an entry larger than the byte cap its own batch", () => {
  assert.deepEqual(
    batchUploadEntries(entries(10, 250, 10), sizeOf, { maxBatchBytes: 100, maxBatchFiles: 10 }),
    [entries(10), entries(250), entries(10)],
  );
});
