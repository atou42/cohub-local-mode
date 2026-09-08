import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const data = process.env.COHUB_LOCAL_DATA_DIR;
console.log(`[smoke] runtime bootstrap ready at ${new Date().toISOString()}`);
process.once("disconnect", () => process.exit(0));
const attemptPath = join(data, "smoke-attempt.json");
let previous = 0;
try { previous = JSON.parse(await readFile(attemptPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const attempt = previous + 1;
await writeFile(attemptPath, JSON.stringify(attempt));
if (attempt === 1) {
  console.error("[runtime] Intentional first-start failure for lifecycle smoke");
  setTimeout(() => process.exit(7), 4_000);
} else {
  const offset = Number(process.env.COHUB_PERSONAL_NODE_TEST_PORT_OFFSET);
  const secret = process.env.COHUB_DESKTOP_INSTANCE_SECRET;
  const instanceId = process.env.COHUB_DESKTOP_INSTANCE_ID;
  const api = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const proof = createHmac("sha256", secret).update(`cohub-desktop-v1:${instanceId}:${url.searchParams.get("challenge")}`).digest("base64url");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ schemaVersion: 1, instanceId, proof }));
  });
  const web = createServer((request, response) => {
    if (request.headers["x-cohub-desktop-secret"] !== secret) {
      response.writeHead(401); response.end("Invalid instance secret"); return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html><body><h1>Lifecycle fixture ${attempt}</h1></body></html>`);
  });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await Promise.all([
    new Promise((resolve) => api.listen(8787 + offset, "127.0.0.1", resolve)),
    new Promise((resolve) => web.listen(4173 + offset, "127.0.0.1", resolve)),
  ]);
  process.send({ type: "runtime-ready", instanceId });
  process.once("SIGTERM", () => {
    api.closeAllConnections(); web.closeAllConnections();
    api.close(); web.close();
    setTimeout(() => process.exit(0), 20);
  });
}
