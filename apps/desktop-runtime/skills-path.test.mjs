import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { resolveSkillsPath } from "./skills-path.mjs";

test("fallback agents root does not make the Space workspace read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-skills-fallback-"));
	const skills = await resolveSkillsPath(root, join(root, "home"));
	const workspace = join(root, "spaces", "test-space", "workspace");
	assert.ok(relative(dirname(skills), workspace).startsWith(".."));
});

test("legacy fallback skills are retained when moved out of the data root", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-skills-legacy-"));
	await mkdir(join(root, "skills", "example"), { recursive: true });
	await writeFile(join(root, "skills", "example", "SKILL.md"), "existing skill\n");
	const skills = await resolveSkillsPath(root, join(root, "home"));
	assert.notEqual(dirname(skills), root);
	assert.equal(await readFile(join(skills, "example", "SKILL.md"), "utf8"), "existing skill\n");
	assert.equal(await resolveSkillsPath(root, join(root, "home")), skills);
});

test("ambiguous legacy and new skills are preserved and rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-skills-conflict-"));
	await mkdir(join(root, "skills"), { recursive: true });
	const target = join(root, "configs", "platform", ".agents", "skills");
	await mkdir(target, { recursive: true });
	await writeFile(join(root, "skills", "old"), "old");
	await writeFile(join(target, "new"), "new");
	await assert.rejects(resolveSkillsPath(root, join(root, "home")), /both legacy and current/i);
	assert.equal(await readFile(join(root, "skills", "old"), "utf8"), "old");
	assert.equal(await readFile(join(target, "new"), "utf8"), "new");
});
