import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase } from "../server/db.js";

test("new cross-layer schema changes are versioned and idempotent", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-schema-migrations-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new AppDatabase(root, undefined, false);
  const migrations = (first.sqlite.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string }>)
    .map((row) => ({ version: row.version, name: row.name }));
  assert.deepEqual(migrations, [
    { version: 2026080401, name: "wake-plan-prompt-revision" },
    { version: 2026080402, name: "job-finalization-saga-and-file-hash" },
    { version: 2026080403, name: "conversation-tombstone-gc" },
    { version: 2026080404, name: "remote-worker-device-credentials" },
    { version: 2026080405, name: "terminal-job-finalization-reconciliation" },
    { version: 2026080406, name: "unique-active-project-thread" },
    { version: 2026080801, name: "tus-resumable-uploads" },
    { version: 2026080901, name: "public-file-sharing-and-audit" },
    { version: 2026081201, name: "conversation-optional-capability-state" },
    { version: 2026081501, name: "agent-wake-new-conversation" },
    { version: 2026081502, name: "conversation-unread-message-anchor" },
    { version: 2026081503, name: "personal-memory-pipeline" },
    { version: 2026081504, name: "hide-personal-context-progress-echoes" },
    { version: 2026081601, name: "voice-lexicon-pipeline" },
    { version: 2026081602, name: "remove-run-auto-pins" },
    { version: 2026081603, name: "personal-memory-management" },
    { version: 2026081701, name: "codex-conversation-title-audit" },
    { version: 2026082001, name: "allow-multiple-agent-wake-plans" },
    { version: 2026082002, name: "scheduled-message-identity" },
    { version: 2026082101, name: "executor-codex-account-quota-scope" },
    { version: 2026082201, name: "conversation-cold-storage" },
    { version: 2026082202, name: "codex-quota-reset-time" },
    { version: 2026082401, name: "voice-recording-storage" },
    { version: 2026082501, name: "login-throttle" },
    { version: 2026082601, name: "voice-transcription-idempotency" },
    { version: 2026082602, name: "reader-sources-and-annotations" },
    { version: 2026082603, name: "reader-storage-state-columns" },
    { version: 2026082604, name: "reader-storage-archive-metadata" },
  ]);
  first.close();
  const reopened = new AppDatabase(root, undefined, false);
  assert.equal((reopened.sqlite.prepare("SELECT count(*) AS value FROM schema_migrations").get() as { value: number }).value, 28);
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).some((column) => column.name === "finalization_state"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(remote_worker_credentials)").all() as Array<{ name: string }>).some((column) => column.name === "token_hash"));
  assert.ok((reopened.sqlite.prepare("PRAGMA index_list(conversations)").all() as Array<{ name: string }>).some((index) => index.name === "conversations_active_project_thread_idx"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(resumable_uploads)").all() as Array<{ name: string }>).some((column) => column.name === "offset"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(public_file_shares)").all() as Array<{ name: string }>).some((column) => column.name === "enabled"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(public_file_share_assets)").all() as Array<{ name: string }>).some((column) => column.name === "source_ref"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(public_share_access_events)").all() as Array<{ name: string }>).some((column) => column.name === "ip_address"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(public_share_access_rollups)").all() as Array<{ name: string }>).some((column) => column.name === "access_count"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some((column) => column.name === "optional_capabilities_json"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(wake_plans)").all() as Array<{ name: string }>).some((column) => column.name === "new_conversation"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(wake_plans)").all() as Array<{ name: string }>).some((column) => column.name === "target_conversation_id"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some((column) => column.name === "unread_anchor_message_id"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some((column) => column.name === "personal_context_revision"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(personal_memory_entries)").all() as Array<{ name: string }>).some((column) => column.name === "canonical_key"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(personal_memory_entries)").all() as Array<{ name: string }>).some((column) => column.name === "review_state"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(conversation_storage)").all() as Array<{ name: string }>).some((column) => column.name === "manifest_sha256"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(codex_quota_snapshots)").all() as Array<{ name: string }>).some((column) => column.name === "reset_at"));
  assert.ok((reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all() as Array<{ name: string }>).some((trigger) => trigger.name === "conversations_storage_init"));
  assert.ok((reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all() as Array<{ name: string }>).some((trigger) => trigger.name === "personal_memory_enqueue_user_message"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(voice_transcriptions)").all() as Array<{ name: string }>).some((column) => column.name === "selected_terms_json"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(voice_transcriptions)").all() as Array<{ name: string }>).some((column) => column.name === "audio_relative_path"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(voice_transcriptions)").all() as Array<{ name: string }>).some((column) => column.name === "audio_storage_state"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(voice_transcriptions)").all() as Array<{ name: string }>).some((column) => column.name === "client_recording_id"));
  assert.ok((reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).some((table) => table.name === "reading_sources"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(reading_source_versions)").all() as Array<{ name: string }>).some((column) => column.name === "storage_generation"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(reading_source_versions)").all() as Array<{ name: string }>).some((column) => column.name === "storage_archive_sha256"));
  assert.ok((reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).some((table) => table.name === "reading_annotations"));
  assert.ok((reopened.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).some((table) => table.name === "voice_transcription_receipts"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(voice_recording_storage_audit)").all() as Array<{ name: string }>).some((column) => column.name === "remote_path" || column.name === "to_state"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(voice_lexicon_terms)").all() as Array<{ name: string }>).some((column) => column.name === "rank_index"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(conversation_title_audits)").all() as Array<{ name: string }>).some((column) => column.name === "request_sha256"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).some((column) => column.name === "is_scheduled"));
  assert.ok((reopened.sqlite.prepare("PRAGMA table_info(executor_codex_account_state)").all() as Array<{ name: string }>).some((column) => column.name === "active_account_id"));
  assert.equal((reopened.sqlite.prepare("PRAGMA index_list(wake_plans)").all() as Array<{ name: string }>).some((index) => index.name === "wake_plans_active_creator_idx"), false);
  reopened.close();

  const legacy = new AppDatabase(root, undefined, false);
  legacy.sqlite.exec("CREATE UNIQUE INDEX wake_plans_active_creator_idx ON wake_plans(created_by_job_id) WHERE state='armed' AND created_by_job_id IS NOT NULL");
  legacy.sqlite.prepare("DELETE FROM schema_migrations WHERE version=2026082001").run();
  legacy.close();
  const migrated = new AppDatabase(root, undefined, false);
  assert.equal((migrated.sqlite.prepare("PRAGMA index_list(wake_plans)").all() as Array<{ name: string }>).some((index) => index.name === "wake_plans_active_creator_idx"), false);
  migrated.close();
});

test("terminal finalization migration clears published journals without hiding recoverable work", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-terminal-finalization-migration-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new AppDatabase(root, undefined, false);
  const rows = ["published", "terminal-empty", "db-committed", "terminal-pending"].map((label) => {
    const conversation = first.createConversation(crypto.randomUUID(), label);
    return first.createJob(crypto.randomUUID(), conversation.id);
  });
  first.sqlite.prepare("UPDATE jobs SET status='completed',finalization_state='published',finalization_payload='legacy' WHERE id=?").run(rows[0].id);
  first.sqlite.prepare("UPDATE jobs SET status='failed',finalization_state='staging',finalization_payload=NULL,finalization_error='legacy' WHERE id=?").run(rows[1].id);
  first.sqlite.prepare("UPDATE jobs SET status='completed',finalization_state='db_committed',finalization_payload='recover' WHERE id=?").run(rows[2].id);
  first.sqlite.prepare("UPDATE jobs SET status='failed',finalization_state='staging',finalization_payload='recover' WHERE id=?").run(rows[3].id);
  first.sqlite.prepare("DELETE FROM schema_migrations WHERE version=2026080405").run();
  first.close();

  const reopened = new AppDatabase(root, undefined, false);
  assert.deepEqual(
    rows.map((row) => {
      const job = reopened.getJob(row.id);
      return [job?.finalization_state, job?.finalization_payload, job?.finalization_error];
    }),
    [
      ["published", null, null],
      ["published", null, null],
      ["db_committed", "recover", null],
      ["staging", "recover", null],
    ],
  );
  reopened.close();
});

test("run auto-pin migration removes only pins written during a job", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-run-auto-pin-migration-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new AppDatabase(root, undefined, false);
  const automatic = first.createConversation(crypto.randomUUID(), "automatic");
  const manual = first.createConversation(crypto.randomUUID(), "manual");
  const job = first.createJob(crypto.randomUUID(), automatic.id);
  first.sqlite.prepare("UPDATE jobs SET created_at=?,updated_at=? WHERE id=?")
    .run("2026-08-16T00:00:00.000Z", "2026-08-16T00:05:00.000Z", job.id);
  first.sqlite.prepare("UPDATE conversations SET pinned_at=? WHERE id=?").run("2026-08-16T00:01:00.000Z", automatic.id);
  first.sqlite.prepare("UPDATE conversations SET pinned_at=? WHERE id=?").run("2026-08-16T00:06:00.000Z", manual.id);
  first.sqlite.prepare("DELETE FROM schema_migrations WHERE version=2026081602").run();
  first.close();

  const reopened = new AppDatabase(root, undefined, false);
  assert.equal(reopened.getConversation(automatic.id)?.pinned_at, null);
  assert.equal(reopened.getConversation(manual.id)?.pinned_at, "2026-08-16T00:06:00.000Z");
  reopened.close();
});

test("Remote Worker credential foundation stores only hashes and rotates atomically", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-worker-credentials-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new AppDatabase(root, undefined, false);
  const workerId = crypto.randomUUID();
  db.registerRemoteWorker({
    id: workerId, machine_name: "credential-test", platform: "win32-x64", protocol_version: 5,
    worker_version: "1.15.0", worker_release: null, worker_commit: null, worker_update_capable: 1,
    codex_version: "test", capacity: 1,
  });
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  db.issueRemoteWorkerCredential(workerId, firstId, "a".repeat(64));
  db.issueRemoteWorkerCredential(workerId, secondId, "b".repeat(64));
  const rows = db.listRemoteWorkerCredentials(workerId);
  assert.equal(rows.find((row) => row.credential_id === firstId)?.state, "retired");
  assert.equal(rows.find((row) => row.credential_id === firstId)?.replaced_by, secondId);
  assert.equal(rows.find((row) => row.credential_id === secondId)?.state, "active");
  assert.deepEqual((db.sqlite.prepare("PRAGMA table_info(remote_worker_credentials)").all() as Array<{ name: string }>).some((column) => column.name === "token"), false);
  assert.equal(db.revokeRemoteWorkerCredential(workerId, secondId), true);
  assert.equal(db.listRemoteWorkerCredentials(workerId).some((row) => row.state === "active"), false);
  db.close();
});
