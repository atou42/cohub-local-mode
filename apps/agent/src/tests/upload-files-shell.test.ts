import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../jobs/sandbox-bash/upload-files.sh", import.meta.url);
const payload = Buffer.from([0, 1, 255, 128, 13, 10]);

for (const mode of ["stage", "replace"] as const) {
  test(`upload helper completes ${mode} mode with the system Bash`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cohub-upload-shell-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const server = createServer((_request, response) => response.end(payload));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const child = spawn("/bin/bash", [script.pathname], {
      env: { ...process.env, UPLOAD_ROOT: root, MATERIALIZE_MODE: mode },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const url = `http://127.0.0.1:${address.port}/binary`;
    child.stdin.end(`${Buffer.from("space name.bin").toString("base64")}\t${payload.length}\t${Buffer.from(url).toString("base64")}\n`);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    const fields = stdout.trim().split("\t");
    const path = mode === "stage" ? fields[3] : fields[2];
    assert.ok(path);
    assert.deepEqual(await readFile(path), payload);
    assert.equal((await readdir(root)).length, 1);
  });
}

test("upload helper cleans staged downloads on a later size mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cohub-upload-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_request, response) => response.end(payload));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const child = spawn("/bin/bash", [script.pathname], {
    env: { ...process.env, UPLOAD_ROOT: root, MATERIALIZE_MODE: "stage" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const url = Buffer.from(`http://127.0.0.1:${address.port}/binary`).toString("base64");
  child.stdin.end([payload.length, payload.length + 1].map((size, index) => `${Buffer.from(`${index}.bin`).toString("base64")}\t${size}\t${url}\n`).join(""));
  const [code] = await once(child, "exit");
  assert.equal(code, 3, stderr);
  assert.match(stderr, /size mismatch/);
  assert.deepEqual(await readdir(root), []);
});
