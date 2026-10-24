import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createColdRestoreScheduler } from "../server/cold-restore-scheduler.js";

test("restore retries persistent waiting intent, deduplicates opens, and stops after success", async () => {
  let calls = 0, state = "restoring", settled = 0;
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const scheduler = createColdRestoreScheduler({
    restore: async () => { calls++; if (calls === 1) { await first; throw new Error("codex_runtime_active"); } state = "local"; },
    needsRetry: () => state === "restoring", settled: () => { settled++; }, failed: () => {}, retryMs: 20,
  });
  try {
    scheduler.schedule("a", "owner"); scheduler.schedule("a", "owner");
    await delay(5); assert.equal(calls, 1);
    release(); await delay(5);
    scheduler.schedule("a", "owner"); assert.equal(calls, 1, "open must not bypass retry backoff");
    await delay(80); assert.equal(calls, 2); assert.equal(settled, 2); assert.equal(state, "local");
  } finally { scheduler.stop(); }
});

test("real errors stop; shutdown cancels retries and avoids callbacks into a closed database", async () => {
  let calls = 0, callbacks = 0, state = "error";
  const scheduler = createColdRestoreScheduler({ restore: async () => { calls++; throw Error("failure"); },
    needsRetry: () => state === "restoring", settled: () => { callbacks++; }, failed: () => {}, retryMs: 10 });
  scheduler.schedule("a", "owner"); await delay(35); assert.equal(calls, 1);
  state = "restoring"; scheduler.schedule("a", "owner"); await delay(2);
  scheduler.stop(); const before = calls; await delay(35); assert.equal(calls, before);
  scheduler.schedule("a", "owner"); await delay(2); assert.equal(calls, before);
  let release!: () => void;
  const active = createColdRestoreScheduler({ restore: () => new Promise<void>(r => { release = r; }),
    needsRetry: () => { throw Error("database closed"); }, settled: () => { callbacks++; }, failed: () => {} });
  active.schedule("b", "owner"); await delay(1); active.stop();
  const settledBefore = callbacks; release(); await delay(5); assert.equal(callbacks, settledBefore);
});

test("startup can resume the same stored restoring intent with a fresh scheduler", async () => {
  let state = "restoring", calls = 0;
  const options = { restore: async () => { calls++; if (calls === 1) throw Error("busy"); state = "local"; },
    needsRetry: () => state === "restoring", settled: () => {}, failed: () => {}, retryMs: 1000 };
  const previous = createColdRestoreScheduler(options); previous.schedule("a", "owner"); await delay(5); previous.stop();
  assert.equal(state, "restoring");
  const restarted = createColdRestoreScheduler(options); restarted.schedule("a", "owner"); await delay(5); restarted.stop();
  assert.equal(calls, 2); assert.equal(state, "local");
});
