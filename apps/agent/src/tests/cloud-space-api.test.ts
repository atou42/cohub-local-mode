import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "@neta-art/cohub";
import { createCloudSpaceFileVisibilityResolver } from "../runtime/cloud-space-access.js";

const ACTOR = "dec89612d5074605aeeb101a2918379a";
const SPACE = "22222222-2222-4222-8222-222222222222";

test("cloud access resolver accepts full and filtered file permissions", async () => {
  const full = createCloudSpaceFileVisibilityResolver({
    getMe: async () => ({ uuid: ACTOR }),
    getSpace: async () => ({ access: { permissions: ["file.view"] } }),
  });
  const filtered = createCloudSpaceFileVisibilityResolver({
    getMe: async () => ({ uuid: ACTOR }),
    getSpace: async () => ({ access: { permissions: ["file.view.filtered"] } }),
  });
  assert.equal(await full({ actorUserId: ACTOR, spaceId: SPACE }), "full");
  assert.equal(await filtered({ actorUserId: ACTOR, spaceId: SPACE }), "filtered");
});

test("cloud access resolver exposes denial and missing targets", async () => {
  const denied = createCloudSpaceFileVisibilityResolver({
    getMe: async () => ({ uuid: ACTOR }),
    getSpace: async () => ({ access: { permissions: [] } }),
  });
  await assert.rejects(denied({ actorUserId: ACTOR, spaceId: SPACE }), /file access denied/);

  const missing = createCloudSpaceFileVisibilityResolver({
    getMe: async () => ({ uuid: ACTOR }),
    getSpace: async () => { throw new HttpError("missing", 404, null); },
  });
  await assert.rejects(missing({ actorUserId: ACTOR, spaceId: SPACE }), /Cloud Space not found/);
});

test("cloud access resolver does not disguise network or account mismatches", async () => {
  const offline = createCloudSpaceFileVisibilityResolver({
    getMe: async () => { throw new Error("connect ECONNREFUSED"); },
    getSpace: async () => ({ access: { permissions: ["file.view"] } }),
  });
  await assert.rejects(offline({ actorUserId: ACTOR, spaceId: SPACE }), /account verification failed: connect ECONNREFUSED/);

  const mismatch = createCloudSpaceFileVisibilityResolver({
    getMe: async () => ({ uuid: "someone-else" }),
    getSpace: async () => ({ access: { permissions: ["file.view"] } }),
  });
  await assert.rejects(mismatch({ actorUserId: ACTOR, spaceId: SPACE }), /does not match the local session user/);
});
