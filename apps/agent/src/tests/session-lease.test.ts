import assert from "node:assert/strict";
import test from "node:test";
import { monitorSessionLease } from "../session-lease.js";

test("hung renewals expire independently and never overlap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0, calls = 0;
  let finish!: (value: number) => void;
  const lease = monitorSessionLease({ ttlMs: 120, intervalMs: 30, acquiredAt: 0, now: () => now,
    renew: () => { calls++; return new Promise((resolve) => { finish = resolve; }); }, onError: () => {} });
  now = 30; t.mock.timers.tick(30);
  now = 60; t.mock.timers.tick(30);
  assert.equal(calls, 1);
  now = 90; t.mock.timers.tick(30);
  assert(lease.signal.aborted);
  finish(1); await Promise.resolve();
  assert(lease.signal.aborted);
  lease.stop();
});

test("transient errors retry, and stop ignores late responses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0, calls = 0;
  let finish!: (value: number) => void;
  const lease = monitorSessionLease({ ttlMs: 120, intervalMs: 30, acquiredAt: 0, now: () => now,
    renew: () => { if (++calls === 1) return Promise.reject(new Error("offline")); return new Promise((resolve) => { finish = resolve; }); }, onError: () => {} });
  now = 30; t.mock.timers.tick(30); await Promise.resolve(); await Promise.resolve();
  assert(!lease.signal.aborted);
  now = 60; t.mock.timers.tick(30);
  lease.stop(); finish(0); await Promise.resolve();
  now = 200; t.mock.timers.tick(140);
  assert(!lease.signal.aborted);
});

test("successful renewal extends the deadline but a later hung renewal still expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0, calls = 0;
  const lease = monitorSessionLease({ ttlMs: 120, intervalMs: 30, acquiredAt: 0, now: () => now,
    renew: () => ++calls === 1 ? Promise.resolve(1) : new Promise(() => {}), onError: () => {} });
  now = 30; t.mock.timers.tick(30); await Promise.resolve();
  now = 60; t.mock.timers.tick(30);
  now = 90; t.mock.timers.tick(30);
  assert(!lease.signal.aborted);
  now = 120; t.mock.timers.tick(30);
  assert(lease.signal.aborted); assert.equal(calls, 2);
  lease.stop();
});

test("a confirmed missing lease aborts immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  const lease = monitorSessionLease({ ttlMs: 120, intervalMs: 30, acquiredAt: 0, now: () => now, renew: async () => 0, onError: () => {} });
  now = 30; t.mock.timers.tick(30); await Promise.resolve();
  assert(lease.signal.aborted);
  lease.stop();
});

test("an already expired acquisition is rejected", () => {
  const lease = monitorSessionLease({ ttlMs: 120, intervalMs: 30, acquiredAt: 0, now: () => 121, renew: async () => 1, onError: () => {} });
  assert(lease.signal.aborted);
  lease.stop();
});
