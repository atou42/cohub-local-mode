import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const bytes = "cached native binary fixture";
const manifest = {
	valkeyVersion: "9.1.2",
	macosDeploymentTarget: "13.0",
	sourceSha256: "8e8557da7426a51b4e0fb514a65ef6241dc7c85cb408243af389070abf379cec",
	binarySha256: createHash("sha256").update(bytes).digest("hex"),
};

async function fixture(t, value, binary = bytes) {
	const root = await mkdtemp(join(tmpdir(), "cohub-native-cache-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const script = join(root, "scripts", "prepare-native-runtime.mjs");
	const output = join(root, "resources", "native-build");
	await mkdir(join(root, "scripts"), { recursive: true });
	await mkdir(output, { recursive: true });
	await copyFile(new URL("./prepare-native-runtime.mjs", import.meta.url), script);
	await writeFile(join(output, "manifest.json"), value);
	await writeFile(join(output, "valkey-server"), binary);
	const run = () => exec(process.execPath, ["--input-type=module", "-e", `globalThis.fetch = () => { throw new Error("Unexpected network request"); }; await import(${JSON.stringify(pathToFileURL(script).href)});`]);
	return { run, output };
}

test("reuses a native binary only when its manifest and digest agree", async (t) => {
	const { run } = await fixture(t, JSON.stringify(manifest));
	await run();
});

for (const target of [undefined, "26.0"]) {
	test(`rebuilds a native cache for an incompatible deployment target (${target ?? "legacy"})`, async (t) => {
		const previous = JSON.stringify({ ...manifest, macosDeploymentTarget: target });
		const { run, output } = await fixture(t, previous);
		await assert.rejects(run(), (failure) => {
			assert.match(failure.stderr, /Unexpected network request/);
			return true;
		});
		assert.equal(await readFile(join(output, "manifest.json"), "utf8"), previous);
		assert.equal(await readFile(join(output, "valkey-server"), "utf8"), bytes);
	});
}

for (const [name, value, binary, error] of [
	["malformed JSON", "{corrupt", bytes, /SyntaxError/],
	["missing fields", "{}", bytes, /manifest is invalid/],
	["invalid deployment target", JSON.stringify({ ...manifest, macosDeploymentTarget: "latest" }), bytes, /manifest is invalid/],
	["changed binary", JSON.stringify(manifest), "damaged", /checksum mismatch/],
]) {
	test(`preserves and rejects ${name} without downloading a replacement`, async (t) => {
		const { run, output } = await fixture(t, value, binary);
		await assert.rejects(run(), (failure) => {
			assert.match(failure.stderr, error);
			assert.doesNotMatch(failure.stderr, /Unexpected network request/);
			return true;
		});
		assert.equal(await readFile(join(output, "manifest.json"), "utf8"), value);
		assert.equal(await readFile(join(output, "valkey-server"), "utf8"), binary);
	});
}
