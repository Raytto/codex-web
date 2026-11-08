import type { AppDatabase } from './db.js';
/** Additive, conversation-owned state. Never grants an ordinary conversation Dot authority. */
export function migrateConversationVoice(db: AppDatabase) {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversation_voice_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0, delegated_seq INTEGER NOT NULL DEFAULT 0,
      message_rowid INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS conversation_voice_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, source_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(conversation_id,kind,source_id));
    CREATE INDEX IF NOT EXISTS conversation_voice_events_scope ON conversation_voice_events(conversation_id,seq);
    CREATE TABLE IF NOT EXISTS conversation_voice_operations (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      request_key TEXT NOT NULL, revision INTEGER NOT NULL, source_seq INTEGER NOT NULL,
      pending_id TEXT, job_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id,request_key));
    CREATE TABLE IF NOT EXISTS conversation_voice_checkpoints (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      watermark INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_voice_results (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS conversation_voice_calls (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      state TEXT NOT NULL, egress TEXT NOT NULL, usage_json TEXT, checkpoint_id TEXT,
      started_at TEXT NOT NULL, closed_at TEXT);
  `);
}

