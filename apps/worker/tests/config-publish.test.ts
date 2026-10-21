import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishConfigFromWorkspace } from "../src/config-publish.js";

test("sandbox setup projection exposes only the script and removes stale scripts without replacing its mount root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-setup-publish-"));
  try {
    const workspaceDir = join(root, "workspace");
    const targetDir = join(root, "published");
    await mkdir(join(workspaceDir, ".cohub"), { recursive: true });
    await writeFile(join(workspaceDir, ".cohub/setup.sh"), "echo ready\n");
    await writeFile(join(workspaceDir, ".cohub/models.json"), '{"apiKey":"private-key"}');
    const publish = () => publishConfigFromWorkspace({ workspaceDir, targetDir, checkpointId: "checkpoint", sourceLabel: "space", whitelist: [".cohub"] });
    await publish();
    const mounted = join(targetDir, ".sandbox-setup");
    const inode = (await stat(mounted)).ino;
    assert.deepEqual(await readdir(mounted), ["setup.sh"]);
    assert.equal(await readFile(join(mounted, "setup.sh"), "utf8"), "echo ready\n");
    assert.equal(await readFile(join(targetDir, ".cohub/models.json"), "utf8"), '{"apiKey":"private-key"}');
    await rm(join(workspaceDir, ".cohub/setup.sh"));
    await publish();
    assert.deepEqual(await readdir(mounted), []);
    assert.equal((await stat(mounted)).ino, inode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
