import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { OutboundScheduler } from "./outbound-scheduler.js";

const gate = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("slow conversations preserve FIFO without blocking other peers or providers", async () => {
  const scheduler = new OutboundScheduler(20, 4, 1, 2);
  const slow = gate();
  const order: string[] = [];
  const add = (key: string, label: string, media = false, provider = "wechat") => scheduler.add({ key, provider, media, run: async () => { order.push(label); if (label === "slow") await slow.promise; } });
  add("bot:peer1", "slow", true);
  add("bot:peer1", "next");
  add("bot:peer2", "peer");
  add("other-bot:peer", "feishu", false, "feishu");
  await tick();
  assert.deepEqual(order, ["slow", "peer", "feishu"]);
  assert.equal(scheduler.pendingFor("bot:peer1"), 2);
  slow.resolve();
  await scheduler.drain();
  assert.deepEqual(order, ["slow", "peer", "feishu", "next"]);
  assert.equal(scheduler.size, 0);
});
