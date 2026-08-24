#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assetsRoot = resolve(repoRoot, "apps/web/.svelte-kit/cloudflare/assets");
const listenPort = Number(process.env.COHUB_LOCAL_WEB_PORT ?? "4173");
const workerPort = Number(process.env.COHUB_LOCAL_WEB_WORKER_PORT ?? "4174");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

function resolveAssetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.slice(1);
  const filePath = resolve(assetsRoot, relativePath);
  if (filePath !== assetsRoot && !filePath.startsWith(`${assetsRoot}${sep}`)) {
    return undefined;
  }
  return filePath;
}

async function serveAsset(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const filePath = resolveAssetPath(pathname);
  if (!filePath) return false;
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
  if (!fileStat.isFile()) return false;
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    contentTypes.get(extname(filePath)) ?? "application/octet-stream",
  );
  response.setHeader("Content-Length", fileStat.size);
  response.setHeader("X-Robots-Tag", "noindex");
  response.setHeader(
    "Cache-Control",
    pathname.startsWith("/_app/immutable/")
      ? "public, immutable, max-age=31536000"
      : "public, max-age=0, must-revalidate",
  );
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolvePromise);
    response.once("close", resolvePromise);
    stream.pipe(response);
  });
  return true;
}

function proxyToWorker(request, response) {
  return new Promise((resolvePromise, reject) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: workerPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", resolvePromise);
        upstreamResponse.once("error", reject);
      },
    );
    upstream.once("error", reject);
    request.pipe(upstream);
  });
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (await serveAsset(request, response, pathname)) return;
    await proxyToWorker(request, response);
  } catch (error) {
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    response.end("Local Mode web runtime unavailable\n");
    console.error(error);
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(
    `Local Mode web proxy listening on http://127.0.0.1:${listenPort}`,
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
