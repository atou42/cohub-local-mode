import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

function loopbackOrigin(value, name) {
	const url = new URL(value);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error(`${name} must be a loopback HTTP origin`);
	}
	return url;
}

export function createDesktopWebServer({ handler, webOrigin, apiOrigin, gatewayOrigin, secret, onError = console.error }) {
	const web = loopbackOrigin(webOrigin, "webOrigin");
	const api = loopbackOrigin(apiOrigin, "apiOrigin");
	const gateway = loopbackOrigin(gatewayOrigin, "gatewayOrigin");
	if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Desktop secret is invalid");
	const expected = Buffer.from(secret);
	function allowed(req) {
		const value = req.headers["x-cohub-desktop-secret"];
		const received = Buffer.from(typeof value === "string" ? value : "");
		return req.headers.host === web.host &&
			(!req.headers.origin || req.headers.origin === web.origin) &&
			received.length === expected.length && timingSafeEqual(expected, received);
	}
	function upstreamRequest(req, target) {
		return httpRequest({
			hostname: target.hostname, port: target.port, path: req.url, method: req.method,
			headers: { ...req.headers, host: target.host },
		});
	}
	const server = createServer((req, res) => {
		if (!allowed(req)) {
			res.writeHead(403, { "cache-control": "no-store" });
			res.end("Open Cohub from the desktop client.");
			return;
		}
		if (req.url === "/healthz") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end('{"status":"ready","surface":"desktop"}');
			return;
		}
		if (req.url?.startsWith("/api/")) {
			const upstream = upstreamRequest(req, api);
			upstream.on("response", (response) => {
				res.writeHead(response.statusCode, { ...response.headers, "cache-control": "no-store" });
				response.pipe(res);
				response.on("error", (error) => { onError(error); res.destroy(error); });
			});
			upstream.on("error", (error) => {
				onError(error);
				if (!res.headersSent) {
					res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
					res.end('{"code":"local_api_unavailable","message":"Local services are unavailable"}');
				} else res.destroy(error);
			});
			req.on("aborted", () => upstream.destroy());
			req.pipe(upstream);
			return;
		}
		Promise.resolve(handler(req, res)).catch((error) => {
			onError(error);
			if (!res.headersSent) res.writeHead(500, { "cache-control": "no-store" });
			res.end("The local application could not render.");
		});
	});
	server.on("upgrade", (req, socket, head) => {
		if (!allowed(req) || !["/ws", "/asr/ws"].includes(new URL(req.url, web).pathname)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const upstream = upstreamRequest(req, gateway);
		upstream.on("upgrade", (response, peer, peerHead) => {
			socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
			for (let i = 0; i < response.rawHeaders.length; i += 2) {
				socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
			}
			socket.write("\r\n");
			if (peerHead.length) socket.write(peerHead);
			if (head.length) peer.write(head);
			socket.pipe(peer).pipe(socket);
			socket.on("error", () => peer.destroy());
			peer.on("error", () => socket.destroy());
			socket.on("close", () => peer.destroy());
		});
		upstream.on("response", (response) => {
			socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
			response.resume();
		});
		upstream.on("error", (error) => { onError(error); socket.destroy(); });
		upstream.end();
	});
	return server;
}
