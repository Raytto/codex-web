import { migrateStorageChunkLayouts } from './storage-chunk-layout.js';
import type { DatabaseSync } from "node:sqlite";

/** Additive schema: legacy archives remain valid until individually imported. */
export function migrateStorageLifecycle(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE storage_items (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, source_key TEXT NOT NULL,
      kind TEXT NOT NULL, locator_json TEXT NOT NULL, display_name TEXT NOT NULL,
      last_used_at INTEGER NOT NULL, time_basis TEXT NOT NULL, enrolled_at INTEGER NOT NULL,
      retention_days INTEGER NOT NULL CHECK(retention_days IN (15,30,60)),
      current_version TEXT, revision INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
      usage_not_before INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id,scope,source_key)
    );
    CREATE INDEX storage_items_due ON storage_items(next_attempt_at,last_used_at);
    CREATE UNIQUE INDEX storage_items_locator ON storage_items(user_id,locator_json);
    CREATE TABLE storage_item_links (
      user_id TEXT NOT NULL, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES storage_items(id),
      PRIMARY KEY(user_id,kind,subject_id,item_id)
    );
    CREATE INDEX storage_links_item ON storage_item_links(item_id);
    CREATE TABLE storage_scan_state (name TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE storage_restores (
      user_id TEXT NOT NULL,kind TEXT NOT NULL,subject_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
      state TEXT NOT NULL,stage TEXT NOT NULL,completed_bytes INTEGER NOT NULL DEFAULT 0,total_bytes INTEGER,
      estimated INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT,
      PRIMARY KEY(user_id,kind,subject_id)
    );
    CREATE TABLE storage_issues (
      scope TEXT NOT NULL, source_key TEXT NOT NULL, user_id TEXT, reason TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, resolved_at INTEGER,
      PRIMARY KEY(scope,source_key)
    );
    CREATE TABLE storage_versions (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES storage_items(id), user_id TEXT NOT NULL,
      generation INTEGER NOT NULL, sha256 TEXT NOT NULL, logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=0),
      source_fingerprint TEXT NOT NULL, manifest_json TEXT, manifest_sha256 TEXT,
      state TEXT NOT NULL CHECK(state IN ('local','uploading','verified','isolating','cold','restoring','error')),
      created_at INTEGER NOT NULL, verified_at INTEGER, restored_at INTEGER,
      UNIQUE(item_id,generation), UNIQUE(item_id,sha256,source_fingerprint)
    );
    CREATE INDEX storage_versions_owner ON storage_versions(user_id,item_id);
    CREATE TRIGGER storage_version_content_immutable BEFORE UPDATE OF item_id,user_id,generation,sha256,logical_bytes,source_fingerprint ON storage_versions
      BEGIN SELECT RAISE(ABORT,'storage_version_content_immutable'); END;
    CREATE TABLE storage_chunks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plaintext_sha256 TEXT NOT NULL, plaintext_bytes INTEGER NOT NULL,
      ciphertext_sha256 TEXT NOT NULL, ciphertext_bytes INTEGER NOT NULL, remote_drive TEXT NOT NULL,
      remote_path TEXT NOT NULL, remote_file_id TEXT, codec TEXT NOT NULL, verified_at INTEGER NOT NULL,
      UNIQUE(user_id,plaintext_sha256,plaintext_bytes), UNIQUE(remote_drive,remote_path)
    );
    CREATE TRIGGER storage_chunk_immutable BEFORE UPDATE ON storage_chunks
      BEGIN SELECT RAISE(ABORT,'storage_chunk_immutable'); END;
    CREATE TABLE storage_chunk_uploads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plaintext_sha256 TEXT NOT NULL, plaintext_bytes INTEGER NOT NULL,
      ciphertext_sha256 TEXT NOT NULL, ciphertext_bytes INTEGER NOT NULL, remote_drive TEXT NOT NULL,
      remote_path TEXT NOT NULL, codec TEXT NOT NULL, stage_path TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_error TEXT,
      UNIQUE(user_id,plaintext_sha256,plaintext_bytes)
    );
    CREATE TABLE storage_gc_versions(version_id TEXT PRIMARY KEY,queued_at INTEGER NOT NULL);
    CREATE TABLE storage_gc_chunks(chunk_id TEXT PRIMARY KEY,queued_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
      remote_path TEXT NOT NULL,remote_file_id TEXT,ciphertext_bytes INTEGER NOT NULL,deleted_at INTEGER,last_error TEXT);
    CREATE TABLE storage_version_chunks (
      version_id TEXT NOT NULL REFERENCES storage_versions(id), ordinal INTEGER NOT NULL,
      chunk_id TEXT NOT NULL REFERENCES storage_chunks(id), PRIMARY KEY(version_id,ordinal)
    );
    CREATE INDEX storage_version_chunks_chunk ON storage_version_chunks(chunk_id);
    CREATE TABLE storage_references (
      user_id TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES storage_versions(id),
      kind TEXT NOT NULL, ref_id TEXT NOT NULL, expires_at INTEGER,
      PRIMARY KEY(user_id,version_id,kind,ref_id)
    );
    CREATE INDEX storage_references_version ON storage_references(version_id,expires_at);
    CREATE TABLE storage_replicas (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES storage_versions(id),
      path TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL CHECK(purpose IN ('isolation','cache')),
      created_at INTEGER NOT NULL, isolated_at INTEGER, verified_at INTEGER NOT NULL,
      allocated_bytes INTEGER NOT NULL, released_at INTEGER, released_bytes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'present' CHECK(state IN ('planned','present','releasing','released','blocked','unavailable')),
      blocked_reason TEXT
    );
    CREATE INDEX storage_replicas_due ON storage_replicas(state,isolated_at);
    CREATE TABLE storage_leases (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES storage_items(id),
      version_id TEXT, job_id TEXT, process_identity TEXT NOT NULL,
      purpose TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX storage_leases_item ON storage_leases(item_id,released_at,expires_at);
    CREATE TABLE storage_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT,
      version_id TEXT, action TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX storage_audit_time ON storage_audit(at,action);
    CREATE TABLE storage_measurements (
      at INTEGER NOT NULL, user_id TEXT NOT NULL, metrics_json TEXT NOT NULL,
      PRIMARY KEY(at,user_id)
    );
    CREATE TABLE storage_event_batches (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, event_count INTEGER NOT NULL,
      sha256 TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES storage_items(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deleted_at INTEGER,
      blocked_reason TEXT, UNIQUE(job_id,first_seq,last_seq)
    );
    CREATE TABLE storage_backup_points (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, verified_at INTEGER,
      restore_tested_at INTEGER, kind TEXT NOT NULL, state TEXT NOT NULL,
      remote_path TEXT, blocked_reason TEXT, retired_at INTEGER
    );
    CREATE TABLE storage_backup_materials (
      point_id TEXT NOT NULL REFERENCES storage_backup_points(id),target_key TEXT NOT NULL,
      user_id TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES storage_versions(id),format TEXT NOT NULL,
      PRIMARY KEY(point_id,target_key)
    );
    CREATE TABLE storage_backup_legacy_refs (
      point_id TEXT NOT NULL REFERENCES storage_backup_points(id),remote_drive TEXT NOT NULL,
      remote_path TEXT NOT NULL,archive_sha256 TEXT NOT NULL,archive_bytes INTEGER NOT NULL,
      PRIMARY KEY(point_id,remote_drive,remote_path)
    );
    CREATE TABLE storage_legacy_generations (
      kind TEXT NOT NULL, subject_id TEXT NOT NULL, generation INTEGER NOT NULL,
      user_id TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
      remote_drive TEXT NOT NULL, remote_path TEXT NOT NULL, archive_sha256 TEXT NOT NULL,
      archive_bytes INTEGER NOT NULL, verified_at INTEGER NOT NULL,
      isolated_path TEXT, isolated_at INTEGER, purge_started_at INTEGER, released_at INTEGER,
      blocked_reason TEXT, PRIMARY KEY(kind,subject_id,generation)
    );
    CREATE TABLE storage_legacy_imports (
      kind TEXT NOT NULL, subject_id TEXT NOT NULL, generation INTEGER NOT NULL, user_id TEXT NOT NULL,
      archive_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, started_at INTEGER NOT NULL,
      verified_at INTEGER, blocked_reason TEXT, PRIMARY KEY(kind,subject_id,generation)
    );
    CREATE TABLE storage_legacy_members (
      kind TEXT NOT NULL, subject_id TEXT NOT NULL, generation INTEGER NOT NULL,
      member TEXT NOT NULL, user_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES storage_items(id),
      version_id TEXT NOT NULL REFERENCES storage_versions(id), prior_current_version TEXT,
      PRIMARY KEY(kind,subject_id,generation,member)
    );
    CREATE TABLE storage_native_units (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,retention_days INTEGER NOT NULL,
      manifest_json TEXT,manifest_sha256 TEXT,verified_at INTEGER,isolated_at INTEGER,
      removed_at INTEGER,restored_at INTEGER,state TEXT NOT NULL,blocked_reason TEXT
    );
    CREATE INDEX storage_native_units_conversation ON storage_native_units(conversation_id,created_at);
  `);
  migrateStorageChunkLayouts(db);
}
