import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coldArchiveLimit, retryColdOperation, runColdMaintenanceStages } from "../server/cold-storage-maintenance.js";
import { defaultColdStorageRoots, ensureRemotePath, uploadColdArchive } from "../server/conversation-cold-storage.js";

test("all candidates exceed the former 100 item cap while manual limits remain explicit", () => {
  const candidates = Array.from({ length: 424 }, (_, id) => id);
  assert.equal(candidates.slice(0, coldArchiveLimit(true)).length, 424);
  assert.equal(candidates.slice(0, coldArchiveLimit(false, "200")).length, 200);
  assert.equal(candidates.slice(0, coldArchiveLimit(false)).length, 1);
  for (const invalid of ["0", "-1", "NaN", "Infinity", "1.5", ""]) assert.throws(() => coldArchiveLimit(false, invalid));
  assert.throws(() => coldArchiveLimit(true, "1"));
});

test("failed voice and throwing reader phases do not block conversations or any purge", () => {
  const called: string[] = [];
  const failed = runColdMaintenanceStages((args) => {
    called.push(args[0]);
    if (args[0] === "reader-archive") throw new Error("failed to list");
    return args[0] !== "voice-archive" && args[0] !== "purge";
  });
  assert.deepEqual(called, ["voice-archive", "reader-archive", "archive", "purge", "voice-purge", "reader-purge"]);
  assert.deepEqual(failed, ["voice-archive", "reader-archive", "purge"]);
  assert.deepEqual(runColdMaintenanceStages(() => true), []);
});

test("transient retries are bounded and preserve terminal failures", () => {
  const waits: number[] = []; let attempts = 0;
  assert.equal(retryColdOperation(() => { if (++attempts < 3) throw new Error("transient"); return 42; }, ms => waits.push(ms)), 42);
  assert.deepEqual(waits, [1000, 2000]);
  attempts = 0; const failure = new Error("permanent");
  assert.throws(() => retryColdOperation(() => { attempts++; throw failure; }, () => {}), error => error === failure);
  assert.equal(attempts, 3);
});

for (const mode of ["panic-before-upload", "panic-after-upload", "listing-fails"]) {
  test(`cloud retry preserves exact object identity: ${mode}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-retry-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = path.join(root, "state.json");
    const program = path.join(root, "aliyunpan");
    fs.writeFileSync(program, `#!/usr/bin/env node
const fs = require('node:fs');
const state = ${JSON.stringify(state)}; const mode = ${JSON.stringify(mode)};
const s = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : {trees:0, uploads:0, exists:false};
const args = process.argv.slice(2); const cmd = args[0];
const save = () => fs.writeFileSync(state, JSON.stringify(s));
if (cmd === 'tree') {
  s.trees++; save();
  if (mode === 'listing-fails') { console.log('temporary API error'); process.exit(0); }
  if (s.trees === 1) { console.log('temporary API error'); process.exit(0); }
  console.log('/archive'); if (s.exists) console.log('/archive/hash.age -> /archive/hash.age'); process.exit(0);
}
if (cmd === 'upload') {
  s.uploads++;
  if (mode !== 'panic-before-upload' || s.uploads > 1) s.exists = true;
  save(); if (s.uploads === 1) { console.error('panic: runtime error: invalid memory address'); process.exit(2); }
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
    const roots = defaultColdStorageRoots({ aliyunpan: program });
    if (mode === "listing-fails") {
      assert.throws(() => uploadColdArchive(roots, path.join(root, "hash.age"), "/archive"), /云端目录读取失败/);
      assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).uploads, 0);
    } else {
      uploadColdArchive(roots, path.join(root, "hash.age"), "/archive");
      const final = JSON.parse(fs.readFileSync(state, "utf8"));
      assert.equal(final.exists, true);
      assert.equal(final.uploads, mode === "panic-before-upload" ? 2 : 1);
    }
  });
}

test("a transient missing directory listing is retried before unnecessary mkdir", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const counter = path.join(root, "counter"); const program = path.join(root, "aliyunpan");
  fs.writeFileSync(program, `#!/usr/bin/env node
const fs = require('node:fs'); const p = ${JSON.stringify(counter)};
const n = fs.existsSync(p) ? Number(fs.readFileSync(p)) : 0; fs.writeFileSync(p, String(n+1));
if (process.argv[2] !== 'tree') process.exit(9);
if (n > 0) console.log('/archive');
`, { mode: 0o700 });
  ensureRemotePath(defaultColdStorageRoots({ aliyunpan: program }), "/archive");
  assert.equal(Number(fs.readFileSync(counter)), 2);
});
