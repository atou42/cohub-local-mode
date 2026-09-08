import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { allowLoopbackPort } from "../../../../scripts/test/no-network.mjs";
import { proxyUploadStream } from "./upload-stream.js";

test("proxies binary bytes to a real HTTP storage endpoint without text conversion", { timeout: 10000 }, async (t) => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 7).fill(0xff);
  bytes.set([0x50, 0x4b, 3, 4, 0, 0x80]);
  let received = 0;
  const hash = createHash("sha256");
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "PUT");
    assert.equal(request.headers["content-length"], String(bytes.length));
    for await (const chunk of request) { received += chunk.length; hash.update(chunk); }
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(allowLoopbackPort(address.port));
  await proxyUploadStream({ body: new Response(bytes).body, size: bytes.length, uploadUrl: `http://127.0.0.1:${address.port}/upload`, headers: { "content-type": "application/zip" } });
  assert.equal(received, bytes.length);
  assert.equal(hash.digest("hex"), createHash("sha256").update(bytes).digest("hex"));
});

test("rejects incomplete and oversized bodies without claiming upload success", async () => {
  for (const size of [1, 3]) {
    await assert.rejects(proxyUploadStream({ body: new Response("xx").body, size, uploadUrl: "https://storage.test/object", headers: {} }, async (_url, init) => {
      await new Response(init?.body).arrayBuffer();
      return new Response();
    }), /planned size/);
  }
});
