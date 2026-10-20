import assert from "node:assert/strict";
import test from "node:test";
import { AppRoomRtc } from "../src/apis/app-room-rtc.js";
import type { HttpTransport } from "../src/transport.js";

test("a throwing PeerConnection factory releases the hosted session", async () => {
  const methods: string[] = [];
  const rtc = new AppRoomRtc({
    roomId: "room", appId: "app", ticket: "ticket", hosted: true,
    participantId: () => "participant", members: () => [], onMembersChanged: () => () => {},
    createPeerConnection() { throw new Error("Adapter failed"); },
    transport: { async request(_path: string, options: { method: string }) {
      methods.push(options.method);
      return options.method === "POST" ? { sessionId: "session", iceServers: [] } : {};
    } } as unknown as HttpTransport,
  });
  await assert.rejects(rtc.start(), /Adapter failed/);
  await rtc.shutdown();
  assert.deepEqual(methods, ["POST", "DELETE"]);
  assert.equal(rtc.state, "closed");
});

test("shutdown waits for current release even after a previous release failed", async () => {
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  const rtc = new AppRoomRtc({
    roomId: "room", appId: "app", ticket: "ticket", hosted: true,
    participantId: () => "participant", members: () => [], onMembersChanged: () => () => {},
    transport: { async request(path: string) {
      if (path.endsWith("/old")) throw new Error("Previous release failed");
      return current;
    } } as unknown as HttpTransport,
  });
  const internals = rtc as unknown as { sessionId: string; teardown(release: boolean): void };
  internals.sessionId = "old";
  internals.teardown(true);
  await new Promise<void>((done) => setImmediate(done));
  internals.sessionId = "current";
  let finished = false;
  const closing = rtc.shutdown().finally(() => { finished = true; });
  const rejected = assert.rejects(closing, /Previous release failed/);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(finished, false);
  release();
  await rejected;
  assert.equal(finished, true);
});
