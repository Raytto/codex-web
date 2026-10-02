import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { isPublicShareActive, publicShareRemaining, PUBLIC_SHARE_LIFETIME_MS } from "../src/public-share.js";

test("share expiry is exclusive at the deadline and invalid deadlines fail closed", () => {
  const deadline = "2026-11-01T08:00:00.000Z";
  const now = Date.parse(deadline);
  assert.equal(isPublicShareActive(1, deadline, now - 1), true);
  assert.equal(isPublicShareActive(1, deadline, now), false);
  assert.equal(isPublicShareActive(1, deadline, now + 1), false);
  assert.equal(isPublicShareActive(0, deadline, now - 1), false);
  assert.equal(isPublicShareActive(1, null, now), false);
  assert.equal(isPublicShareActive(1, "invalid", now), false);
  assert.equal(publicShareRemaining(new Date(now + PUBLIC_SHARE_LIFETIME_MS).toISOString(), now - 900), "剩余 30 天");
});

test("legacy shares receive one grace period; disabled shares and subsequent restarts stay unchanged", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-share-expiry-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let db = new AppDatabase(root, undefined, false);
  db.sqlite.exec("DROP INDEX public_file_shares_expiry_idx; ALTER TABLE public_file_shares DROP COLUMN expires_at; DELETE FROM schema_migrations WHERE version=2026093005");
  const insert = db.sqlite.prepare("INSERT INTO public_file_shares(id,file_id,user_id,file_name_snapshot,enabled,created_at,enabled_at) VALUES(?,?,?,?,?,?,?)");
  for (const enabled of [0, 1]) insert.run(`share-${enabled}`, `file-${enabled}`, LEGACY_USER_ID, "report.md", enabled, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  db.close();
  const before = Date.now();
  db = new AppDatabase(root, undefined, false);
  const deadline = db.getPublicFileShare("file-1")!.expires_at!;
  assert.ok(Date.parse(deadline) >= before + PUBLIC_SHARE_LIFETIME_MS);
  assert.ok(Date.parse(deadline) <= Date.now() + PUBLIC_SHARE_LIFETIME_MS);
  assert.equal(db.getPublicFileShare("file-0")!.expires_at, null);
  assert.equal(db.getPublicFileShare("file-0")!.enabled, 0);
  db.close();
  db = new AppDatabase(root, undefined, false);
  assert.equal(db.getPublicFileShare("file-1")!.expires_at, deadline);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
