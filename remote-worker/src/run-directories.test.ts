import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupCurrentRunDirectory, sweepRunDirectories } from "./run-directories.js";

test("run cleanup only removes the validated current UUID directory", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-run-cleanup-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobId = crypto.randomUUID();
  const run = path.join(root, "runs", jobId);
  fs.mkdirSync(path.join(run, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(run, "uploads", "private.bin"), "private");
  await cleanupCurrentRunDirectory(root, jobId);
  assert.equal(fs.existsSync(run), false);
  await assert.rejects(() => cleanupCurrentRunDirectory(root, "../outside"), /non-UUID/);
});

test("startup sweep preserves active, recent and non-UUID directories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-run-sweep-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = crypto.randomUUID();
  const active = crypto.randomUUID();
  const recent = crypto.randomUUID();
  const runsRoot = path.join(root, "runs");
  for (const name of [old, active, recent, "manual-notes"]) fs.mkdirSync(path.join(runsRoot, name), { recursive: true });
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(path.join(runsRoot, old), oldTime, oldTime);
  fs.utimesSync(path.join(runsRoot, active), oldTime, oldTime);
  const result = await sweepRunDirectories(root, new Set([active]));
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, [old]);
  assert.equal(fs.existsSync(path.join(runsRoot, old)), false);
  assert.equal(fs.existsSync(path.join(runsRoot, active)), true);
  assert.equal(fs.existsSync(path.join(runsRoot, recent)), true);
  assert.equal(fs.existsSync(path.join(runsRoot, "manual-notes")), true);
});
