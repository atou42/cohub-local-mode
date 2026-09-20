import assert from "node:assert/strict";
import { test } from "node:test";
import { limitBatchSize } from "../runtime/batch-limit.js";

const turn = (size: number) => ({ size });

test("batches are bounded by message count, byte budget and always keep the owner", () => {
  const sizeOf = (item: { size: number }) => item.size;
  assert.deepEqual(limitBatchSize([turn(1), turn(2), turn(3)], sizeOf, { messages: 2, bytes: 100 }), [turn(1), turn(2)]);
  assert.deepEqual(limitBatchSize([turn(4), turn(4), turn(4)], sizeOf, { messages: 10, bytes: 9 }), [turn(4), turn(4)]);
  // A single input larger than the whole budget still runs alone; it cannot be split further.
  assert.deepEqual(limitBatchSize([turn(50), turn(1)], sizeOf, { messages: 10, bytes: 9 }), [turn(50)]);
  assert.deepEqual(limitBatchSize([], sizeOf, { messages: 10, bytes: 9 }), []);
});
