#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";

const listenPort = Number(process.env.COHUB_LOCAL_PRIVATE_INGRESS_PORT ?? "4180");

function targetPort(pathname) {
  if (pathname === "/api" || pathname.startsWith("/api/")) return 8787;
  if (
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    pathname === "/asr/ws" ||
    pathname.startsWith("/asr/ws/") ||
    pathname === "/sandbox/relay" ||
    pathname.startsWith("/sandbox/relay/")
  ) {
    return 8788;
  }
  if (
    pathname === "/cohub-assets" ||
    pathname.startsWith("/cohub-assets/") ||
    pathname === "/cohub-sessions" ||
    pathname.startsWith("/cohub-sessions/")
  ) {
    return Number(process.env.LOCAL_MINIO_PORT ?? "9000");
  }
  return 4173;
}

function proxyOptions(request) {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  return {
    host: "127.0.0.1",
    port: targetPort(pathname),
    method: request.method,
    path: request.url,
    headers: request.headers,
  };
}

const server = createServer((request, response) => {
  const upstream = httpRequest(proxyOptions(request), (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    response.end("Local Mode private ingress unavailable\n");
    console.error(error);
  });
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  const upstreamRequest = httpRequest(proxyOptions(request));
  upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(upstreamResponse.headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) return value.map((item) => `${name}: ${item}`);
        return value === undefined ? [] : [`${name}: ${value}`];
      })
      .join("\r\n");
    socket.write(
      `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${headers}\r\n\r\n`,
    );
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamRequest.once("response", (upstreamResponse) => {
    socket.write(
      `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
  });
  upstreamRequest.once("error", (error) => {
    console.error(error);
    socket.destroy();
  });
  upstreamRequest.end();
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(
    `Local Mode private ingress listening on http://127.0.0.1:${listenPort}`,
  );
});

function shutdown() {
  server.close((error) => {
    if (error) throw error;
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
