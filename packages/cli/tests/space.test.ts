import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { explicitSpace, identityKeyFrom, readDefaultSpaceCache } from "../src/space.js";
import { resolveRuntimeSpace } from "../src/runtime/space-binding.js";

const DAY_MS = 86_400_000;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function programWithSpace(space?: string): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-s, --space <id>");
  program.parse(space ? ["-s", space] : [], { from: "user" });
  return program;
}

async function cacheFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cohub-space-"));
  tempDirs.push(dir);
  const path = join(dir, "default-space.json");
  await writeFile(path, `${JSON.stringify(value)}\n`);
  return path;
}

test("explicit space prefers -s over COHUB_SPACE_ID", () => {
  const previous = process.env.COHUB_SPACE_ID;
  process.env.COHUB_SPACE_ID = "from-env";
  try {
    assert.equal(explicitSpace(programWithSpace("from-flag")), "from-flag");
    assert.equal(explicitSpace(programWithSpace()), "from-env");
  } finally {
    if (previous === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previous;
  }
});

test("explicit space is null when neither flag nor env is set", () => {
  const previous = process.env.COHUB_SPACE_ID;
  delete process.env.COHUB_SPACE_ID;
  try {
    assert.equal(explicitSpace(programWithSpace()), null);
  } finally {
    if (previous === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previous;
  }
});

test("identity key uses JWT sub and isolates accounts and environments", () => {
  const alice = jwt({ sub: "user-alice" });
  const bob = jwt({ sub: "user-bob" });

  assert.equal(identityKeyFrom({ env: "prod", idToken: alice }), "prod:user-alice");
  assert.notEqual(
    identityKeyFrom({ env: "prod", idToken: alice }),
    identityKeyFrom({ env: "dev", idToken: alice }),
  );
  assert.notEqual(
    identityKeyFrom({ env: "prod", idToken: alice }),
    identityKeyFrom({ env: "prod", idToken: bob }),
  );
  assert.equal(identityKeyFrom({ env: "prod", accessToken: jwt({ sub: "user-alice" }) }), "prod:user-alice");
  assert.equal(identityKeyFrom({ env: "prod", idToken: "not-a-jwt" }), null);
});

test("execution token does not fall back to a local Logto session", () => {
  const session = jwt({ sub: "user-alice" });
  const grant = jwt({ actorUserId: "user-bob", spaceId: "space-9", source: "prompt" });
  const grantWithoutActor = jwt({ spaceId: "space-9", source: "prompt" });

  assert.equal(identityKeyFrom({ env: "prod", executionToken: grant, idToken: session }), "prod:user-bob");
  assert.equal(identityKeyFrom({ env: "prod", executionToken: grantWithoutActor, idToken: session }), null);
  assert.equal(identityKeyFrom({ env: "prod", executionToken: jwt({ sub: "exec-1" }), idToken: session }), "prod:exec-1");
});

test("default space cache returns a matching unexpired entry", async () => {
  const path = await cacheFile({ key: "prod:user-alice", spaceId: "space-1", cachedAt: Date.now() });
  assert.equal(readDefaultSpaceCache(path, "prod:user-alice"), "space-1");
});

test("API endpoints isolate Home caches and directory bindings for the same actor", async () => {
  const identity = { env: "prod", idToken: jwt({ sub: "same-user" }) };
  const cloud = identityKeyFrom({ ...identity, apiBaseUrl: "https://api.cohub.live" })!;
  const local = identityKeyFrom({ ...identity, apiBaseUrl: "http://127.0.0.1:8787" })!;
  assert.notEqual(cloud, local);
  assert.equal(local, identityKeyFrom({ ...identity, apiBaseUrl: "http://127.0.0.1:8787/" }));
  const cache = await cacheFile({ key: cloud, spaceId: "cloud-home", cachedAt: Date.now() });
  assert.equal(readDefaultSpaceCache(cache, local), null);
  const legacy = await cacheFile({ key: identityKeyFrom(identity), spaceId: "old-home", cachedAt: Date.now() });
  assert.equal(readDefaultSpaceCache(legacy, local), null);
  const root = await mkdtemp(join(tmpdir(), "cohub-endpoint-bindings-"));
  tempDirs.push(root);
  const path = join(root, "bindings.json");
  await resolveRuntimeSpace({ root, path, identityKey: cloud, createSpace: async () => "cloud-space" });
  const result = await resolveRuntimeSpace({ root, path, identityKey: local, createSpace: async () => "local-space" });
  assert.equal(result.spaceId, "local-space");
  for (const [key, expected] of [[cloud, "cloud-space"], [local, "local-space"]]) {
    const bound = await resolveRuntimeSpace({ root, path, identityKey: key, createSpace: async () => { throw new Error("binding lost"); } });
    assert.equal(bound.spaceId, expected);
  }
});

test("default space cache isolates identities and drops expired or corrupt entries", async () => {
  const now = Date.now();
  const fresh = await cacheFile({ key: "prod:user-alice", spaceId: "space-1", cachedAt: now });
  assert.equal(readDefaultSpaceCache(fresh, "prod:user-bob"), null);

  const expired = await cacheFile({ key: "prod:user-alice", spaceId: "space-1", cachedAt: now - DAY_MS - 1 });
  assert.equal(readDefaultSpaceCache(expired, "prod:user-alice", now), null);

  const corrupt = await cacheFile("not-json");
  assert.equal(readDefaultSpaceCache(corrupt, "prod:user-alice"), null);

  const incomplete = await cacheFile({ key: "prod:user-alice", spaceId: 1, cachedAt: now });
  assert.equal(readDefaultSpaceCache(incomplete, "prod:user-alice"), null);
});
