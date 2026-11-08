import { HOST_ROOT_USER_ID } from "./host-root-user.js";
import { HOST_EXECUTOR_ID } from "./remote-worker-protocol.js";
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export function migrateJudgments(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE judgments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK(kind IN ('prediction','idea')), title TEXT NOT NULL, original_json TEXT NOT NULL,
      probability REAL, topic TEXT NOT NULL, deadline_at TEXT, mode TEXT NOT NULL, auto_resolve INTEGER NOT NULL,
      synthetic INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'observing', outcome TEXT,
      revision INTEGER NOT NULL DEFAULT 1, parent_id TEXT REFERENCES judgments(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX judgments_owner ON judgments(user_id,project_id,state,deadline_at);
    CREATE TABLE judgment_versions (
      id TEXT PRIMARY KEY, judgment_id TEXT NOT NULL REFERENCES judgments(id), number INTEGER NOT NULL, probability REAL,
      reason TEXT NOT NULL, snapshot_json TEXT, actor TEXT NOT NULL, conversation_id TEXT, created_at TEXT NOT NULL,
      UNIQUE(judgment_id,number)
    );
    CREATE TABLE judgment_checks (
      id TEXT PRIMARY KEY, judgment_id TEXT NOT NULL REFERENCES judgments(id), task_id TEXT NOT NULL UNIQUE REFERENCES recurring_tasks(id),
      state TEXT NOT NULL DEFAULT 'armed', conversation_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX judgment_checks_item ON judgment_checks(judgment_id,state);
    CREATE TABLE judgment_evidence (
      id TEXT PRIMARY KEY, judgment_id TEXT NOT NULL REFERENCES judgments(id), check_id TEXT REFERENCES judgment_checks(id),
      content_json TEXT NOT NULL, conversation_id TEXT, job_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX judgment_evidence_item ON judgment_evidence(judgment_id,created_at);
    CREATE TABLE judgment_attachments (
      evidence_id TEXT NOT NULL REFERENCES judgment_evidence(id), file_id TEXT NOT NULL REFERENCES files(id),
      PRIMARY KEY(evidence_id,file_id)
    );
    CREATE INDEX judgment_attachments_file ON judgment_attachments(file_id);
    CREATE TABLE judgment_results (
      id TEXT PRIMARY KEY, judgment_id TEXT NOT NULL REFERENCES judgments(id), outcome TEXT NOT NULL, reason TEXT NOT NULL,
      candidate INTEGER NOT NULL, evidence_json TEXT NOT NULL, actor TEXT NOT NULL, conversation_id TEXT,
      supersedes TEXT REFERENCES judgment_results(id), created_at TEXT NOT NULL
    );
    CREATE INDEX judgment_results_item ON judgment_results(judgment_id,created_at);
    CREATE TABLE judgment_events (
      id TEXT PRIMARY KEY, judgment_id TEXT NOT NULL REFERENCES judgments(id), kind TEXT NOT NULL, text TEXT NOT NULL,
      conversation_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX judgment_events_item ON judgment_events(judgment_id,created_at);
    CREATE TABLE judgment_requests (
      user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(user_id,request_key)
    );
  `);
  // Preserve every other preference and leave all other accounts opt-in.
}

// Called inside the existing recurring scheduler's transaction. No new timer or
// hidden runner. Private and open-ended reviews deliberately create no model job.
export function judgmentCheckBeforeFire(sql: DatabaseSync, taskId: string, now: string): 'agent' | 'feedback' | 'blocked' | null {
  const c = sql.prepare(`SELECT c.id,c.state,j.id AS judgment_id,j.kind,j.mode,j.state AS judgment_state FROM judgment_checks c JOIN judgments j ON j.id=c.judgment_id WHERE c.task_id=?`).get(taskId) as {id:string;state:string;judgment_id:string;kind:string;mode:string;judgment_state:string}|undefined;
  if (!c) return null;
  if (c.state !== 'armed' || ['resolved','indeterminate','withdrawn'].includes(c.judgment_state)) return 'blocked';
  const eligible=sql.prepare(`SELECT 1 FROM recurring_tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.user_id WHERE t.id=? AND p.user_id=t.user_id AND p.archived_at IS NULL AND u.status='active' AND p.executor_id=CASE WHEN u.id=? THEN ? ELSE 'tenant-local' END`).get(taskId,HOST_ROOT_USER_ID,HOST_EXECUTOR_ID);
  if(!eligible){sql.prepare("UPDATE judgment_checks SET state='cancelled' WHERE id=?").run(c.id);return 'blocked';}
  const manual = c.kind === 'idea' || c.mode === 'private';
  sql.prepare('UPDATE judgment_checks SET state=? WHERE id=?').run(manual?'feedback':'fired',c.id);
  sql.prepare('UPDATE judgments SET state=?,revision=revision+1,updated_at=? WHERE id=?').run(manual?'feedback':'verification',now,c.judgment_id);
  sql.prepare('INSERT INTO judgment_events(id,judgment_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),c.judgment_id,'due',manual?'回顾时间到了，等待本人反馈。':'检查已到期，已交给所属项目的普通会话核验。',now);
  return manual?'feedback':'agent';
}
