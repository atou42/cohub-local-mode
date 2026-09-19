import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { currentIdentityKey } from "../src/space.js";
import { parseRunCliOptions } from "../src/commands/run.js";

const roots: string[] = [];

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("cohub run uses the current directory Runtime binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-run-binding-"));
  roots.push(root);
  const path = join(root, "runtime-spaces.json");
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  const previousSpace = process.env.COHUB_SPACE_ID;
  process.env.COHUB_EXECUTION_TOKEN = jwt({ actorUserId: "user-alice" });
  delete process.env.COHUB_SPACE_ID;
  try {
    await writeFile(path, `${JSON.stringify({
      version: 1,
      bindings: [{ root, key: currentIdentityKey(), spaceId: "space-runtime" }],
    })}\n`);
    const options = await parseRunCliOptions(["run", "--", "git", "status"], { cwd: root, bindingsPath: path });
    assert.equal(options.spaceId, "space-runtime");
    assert.equal(options.command, "git status");
  } finally {
    if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previousToken;
    if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previousSpace;
  }
});
