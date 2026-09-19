import assert from "node:assert/strict";
import test from "node:test";
import { collectSpaceMentionOrigins } from "../runtime/space-mention-origins.js";

const SPACE_ID = "22222222-2222-4222-8222-222222222222";

test("collectSpaceMentionOrigins reads persisted cloud origins", () => {
  assert.deepEqual(collectSpaceMentionOrigins([{
    type: "text",
    text: "@cloud",
    _meta: { mentions: [{ type: "space", spaceId: SPACE_ID, origin: "cloud" }] },
  }]), { [SPACE_ID]: "cloud" });
});

test("collectSpaceMentionOrigins keeps legacy mentions unresolved", () => {
  assert.deepEqual(collectSpaceMentionOrigins([{
    type: "text",
    text: "@legacy",
    _meta: { mentions: [{ type: "space", spaceId: SPACE_ID }] },
  }]), {});
});

test("collectSpaceMentionOrigins rejects corrupt and conflicting origin metadata", () => {
  assert.throws(() => collectSpaceMentionOrigins([{
    type: "text",
    text: "@bad",
    _meta: { mentions: [{ type: "space", spaceId: SPACE_ID, origin: "remote-ish" }] },
  }]), /invalid origin/);

  assert.throws(() => collectSpaceMentionOrigins([
    { type: "text", text: "@local", _meta: { mentions: [{ type: "space", spaceId: SPACE_ID, origin: "local" }] } },
    { type: "text", text: "@cloud", _meta: { mentions: [{ type: "space", spaceId: SPACE_ID, origin: "cloud" }] } },
  ]), /conflicting origins/);
});
