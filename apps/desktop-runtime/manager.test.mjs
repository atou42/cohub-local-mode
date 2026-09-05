import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

test("an unrelated healthy API is rejected without touching its process or data", async (t) => {
	const data = await mkdtemp(join(tmpdir(), "cohub-dev2-foreign-"));
	const marker = join(data, "runtime-state.json");
	await writeFile(marker, "existing-state-must-not-be-replaced\n");
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end('{"status":"ok"}');
	});
	// A private, non-production port chosen by the OS within the supported offset range.
	let port = 14787;
	for (; port < 18787; port++) {
		try {
			server.listen(port, "127.0.0.1");
			await once(server, "listening");
			break;
		} catch (error) {
			if (error.code !== "EADDRINUSE") throw error;
		}
	}
	assert.ok(server.listening);
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const child = spawn(process.execPath, [new URL("./manager.mjs", import.meta.url).pathname], {
		env: {
			...process.env,
			HOME: data,
			COHUB_LOCAL_DATA_DIR: data,
			COHUB_PERSONAL_NODE_TEST_PORT_OFFSET: String(port - 8787),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (stdout.includes("ready external")) child.kill("SIGTERM");
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
	const [code] = await once(child, "exit");
	clearTimeout(timeout);
	assert.doesNotMatch(stdout, /ready external/, "a health response does not establish ownership");
	assert.equal(code, 1, stderr);
	assert.match(stderr, /port .*occupied/i);
	assert.equal(await readFile(marker, "utf8"), "existing-state-must-not-be-replaced\n");
	assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});
