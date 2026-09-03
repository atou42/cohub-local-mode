import assert from "node:assert/strict";
import test from "node:test";
import { SerialCommandBuffer } from "./serial-command-buffer.mjs";

function command(id) {
  return { id };
}

test("deduplicates a repeatedly delivered command while another command is active", () => {
  const buffer = new SerialCommandBuffer();
  assert.equal(buffer.defer(command("next"), "active"), "queued");
  for (let index = 0; index < 340; index += 1) {
    assert.equal(buffer.defer(command("next"), "active"), "duplicate");
  }
  assert.equal(buffer.size, 1);
  assert.deepEqual(buffer.shift(), command("next"));
  assert.equal(buffer.shift(), null);
});

test("does not buffer the active command and preserves distinct command order", () => {
  const buffer = new SerialCommandBuffer();
  assert.equal(buffer.defer(command("active"), "active"), "duplicate");
  assert.equal(buffer.defer(command("second"), "active"), "queued");
  assert.equal(buffer.defer(command("third"), "active"), "queued");
  assert.deepEqual(buffer.shift(), command("second"));
  assert.deepEqual(buffer.shift(), command("third"));
});
