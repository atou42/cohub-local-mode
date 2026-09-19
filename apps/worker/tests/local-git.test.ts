import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "cohub-local-git-"));
process.env.LOCAL_GIT_ROOT = root;

const { buildInternalRepoRemoteUrl, createInternalRepository } = await import(
	"../src/gitea.js"
);

test.after(async () => {
	await rm(root, { recursive: true, force: true });
});

test("local repository provider creates and reuses a validated bare repo", async () => {
	assert.deepEqual(await createInternalRepository("space-one"), {
		name: "space-one",
		alreadyExists: false,
	});
	assert.deepEqual(await createInternalRepository("space-one"), {
		name: "space-one",
		alreadyExists: true,
	});
	assert.match(buildInternalRepoRemoteUrl("space-one"), /^file:\/\//);
});

test("local repository provider exposes corrupt storage instead of rewriting it", async () => {
	await writeFile(join(root, "broken.git"), "not a repository");
	await assert.rejects(
		createInternalRepository("broken"),
		/Internal repository path is not a directory/,
	);
});
