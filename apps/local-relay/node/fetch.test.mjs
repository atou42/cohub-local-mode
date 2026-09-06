import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { compatibleFetch } from "./fetch.mjs";

test("real HTTP no-content responses retain status and headers without an illegal body", async (t) => {
	const server = createServer((req, res) => {
		const status = Number(req.url.slice(1));
		res.writeHead(status, { "x-fixture": "preserved", "content-type": "text/plain" });
		res.end(status === 200 ? "actual response" : undefined);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((resolve) => server.close(resolve)));
	for (const status of [204, 205, 304, 200]) {
		const response = await compatibleFetch(`http://127.0.0.1:${server.address().port}/${status}`);
		assert.equal(response.status, status);
		assert.equal(response.headers.get("x-fixture"), "preserved");
		if (status !== 200) assert.equal(response.body, null);
		assert.equal(await response.text(), status === 200 ? "actual response" : "");
	}
});
