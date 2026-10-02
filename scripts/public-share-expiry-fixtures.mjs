// Fixture-only writes for an isolated regression database.
// Callers create a fresh empty conversation via the authenticated API first.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function shareFixtures(dataRoot) {
  const databasePath = path.join(dataRoot, 'codex-web.sqlite');
  assert.ok(fs.existsSync(databasePath), 'The isolated application database must already exist');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const files = new Map();
  const directories = [];
  const owner = fs.statSync(dataRoot);
  return {
    seed(conversationId, userId, format, label) {
      assert.match(label, /^share-expiry-acceptance-/);
      const c = db.prepare('SELECT user_id,title FROM conversations WHERE id=?').get(conversationId);
      assert.equal(c?.user_id, userId); assert.match(c.title, /^share-expiry-acceptance-/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE conversation_id=?').get(conversationId).n, 0);
      const messageId = crypto.randomUUID(), now = new Date().toISOString();
      db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'assistant',?,?)")
        .run(messageId, conversationId, 'Public share acceptance fixture.', now);
      function file(name, mime, body) {
        const id = crypto.randomUUID();
        const relative = `deliverables/${id}/${name}`;
        const absolute = path.join(dataRoot, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, body);
        if (process.getuid?.() === 0) { fs.chownSync(path.dirname(absolute), owner.uid, owner.gid); fs.chownSync(absolute, owner.uid, owner.gid); }
        directories.push(path.dirname(absolute));
        db.prepare('INSERT INTO files(id,conversation_id,message_id,original_name,relative_path,mime_type,size,kind,created_at) VALUES(?,?,?,?,?,?,?,\'output\',?)')
          .run(id, conversationId, messageId, name, relative, mime, Buffer.byteLength(body), now);
        files.set(id, { conversationId, userId });
        return id;
      }
      const image = file('chart.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'));
      const html = '<!doctype html><meta charset="utf-8"><h1>分享期限验收</h1><p>仅用于期限功能验收。</p><img src="chart.png" alt="期限配图">';
      const markdown = '# 分享期限验收\n\n仅用于期限功能验收。\n\n![期限配图](chart.png)';
      const name = `${label}.${format === 'html' ? 'html' : 'md'}`;
      const id = file(name, format === 'html' ? 'text/html' : 'text/markdown', format === 'html' ? html : markdown);
      return { id, image, name };
    },
    setExpiry(id, expiry) {
      const f = files.get(id); assert.ok(f, 'Only a file created by this fixture may be modified');
      assert.ok(Number.isFinite(Date.parse(expiry)));
      const changed = db.prepare('UPDATE public_file_shares SET expires_at=? WHERE file_id=? AND user_id=?').run(expiry, id, f.userId);
      assert.equal(Number(changed.changes), 1);
    },
    close() {
      // Public audit rows deliberately outlive normal file deletion; remove only
      // this fixture's rows. Never sweep any pre-existing share or conversation.
      for (const [id, f] of files) db.prepare('DELETE FROM public_file_shares WHERE file_id=? AND user_id=?').run(id, f.userId);
      db.close();
      for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
