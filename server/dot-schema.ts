import type { DatabaseSync } from 'node:sqlite';
export function migrateDot(sql: DatabaseSync) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS dot_sessions(user_id TEXT PRIMARY KEY REFERENCES users(id), conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id), revision INTEGER NOT NULL DEFAULT 1, reset_pending INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dot_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,source_id TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,kind,source_id));
CREATE TABLE IF NOT EXISTS dot_tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),project_id TEXT NOT NULL REFERENCES projects(id),executor_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'queued',result TEXT NOT NULL DEFAULT '',review_state TEXT NOT NULL DEFAULT 'pending',review_source TEXT,review_summary TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dot_memories(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),content TEXT NOT NULL,source_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dot_operations(user_id TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,request_key));
CREATE TABLE IF NOT EXISTS dot_checkpoints(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,watermark INTEGER NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dot_calls(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,state TEXT NOT NULL,egress TEXT,usage_json TEXT,checkpoint_id TEXT,started_at TEXT NOT NULL,closed_at TEXT);
CREATE TABLE IF NOT EXISTS dot_projections(user_id TEXT NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(user_id,name));
CREATE TABLE IF NOT EXISTS dot_steers(pending_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,turn_id TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS dot_events_owner_seq ON dot_events(user_id,seq);
`);
}
