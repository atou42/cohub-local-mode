import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HttpPutError, putLocalFile } from "../src/http-put.js";

const tempDirs: string[] = [];
const noSleep = { delayMs: 0, sleep: async () => {} };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempFile(contents: string): Promise<{ path: string; size: number }> {
  const dir = await mkdtemp(join(tmpdir(), "cohub-put-"));
  tempDirs.push(dir);
  const path = join(dir, "styles.css");
  await writeFile(path, contents);
  return { path, size: Buffer.byteLength(contents) };
}

test("sets content-length and retries transient PUT failures", async () => {
  const file = await tempFile("body{}\n");
  const lengths: Array<string | null> = [];
  let attempts = 0;
  await putLocalFile({
    url: "https://upload.example/styles.css",
    filePath: file.path,
    size: file.size,
    headers: { "content-type": "text/css" },
    label: "styles.css",
    fetch: async (_url, init) => {
      attempts += 1;
      lengths.push(new Headers(init?.headers).get("content-length"));
      if (init?.body && Symbol.asyncIterator in Object(init.body)) {
        for await (const _chunk of init.body as AsyncIterable<unknown>) {
          // Drain so a retry must open a new stream.
        }
      }
      if (attempts === 1) return new Response("length required", { status: 411 });
      if (attempts === 2) {
        const error = new Error("fetch failed");
        error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw error;
      }
      return new Response(null, { status: 200 });
    },
    ...noSleep,
  });
  assert.equal(attempts, 3);
  assert.deepEqual(lengths, [String(file.size), String(file.size), String(file.size)]);
});

test("does not retry 403", async () => {
  const file = await tempFile("body{}\n");
  let attempts = 0;
  await assert.rejects(
    () => putLocalFile({
      url: "https://upload.example/styles.css",
      filePath: file.path,
      size: file.size,
      label: "styles.css",
      fetch: async () => {
        attempts += 1;
        return new Response("no", { status: 403 });
      },
      ...noSleep,
    }),
    (error: unknown) => error instanceof HttpPutError && error.status === 403 && attempts === 1,
  );
});
