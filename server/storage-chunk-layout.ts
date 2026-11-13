import crypto from 'node:crypto';
import type fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { STORAGE_GIB } from './storage-lifecycle-policy.js';
export const LEGACY_CHUNK_BYTES = 256 * 1024 ** 2;
export const MAX_CHUNK_BYTES = 1.5 * STORAGE_GIB;
// Gzip framing/deflate expansion and age authentication overhead are ciphertext,
// not a larger plaintext chunk. Keep a bounded 16 MiB transport allowance.
export const MAX_CHUNK_CIPHERTEXT_BYTES = MAX_CHUNK_BYTES + 16 * 1024 ** 2;

/** Additive metadata only. Existing versions, manifests and upload intents are untouched. */
export function migrateStorageChunkLayouts(db: DatabaseSync, now = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS storage_file_chunk_layouts (
    user_id TEXT NOT NULL, source_key TEXT NOT NULL, chunk_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(user_id, source_key));`);
  db.prepare(`INSERT OR IGNORE INTO storage_scan_state(name,value_json,updated_at)
    VALUES('file-chunk-policy-v2','{"defaultBytes":1073741824}',?)`).run(now);
}

/** A source keeps its original split across retries and future policy changes.
 * Unenrolled pre-upgrade files are recognized by inode birth time; an existing
 * catalog item also preserves its old policy after a restore changes that time. */
export function fileChunkBytes(db: DatabaseSync, userId: string, source: string, stat: fs.Stats,
  requested: number, firstSeenAt?: number): number {
  const key = crypto.createHash('sha256').update(source).digest('hex');
  const previous = db.prepare('SELECT chunk_bytes FROM storage_file_chunk_layouts WHERE user_id=? AND source_key=?').get(userId,key);
  if (previous) return Number(previous.chunk_bytes);
  const epoch = Number(db.prepare("SELECT updated_at FROM storage_scan_state WHERE name='file-chunk-policy-v2'").get()?.updated_at);
  const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  const legacy = created < epoch || (firstSeenAt !== undefined && firstSeenAt < epoch);
  const bytes = legacy ? Math.min(requested, LEGACY_CHUNK_BYTES) : requested;
  db.prepare('INSERT OR IGNORE INTO storage_file_chunk_layouts VALUES(?,?,?,?)').run(userId,key,bytes,Date.now());
  return Number(db.prepare('SELECT chunk_bytes FROM storage_file_chunk_layouts WHERE user_id=? AND source_key=?').get(userId,key)!.chunk_bytes);
}
