import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { HTTP_BODY_PART_BYTES, requestBodyParts, responseBodyParts } from "./http-body.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("streams a large binary response through verified parts and restores every byte", async () => {
  const bytes = Buffer.alloc(HTTP_BODY_PART_BYTES * 2 + 179, 0xff);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0, 0x80]);
  const objects = new Map();
  const encoded = await responseBodyParts(new Response(bytes), {
    maxBytes: bytes.length,
    uploadPart: async (part, hash) => {
      assert.ok(part.length <= HTTP_BODY_PART_BYTES);
      assert.equal(hash, digest(part));
      const id = randomUUID();
      objects.set(id, Buffer.from(part));
      return id;
    },
  });
  assert.equal(encoded.bodyParts.length, 3);
  assert.equal(encoded.bytes, undefined);
  const restored = requestBodyParts(encoded.bodyParts, {
    relayNodeBaseUrl: "https://relay.test/api/alpha/v1/nodes/test", relayNodeToken: "test-only",
    fetcher: async (url) => {
      const id = new URL(url).pathname.split("/").at(-2);
      const part = objects.get(id);
      return new Response(part, { headers: { "content-length": String(part.length), "x-cohub-attachment-id": id, "x-cohub-attachment-sha256": digest(part) } });
    },
  });
  const hash = createHash("sha256");
  let size = 0;
  for await (const part of restored) { size += part.length; hash.update(part); }
  assert.equal(size, bytes.length);
  assert.equal(hash.digest("hex"), digest(bytes));
});

test("rejects corrupt transfer parts before yielding their bytes", async () => {
  const id = randomUUID();
  const sha256 = digest(Buffer.from("expected"));
  const stream = requestBodyParts([{ id, size: 8, sha256 }], {
    relayNodeBaseUrl: "https://relay.test/nodes/test", relayNodeToken: "test-only",
    fetcher: async () => new Response("corrupt!", { headers: { "content-length": "8", "x-cohub-attachment-id": id, "x-cohub-attachment-sha256": sha256 } }),
  });
  let bytes = 0;
  await assert.rejects(async () => { for await (const chunk of stream) bytes += chunk.length; }, /checksum mismatch/);
  assert.equal(bytes, 0);
});

test("keeps small binary responses inline and reports a size violation explicitly", async () => {
  const bytes = Buffer.from([0, 0xff, 0x80, 0x50, 0x4b]);
  assert.deepEqual((await responseBodyParts(new Response(bytes), { maxBytes: 5 })).bytes, bytes);
  await assert.rejects(responseBodyParts(new Response(bytes), { maxBytes: 4 }), /exceeds 4 bytes/);
  await assert.rejects(responseBodyParts(new Response(Buffer.alloc(140_000)), { maxBytes: 140_000 }), /requires relay body storage/);
});
