import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { constants, zstdCompressSync } from "node:zlib";
import { codexRolloutBytes, readNativeTranscriptHeader } from "../src/runtime/native/transcript.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cohub-compressed-rollout-"));
  const path = join(root, "session.jsonl.zst");
  const header = `${JSON.stringify({ type: "session_meta", payload: { id: "thread", cwd: root, base_instructions: "历史" } })}\n`;
  const raw = Buffer.from(`${header}${JSON.stringify({ type: "ignored", payload: "tail".repeat(1024 * 1024) })}\n`);
  await writeFile(path, zstdCompressSync(raw));
  return { path, root, header, raw, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function readBytes(path: string, endBytes: number | null, signal?: AbortSignal) {
  const chunks: Buffer[] = [];
  for await (const chunk of codexRolloutBytes(path, endBytes, signal)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("compressed headers and exact prefixes survive early reader cancellation", async () => {
  const f = await fixture();
  try {
    const transcript = new URL("../src/runtime/native/transcript.ts", import.meta.url).href;
    const adapters = new URL("../src/runtime/native/adapters.ts", import.meta.url).href;
    // A separate process detects late unhandled decoder errors after the read has returned.
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { createHash } from "node:crypto";
      import { codexRolloutBytes, readNativeTranscriptHeader } from ${JSON.stringify(transcript)};
      import { readSessionHeader } from ${JSON.stringify(adapters)};
      const path = ${JSON.stringify(f.path)}, cwd = ${JSON.stringify(f.root)};
      assert.deepEqual(await readNativeTranscriptHeader(path, "codex"), { nativeSessionId: "thread", cwd });
      assert.deepEqual(await readSessionHeader(path, "codex"), { harness: "codex", nativeSessionId: "thread", cwd, thread: "user" });
      const chunks = [];
      for await (const chunk of codexRolloutBytes(path, ${Buffer.byteLength(f.header)})) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), ${JSON.stringify(f.header)});
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of codexRolloutBytes(path, ${f.raw.length})) { bytes += chunk.length; hash.update(chunk); }
      assert.equal(bytes, ${f.raw.length});
      assert.equal(hash.digest("hex"), ${JSON.stringify(createHash("sha256").update(f.raw).digest("hex"))});
      console.log("headers and exact prefix survived");
    `], { cwd: process.cwd(), timeout: 10_000 });
    assert.equal(result.stdout.trim(), "headers and exact prefix survived");
    assert.equal(result.stderr, "");
  } finally { await f.cleanup(); }
});

test("compressed reads preserve full bytes and reject invalid prefix boundaries", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readBytes(f.path, null), f.raw);
    await assert.rejects(readBytes(f.path, f.raw.length + 1), /past the end/);
    await assert.rejects(readBytes(f.path, Buffer.byteLength(f.header) - 1), /record boundary/);
  } finally { await f.cleanup(); }
});

test("corrupt compressed rollouts reject instead of being mistaken for reader cancellation", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, "not a zstd frame");
    await assert.rejects(readNativeTranscriptHeader(f.path, "codex"), { code: "ZSTD_error_prefix_unknown" });
    const corrupt = zstdCompressSync(f.raw, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    corrupt.writeUInt8(corrupt.readUInt8(corrupt.length - 1) ^ 1, corrupt.length - 1);
    await writeFile(f.path, corrupt);
    await assert.rejects(readBytes(f.path, null), { code: "ZSTD_error_checksum_wrong" });
  } finally { await f.cleanup(); }
});

test("compressed reads expose caller cancellation before reading and during early cleanup", async () => {
  const f = await fixture();
  try {
    const reason = new Error("Caller cancelled rollout reading");
    const before = AbortSignal.abort(reason);
    await assert.rejects(readNativeTranscriptHeader(f.path, "codex", before), { name: "AbortError", cause: reason });
    for (const finish of ["next", "return"] as const) {
      const controller = new AbortController();
      const iterator = codexRolloutBytes(f.path, null, controller.signal);
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.deepEqual(first.value, f.raw.subarray(0, first.value?.length));
      controller.abort(reason);
      await assert.rejects(finish === "next" ? iterator.next() : iterator.return(undefined), { name: "AbortError", cause: reason });
    }
  } finally { await f.cleanup(); }
});
