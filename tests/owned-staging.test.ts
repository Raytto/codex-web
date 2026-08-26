import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupOwnedStagingDirectory, ownedStagingDirectory, sweepOwnedStagingDirectories } from "../server/owned-staging.js";

test("owned staging cleanup requires exact UUID ownership and protects active or recent runs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-owned-staging-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = crypto.randomUUID();
  const active = crypto.randomUUID();
  const recent = crypto.randomUUID();
  for (const id of [old, active, recent]) fs.mkdirSync(ownedStagingDirectory(root, "remote-worker-staging", id), { recursive: true });
  fs.mkdirSync(path.join(root, "remote-worker-staging", "not-a-uuid"), { recursive: true });
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1_000);
  fs.utimesSync(ownedStagingDirectory(root, "remote-worker-staging", old), oldTime, oldTime);
  fs.utimesSync(ownedStagingDirectory(root, "remote-worker-staging", active), oldTime, oldTime);
  assert.deepEqual(sweepOwnedStagingDirectories(root, "remote-worker-staging", (id) => id === active), [old]);
  assert.equal(fs.existsSync(ownedStagingDirectory(root, "remote-worker-staging", active)), true);
  assert.equal(fs.existsSync(ownedStagingDirectory(root, "remote-worker-staging", recent)), true);
  assert.throws(() => cleanupOwnedStagingDirectory(root, "remote-worker-staging", "../escape"), /Invalid staging owner/);
});
