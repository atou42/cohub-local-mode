import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import { createDesktopWebServer } from "./web-server.mjs";

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
	const sockets = new Set();
	function track(server) {
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
	}
	const seen = [];
	const api = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		seen.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
		res.writeHead(201, { "content-type": "application/json" });
		res.end(JSON.stringify({ id: "stored-once", body }));
	});
	const apiOrigin = await listen(api);
	track(api);
	const gateway = createServer();
	gateway.on("upgrade", (_req, socket, head) => {
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		if (head.length) socket.write(head);
		socket.on("data", (chunk) => socket.write(chunk));
	});
	const gatewayOrigin = await listen(gateway);
	track(gateway);
	const secret = randomBytes(32).toString("base64url");
	// Reserve an ephemeral port first so the real server can enforce its exact Host.
	const reservation = createServer();
	const webOrigin = await listen(reservation);
	await new Promise((resolve) => reservation.close(resolve));
	const errors = [];
	const web = createDesktopWebServer({
		handler: (_req, res) => res.end("rendered app"),
		webOrigin, apiOrigin, gatewayOrigin, secret,
		onError: (error) => errors.push(error),
	});
	web.listen(Number(new URL(webOrigin).port), "127.0.0.1");
	await once(web, "listening");
	track(web);
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		for (const server of [web, api, gateway]) {
			if (!server.listening) continue;
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
	return { webOrigin, secret, api, seen, errors };
}

test("only the owning desktop session can read the app or proxy writes", { timeout: 10000 }, async (t) => {
	const { webOrigin, secret, seen } = await fixture(t);
	assert.equal((await fetch(webOrigin)).status, 403);
	assert.equal((await fetch(webOrigin, { headers: { "x-cohub-desktop-secret": secret, origin: "https://other.invalid" } })).status, 403);
	const foreignHostStatus = await new Promise((resolve, reject) => {
		const req = httpRequest(webOrigin, { headers: { "x-cohub-desktop-secret": secret, host: "other.invalid" } }, (res) => {
			res.resume(); resolve(res.statusCode);
		});
		req.on("error", reject); req.end();
	});
	assert.equal(foreignHostStatus, 403);
	const headers = { "x-cohub-desktop-secret": secret, authorization: "Bearer test-account" };
	assert.equal(await (await fetch(webOrigin, { headers })).text(), "rendered app");
	const result = await fetch(`${webOrigin}/api/spaces`, { method: "POST", body: "real-write-body", headers });
	assert.equal(result.status, 201);
	assert.deepEqual(await result.json(), { id: "stored-once", body: "real-write-body" });
	assert.deepEqual(seen, [{ url: "/api/spaces", method: "POST", body: "real-write-body", authorization: "Bearer test-account" }]);
	assert.equal(result.headers.get("cache-control"), "no-store");
});

test("a failed local API is an explicit failure, not a cached or empty success", async (t) => {
	const { webOrigin, secret, api, errors } = await fixture(t);
	await new Promise((resolve) => api.close(resolve));
	const response = await fetch(`${webOrigin}/api/spaces`, { headers: { "x-cohub-desktop-secret": secret } });
	assert.equal(response.status, 502);
	assert.equal((await response.json()).code, "local_api_unavailable");
	assert.equal(errors.length, 1);
});

test("local realtime requires the client secret and forwards the actual upgraded stream", { timeout: 10000 }, async (t) => {
	const { webOrigin, secret } = await fixture(t);
	const url = new URL(webOrigin);
	const socket = connect(Number(url.port), url.hostname);
	t.after(() => socket.destroy());
	await once(socket, "connect");
	socket.write(`GET /ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${webOrigin}\r\nX-Cohub-Desktop-Secret: ${secret}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
	async function until(stream, text) {
		let received = "";
		while (!received.includes(text)) {
			const [chunk] = await once(stream, "data");
			received += chunk.toString();
		}
		return received;
	}
	const upgrade = await until(socket, "\r\n\r\n");
	assert.match(upgrade, /101 Switching Protocols/);
	socket.write("realtime-payload");
	const echo = await until(socket, "realtime-payload");
	assert.equal(echo, "realtime-payload");
	socket.destroy();
	const denied = connect(Number(url.port), url.hostname);
	t.after(() => denied.destroy());
	await once(denied, "connect");
	denied.write(`GET /ws HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
	const [failure] = await once(denied, "data");
	assert.match(failure.toString(), /403 Forbidden/);
	denied.destroy();
});
