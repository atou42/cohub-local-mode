import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import "./fetch-polyfill.mjs";

for (const requestObject of [false, true]) test(`desktop fetch preserves streaming request bytes (${requestObject ? "Request" : "URL"})`, async (t) => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 7).fill(0xff);
  bytes.set([0x50, 0x4b, 3, 4, 0, 0x80]);
  const server = createServer(async (request, response) => {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of request) { size += chunk.length; hash.update(chunk); }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ size, sha256: hash.digest("hex") }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  const init = { method: "PUT", body: new Response(bytes).body, duplex: "half", signal: AbortSignal.timeout(5000) };
  const result = await (requestObject ? fetch(new Request(url, init)) : fetch(url, init));
  assert.deepEqual(await result.json(), { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
});
