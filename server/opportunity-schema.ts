import crypto from "node:crypto";
import type { DatabaseSync } from 'node:sqlite';
// Historical conversation/job IDs are durable provenance, not ownership grants.
// Keep them after normal conversation GC; every live access rechecks the owner.
export function migrateOpportunities(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE opportunity_topics (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT UNIQUE REFERENCES recurring_tasks(id), name TEXT NOT NULL, goal TEXT NOT NULL,
      questions TEXT NOT NULL DEFAULT '', constraints TEXT NOT NULL DEFAULT '', limit_count INTEGER NOT NULL DEFAULT 3,
      exploration INTEGER NOT NULL DEFAULT 20, read_recent INTEGER NOT NULL DEFAULT 0, context_watermark INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, archived_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX opportunity_topics_owner ON opportunity_topics(user_id,deleted_at);
    CREATE TABLE opportunity_batches (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), topic_id TEXT NOT NULL REFERENCES opportunity_topics(id),
      day TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('generating','reviewing','completed','failed')),
      conversation_id TEXT NOT NULL, job_id TEXT,
      project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES recurring_tasks(id), attempts INTEGER NOT NULL DEFAULT 1,
      context_watermark INTEGER NOT NULL DEFAULT 0, feedback_snapshot TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(topic_id,day)
    );
    CREATE INDEX opportunity_batches_owner ON opportunity_batches(user_id,topic_id,day);
    CREATE TABLE opportunity_ideas (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), topic_id TEXT NOT NULL REFERENCES opportunity_topics(id),
      content_json TEXT NOT NULL, state TEXT NOT NULL, score REAL, quality REAL NOT NULL DEFAULT 0,
      review_reason TEXT NOT NULL DEFAULT '', state_reason TEXT NOT NULL DEFAULT '', rating INTEGER, note TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL, duplicate_of TEXT REFERENCES opportunity_ideas(id), first_created_at TEXT NOT NULL,
      last_reviewed_at TEXT, first_recommended_at TEXT, recommended_batch_id TEXT REFERENCES opportunity_batches(id),
      source_batch_id TEXT NOT NULL REFERENCES opportunity_batches(id), source_conversation_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES recurring_tasks(id), para_project_id TEXT REFERENCES para_projects(id) ON DELETE SET NULL,
      manual_processed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, UNIQUE(user_id,fingerprint)
    );
    CREATE INDEX opportunity_inventory ON opportunity_ideas(user_id,topic_id,state,first_recommended_at);
    CREATE TABLE opportunity_candidates (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES opportunity_batches(id), candidate_key TEXT NOT NULL,
      payload TEXT NOT NULL, idea_id TEXT NOT NULL REFERENCES opportunity_ideas(id), outcome TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(batch_id,candidate_key)
    );
    CREATE TABLE opportunity_reviews (
      batch_id TEXT NOT NULL REFERENCES opportunity_batches(id), idea_id TEXT NOT NULL REFERENCES opportunity_ideas(id),
      verdict TEXT NOT NULL, score REAL NOT NULL, rationale TEXT NOT NULL, compared_json TEXT NOT NULL, created_at TEXT NOT NULL, feedback_revision INTEGER NOT NULL,
      PRIMARY KEY(batch_id,idea_id)
    );
    CREATE TABLE opportunity_versions (
      id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES opportunity_ideas(id), content_json TEXT NOT NULL,
      reason TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE opportunity_feedback (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), idea_id TEXT NOT NULL REFERENCES opportunity_ideas(id),
      request_key TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, rating INTEGER, note TEXT NOT NULL,
      actor TEXT NOT NULL, previous_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,request_key)
    );
    CREATE TABLE opportunity_preferences (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), topic_id TEXT NOT NULL REFERENCES opportunity_topics(id),
      text TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'topic', source TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE opportunity_research (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), idea_id TEXT NOT NULL REFERENCES opportunity_ideas(id),
      conversation_id TEXT NOT NULL, request_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'interested',
      result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,request_key)
    );
    CREATE TABLE opportunity_requests (user_id TEXT NOT NULL, request_key TEXT NOT NULL, operation TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(user_id,request_key));
  `);
}

// Called inside the native scheduler / normal conversation creation transaction.
// Reserving business provenance is not a second scheduler or a model execution.
export function reserveOpportunityBatch(sql: DatabaseSync, topicId: string, user: string, conversation: string, project: string, task: string | null, day: string, time: string) {
  sql.prepare(`INSERT INTO opportunity_batches(id,user_id,topic_id,day,status,conversation_id,project_id,task_id,created_at)
    VALUES(?,?,?,?,'generating',?,?,?,?) ON CONFLICT(topic_id,day) DO UPDATE SET status='generating',conversation_id=excluded.conversation_id,
    job_id=NULL,attempts=opportunity_batches.attempts+1,error='',completed_at=NULL
    WHERE opportunity_batches.status='failed' AND opportunity_batches.attempts<3`).run(crypto.randomUUID(),user,topicId,day,conversation,project,task,time);
}

// Reconcile business state from normal Jobs; invoked by the existing scheduler as
// well as reads, so failure recovery never depends on a browser being open.
export function reconcileOpportunityBatches(sql: DatabaseSync, user: string, topicId?: string) {
  sql.prepare(`UPDATE opportunity_batches SET status='failed',error='来源任务已结束，但未提交本轮结果。请在来源会话检查失败或停止原因，可手动重试。',completed_at=? WHERE user_id=? ${topicId?'AND topic_id=?':''} AND status IN ('generating','reviewing') AND ((job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=job_id AND j.status IN ('running','queued'))) OR (job_id IS NULL AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=opportunity_batches.conversation_id AND j.status IN ('running','queued')) AND NOT EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=opportunity_batches.conversation_id AND p.status='queued') AND EXISTS(SELECT 1 FROM opportunity_requests r WHERE json_extract(r.result_json,'$.conversationId')=opportunity_batches.conversation_id UNION ALL SELECT 1 FROM recurring_runs r WHERE r.conversation_id=opportunity_batches.conversation_id)))`).run(...(topicId?[new Date().toISOString(),user,topicId]:[new Date().toISOString(),user]));
}
