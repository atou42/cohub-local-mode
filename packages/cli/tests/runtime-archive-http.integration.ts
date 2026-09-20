import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_ARCHIVE_SEGMENT_BYTES } from "@neta-art/cohub";
import { RuntimeArchiveStore, type ArchiveTransport } from "../src/runtime/archive-store.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";

test("CLI sends only incremental bytes over HTTP and restores across multiple segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-http-"));
  const storage = await archiveStorageFixture();
  let uploaded = 0;
  const server = createServer(async (request, response) => {
    const key = request.url?.slice(1) ?? "";
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (createHash("md5").update(bytes).digest("base64") !== request.headers["content-md5"]) { response.writeHead(400).end(); return; }
      if (storage.objects.has(key)) { response.writeHead(412).end(); return; }
      storage.objects.set(key, bytes); uploaded += bytes.length;
      response.end();
    } else {
      const data = storage.objects.get(key);
      if (!data) { response.writeHead(404).end(); return; }
      response.end(data);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const transport: ArchiveTransport = {
      async prepareRuntimeArchive(index) {
        const { uploads } = await storage.transport.prepareRuntimeArchive(index);
        return { uploads: uploads.map(({ segment }) => ({ segment, uploadUrl: `${url}/${segment.sha256}`, headers: { "content-md5": Buffer.from(segment.md5, "hex").toString("base64") } })) };
      },
      commitRuntimeArchive: storage.transport.commitRuntimeArchive,
      async getRuntimeArchive(sessionId, turnId) {
        const page = await storage.transport.getRuntimeArchive(sessionId, turnId);
        return { ...page, segments: page.segments.map(({ segment }) => ({ segment, downloadUrl: `${url}/${segment.sha256}` })) };
      },
    };
    const store = new RuntimeArchiveStore(join(root, "state"), transport);
    const path = join(root, "native");
    const initial = Buffer.concat([Buffer.alloc(RUNTIME_ARCHIVE_SEGMENT_BYTES, "a"), Buffer.alloc(RUNTIME_ARCHIVE_SEGMENT_BYTES, "b"), Buffer.from("中文\n")]);
    await writeFile(path, initial);
    const state = { sessionId: randomUUID(), nativeSessionId: randomUUID(), harness: "pi" as const, path };
    const first = await store.stage(state, randomUUID());
    await store.flush(new AbortController().signal);
    const tail = Buffer.from("新增\n");
    await appendFile(path, tail);
    const second = await store.stage(state, randomUUID());
    await store.flush(new AbortController().signal);
    const index = storage.versions.get(second.turnId); assert(index);
    assert.equal(index.parentTurnId, first.turnId);
    assert.equal(index.segments.length, 1);
    assert.equal(index.segments[0]?.sizeBytes, tail.length);
    assert.equal(uploaded, initial.length + tail.length);
    const target = join(root, "restored");
    await new RuntimeArchiveStore(join(root, "cold"), transport).restore(second, target);
    assert.deepEqual(await readFile(target), Buffer.concat([initial, tail]));
    console.log(`archive bytes: baseline=${initial.length}, next-turn=${tail.length}, total=${uploaded}`);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close(); await rm(root, { recursive: true, force: true });
  }
});
