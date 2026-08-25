import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { isDeliverablePath, normalizeStoredRelativePath, normalizeUploadFileName } from "./paths.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";

export const LEGACY_USER_ID = "00000000-0000-4000-8000-000000000001";

export class StorageQuotaExceededError extends Error {
  readonly code = "USER_STORAGE_LIMIT";

  constructor() {
    super("User storage limit exceeded");
    this.name = "StorageQuotaExceededError";
  }
}

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "owner" | "member";
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  title_source: ConversationTitleSource;
  codex_thread_id: string | null;
  agent_model: string | null;
  reasoning_effort: string | null;
  status: "idle" | "running";
  has_unread_result: number;
  unread_anchor_message_id: string | null;
  has_pending_work: number;
  active_wake_count: number;
  next_wake_at: string | null;
  active_wake_mode: WakePlanMode | null;
  active_wake_label: string | null;
  rollout_bytes: number | null;
  context_input_tokens: number | null;
  context_window_tokens: number | null;
  context_usage_updated_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ConversationTitleSource = "default" | "ai" | "manual" | "legacy";

export type ConversationTitleAuditRow = {
  id: string;
  conversation_id: string | null;
  user_id: string;
  model: string;
  reasoning_effort: string;
  prompt_version: string;
  request_excerpt: string;
  request_sha256: string;
  context_json: string;
  status: "running" | "succeeded" | "failed";
  output_title: string | null;
  applied: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  quote_excerpt?: string | null;
  is_scheduled?: number;
  created_at: string;
};

export type FileRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  pending_prompt_id?: string | null;
  composer_draft_id?: string | null;
  original_name: string;
  relative_path: string;
  mime_type: string;
  size: number;
  sha256?: string | null;
  kind: "upload" | "output";
  created_at: string;
};

export type PublicFileShareRow = {
  id: string;
  file_id: string;
  user_id: string;
  file_name_snapshot: string;
  enabled: number;
  created_at: string;
  enabled_at: string | null;
  disabled_at: string | null;
};

export type PublicFileShareAssetRow = {
  share_id: string;
  asset_file_id: string;
  source_ref: string;
  created_at: string;
};

export type ResumableUploadState = "uploading" | "finalizing" | "completed" | "cancelled" | "expired";
export type ResumableUploadRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  file_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  offset: number;
  storage_name: string;
  final_name: string;
  state: ResumableUploadState;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
};

export type MessagePage = {
  messages: Array<MessageRow & { files: FileRow[] }>;
  hasMore: boolean;
  nextCursor: string | null;
};

export type PendingPromptRow = {
  id: string;
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  agent_model: string;
  reasoning_effort: string;
  position: number;
  status: "queued" | "editing";
  created_at: string;
  updated_at: string;
};

export type PendingPromptWithFiles = PendingPromptRow & { files: FileRow[] };

export type WakePlanMode = "time" | "event_or_deadline";
export type WakePlanState = "armed" | "triggered" | "cancelled";
export type WakeTriggerCause = "success" | "failure" | "deadline" | "manual";
export type WakeEventKind = WakeTriggerCause | "heartbeat";

export type WakePlanRow = {
  id: string;
  conversation_id: string;
  created_by_job_id: string | null;
  mode: WakePlanMode;
  state: WakePlanState;
  revision: number;
  label: string;
  run_id: string | null;
  deadline_at: string;
  success_prompt: string;
  failure_prompt: string;
  timeout_prompt: string;
  new_conversation: number;
  target_conversation_id: string | null;
  agent_model: string;
  reasoning_effort: string;
  event_token_hash: string | null;
  trigger_cause: WakeTriggerCause | null;
  triggered_at: string | null;
  cancelled_at: string | null;
  pending_prompt_id: string | null;
  job_id: string | null;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  last_event_kind: WakeEventKind | null;
  last_event_summary: string | null;
  created_at: string;
  updated_at: string;
};

export type WakeEventRow = {
  wake_plan_id: string;
  event_id: string;
  kind: WakeEventKind;
  summary: string | null;
  accepted: number;
  created_at: string;
};

export type WakeTriggerResult = {
  status: "triggered" | "heartbeat" | "duplicate" | "stale" | "missing";
  plan?: WakePlanRow;
  pendingPrompt?: PendingPromptWithFiles;
  targetConversation?: ConversationRow;
};

export type ComposerDraftRow = {
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  created_at: string;
  updated_at: string;
};

export type ComposerDraftWithFiles = ComposerDraftRow & { files: FileRow[] };

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type JobRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  agent_model: string | null;
  reasoning_effort: string | null;
  queue_seq: number;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  token_hash: string;
  csrf_token: string;
  expires_at: string;
  user_id: string;
  username: string;
  display_name: string;
  role: UserRow["role"];
};

export type JobEventRow = {
  seq: number;
  event_type: string;
  payload: string;
  created_at: string;
};

export type StoredAgentSelection = {
  model: string;
  reasoningEffort: string;
};

export type CodexQuotaSnapshot = {
  remainingPercent: number;
  updatedAt: string;
};

type LegacyUserSeed = { username: string; passwordHash: string; displayName?: string };

const conversationSelect = `
  conversations.*,
  CASE WHEN
    EXISTS (SELECT 1 FROM jobs WHERE jobs.conversation_id=conversations.id AND jobs.status='queued')
    OR EXISTS (SELECT 1 FROM pending_prompts WHERE pending_prompts.conversation_id=conversations.id AND pending_prompts.status='queued')
  THEN 1 ELSE 0 END AS has_pending_work,
  (SELECT count(1) FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed') AS active_wake_count,
  (SELECT min(deadline_at) FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed') AS next_wake_at,
  (SELECT mode FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed' LIMIT 1) AS active_wake_mode,
  (SELECT label FROM wake_plans WHERE wake_plans.conversation_id=conversations.id AND wake_plans.state='armed' LIMIT 1) AS active_wake_label
`;

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(dataRoot: string, legacyUser: LegacyUserSeed = { username: "owner", passwordHash: "", displayName: "Owner" }, recoverJobs = true) {
    fs.mkdirSync(dataRoot, { recursive: true });
    this.sqlite = new DatabaseSync(path.join(dataRoot, "codex-web.sqlite"));
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate(legacyUser);
    if (recoverJobs) {
      // A running child process cannot survive an application restart. Queued work is
      // deliberately retained and the queue pump will resume it in FIFO order. Leave a
      // visible message and event so interrupted work cannot look silently completed.
      const interrupted = this.sqlite.prepare(`
        SELECT job.id,job.conversation_id,conversation.deleted_at
        FROM jobs job JOIN conversations conversation ON conversation.id=job.conversation_id
        WHERE job.status='running'
      `).all() as Array<{ id: string; conversation_id: string; deleted_at: string | null }>;
      const now = new Date().toISOString();
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const job of interrupted) {
          const error = "服务重启，原运行任务已中断";
          const event = this.sqlite.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE job_id=?").get(job.id) as { seq: number };
          this.sqlite.prepare("UPDATE jobs SET status='interrupted',error=COALESCE(error,?),updated_at=? WHERE id=?").run(error, now, job.id);
          this.sqlite.prepare("INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)")
            .run(job.id, event.seq, "failed", JSON.stringify({ status: "interrupted", message: error }), now);
          if (job.deleted_at) continue;
          const noticeMessageId = crypto.randomUUID();
          this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'assistant',?,NULL,?)")
            .run(noticeMessageId, job.conversation_id, "上一条任务因服务重启而中断，尚未执行完成。为避免重复产生副作用，系统没有自动重试；请重新发送该任务。", now);
          this.sqlite.prepare("UPDATE conversations SET status='idle',has_unread_result=1,unread_anchor_message_id=COALESCE(unread_anchor_message_id,?),updated_at=? WHERE id=?")
            .run(noticeMessageId, now, job.conversation_id);
        }
        this.sqlite.prepare("UPDATE conversations SET status='idle' WHERE status='running'").run();
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private migrate(legacyUser: LegacyUserSeed): void {
    this.sqlite.exec("DROP INDEX IF EXISTS jobs_queue_idx");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'legacy',
        codex_thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        has_unread_result INTEGER NOT NULL DEFAULT 0,
        unread_anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        rollout_bytes INTEGER,
        context_input_tokens INTEGER,
        context_window_tokens INTEGER,
        context_usage_updated_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_quota_snapshots (
        scope_id TEXT PRIMARY KEY,
        remaining_percent REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_title_audits (
        id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        request_excerpt TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        context_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
        output_title TEXT,
        applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS conversation_title_audits_conversation_idx ON conversation_title_audits(conversation_id,started_at);
      CREATE INDEX IF NOT EXISTS conversation_title_audits_user_idx ON conversation_title_audits(user_id,started_at);
      CREATE INDEX IF NOT EXISTS conversation_title_audits_status_idx ON conversation_title_audits(status,started_at);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
        is_scheduled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_prompts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
        agent_model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composer_drafts (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        quote_excerpt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE,
        composer_draft_id TEXT REFERENCES composer_drafts(conversation_id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        agent_model TEXT,
        reasoning_effort TEXT,
        queue_seq INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, seq)
      );
      CREATE TABLE IF NOT EXISTS wake_plans (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_by_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'armed',
        revision INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL,
        run_id TEXT,
        deadline_at TEXT NOT NULL,
        success_prompt TEXT NOT NULL,
        failure_prompt TEXT NOT NULL,
        timeout_prompt TEXT NOT NULL,
        new_conversation INTEGER NOT NULL DEFAULT 0,
        target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        agent_model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        event_token_hash TEXT,
        trigger_cause TEXT,
        triggered_at TEXT,
        cancelled_at TEXT,
        pending_prompt_id TEXT UNIQUE REFERENCES pending_prompts(id) ON DELETE SET NULL,
        job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
        last_heartbeat_at TEXT,
        last_event_at TEXT,
        last_event_kind TEXT,
        last_event_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wake_events (
        wake_plan_id TEXT NOT NULL REFERENCES wake_plans(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(wake_plan_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );
      CREATE TABLE IF NOT EXISTS resumable_uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        offset INTEGER NOT NULL DEFAULT 0 CHECK(offset >= 0 AND offset <= size),
        storage_name TEXT NOT NULL UNIQUE,
        final_name TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('uploading','finalizing','completed','cancelled','expired')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS resumable_uploads_owner_state_idx ON resumable_uploads(user_id,state,expires_at);
      CREATE INDEX IF NOT EXISTS resumable_uploads_conversation_state_idx ON resumable_uploads(conversation_id,state);
      CREATE INDEX IF NOT EXISTS resumable_uploads_expiry_idx ON resumable_uploads(state,expires_at);
      CREATE TABLE IF NOT EXISTS public_file_shares (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        file_name_snapshot TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        created_at TEXT NOT NULL,
        enabled_at TEXT,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS public_file_share_assets (
        share_id TEXT NOT NULL REFERENCES public_file_shares(id) ON DELETE CASCADE,
        asset_file_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(share_id,source_ref),
        UNIQUE(share_id,asset_file_id,source_ref)
      );
      CREATE TABLE IF NOT EXISTS public_share_access_events (
        id TEXT PRIMARY KEY,
        share_id TEXT NOT NULL REFERENCES public_file_shares(id) ON DELETE CASCADE,
        ip_address TEXT NOT NULL,
        view_id TEXT NOT NULL,
        user_agent TEXT,
        accessed_at TEXT NOT NULL,
        UNIQUE(share_id,view_id)
      );
      CREATE TABLE IF NOT EXISTS public_share_access_rollups (
        share_id TEXT NOT NULL REFERENCES public_file_shares(id) ON DELETE CASCADE,
        ip_address TEXT NOT NULL,
        first_accessed_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(share_id,ip_address)
      );
      CREATE INDEX IF NOT EXISTS public_file_shares_user_enabled_idx ON public_file_shares(user_id,enabled);
      CREATE INDEX IF NOT EXISTS public_file_share_assets_asset_idx ON public_file_share_assets(asset_file_id);
      CREATE INDEX IF NOT EXISTS public_share_access_events_share_time_idx ON public_share_access_events(share_id,accessed_at);
      CREATE INDEX IF NOT EXISTS public_share_access_events_time_idx ON public_share_access_events(accessed_at);
      CREATE INDEX IF NOT EXISTS public_share_access_rollups_last_idx ON public_share_access_rollups(last_accessed_at);
    `);

    const conversationColumns = this.columnNames("conversations");
    if (!conversationColumns.has("user_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id)");
    if (!conversationColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN agent_model TEXT");
    if (!conversationColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT");
    if (!conversationColumns.has("has_unread_result")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN has_unread_result INTEGER NOT NULL DEFAULT 0");
    if (!conversationColumns.has("unread_anchor_message_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN unread_anchor_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
    if (!conversationColumns.has("rollout_bytes")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN rollout_bytes INTEGER");
    if (!conversationColumns.has("context_input_tokens")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_input_tokens INTEGER");
    if (!conversationColumns.has("context_window_tokens")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_window_tokens INTEGER");
    if (!conversationColumns.has("context_usage_updated_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_usage_updated_at TEXT");
    if (!conversationColumns.has("archived_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
    if (!conversationColumns.has("deleted_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN deleted_at TEXT");
    if (!conversationColumns.has("title_source")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'");
    this.sqlite.exec(`
      UPDATE conversations
      SET unread_anchor_message_id=(
        SELECT assistant.id FROM messages assistant
        WHERE assistant.conversation_id=conversations.id AND assistant.role='assistant'
          AND NOT EXISTS (
            SELECT 1 FROM messages later_user
            WHERE later_user.conversation_id=conversations.id AND later_user.role='user'
              AND (later_user.created_at>assistant.created_at OR (later_user.created_at=assistant.created_at AND later_user.id>assistant.id))
          )
        ORDER BY assistant.created_at,assistant.id LIMIT 1
      )
      WHERE has_unread_result=1 AND unread_anchor_message_id IS NULL
    `);
    const messageColumns = this.columnNames("messages");
    if (!messageColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN quote_excerpt TEXT");
    if (!messageColumns.has("is_scheduled")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN is_scheduled INTEGER NOT NULL DEFAULT 0");
    this.sqlite.exec(`
      UPDATE messages SET is_scheduled=1
      WHERE id IN (
        SELECT job.message_id FROM wake_plans wake
        JOIN jobs job ON job.id=wake.job_id
        WHERE job.message_id IS NOT NULL
      )
    `);
    const pendingPromptColumns = this.columnNames("pending_prompts");
    if (!pendingPromptColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN quote_excerpt TEXT");
    const wakePlanColumns = this.columnNames("wake_plans");
    if (!wakePlanColumns.has("new_conversation")) this.sqlite.exec("ALTER TABLE wake_plans ADD COLUMN new_conversation INTEGER NOT NULL DEFAULT 0");
    if (!wakePlanColumns.has("target_conversation_id")) this.sqlite.exec("ALTER TABLE wake_plans ADD COLUMN target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL");
    const sessionColumns = this.columnNames("sessions");
    if (!sessionColumns.has("user_id")) this.sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
    const jobColumns = this.columnNames("jobs");
    if (!jobColumns.has("message_id")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
    if (!jobColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN agent_model TEXT");
    if (!jobColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN reasoning_effort TEXT");
    if (!jobColumns.has("queue_seq")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN queue_seq INTEGER");
    const fileColumns = this.columnNames("files");
    if (!fileColumns.has("pending_prompt_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE");
    if (!fileColumns.has("composer_draft_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN composer_draft_id TEXT REFERENCES composer_drafts(conversation_id) ON DELETE CASCADE");
    if (!fileColumns.has("sha256")) this.sqlite.exec("ALTER TABLE files ADD COLUMN sha256 TEXT");
    const titleAuditRecoveryAt = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE conversation_title_audits
      SET status='failed',error='server_restart',completed_at=?,duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER))
      WHERE status='running'
    `).run(titleAuditRecoveryAt, titleAuditRecoveryAt);
    this.sqlite.prepare("UPDATE jobs SET queue_seq=rowid WHERE queue_seq IS NULL").run();

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, display_name=excluded.display_name,
        password_hash=CASE WHEN excluded.password_hash<>'' THEN excluded.password_hash ELSE users.password_hash END,
        role='owner', status='active', updated_at=excluded.updated_at
    `).run(LEGACY_USER_ID, legacyUser.username, legacyUser.displayName ?? legacyUser.username, legacyUser.passwordHash, "owner", now, now);

    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE conversations SET user_id=? WHERE user_id IS NULL").run(LEGACY_USER_ID);
      this.sqlite.prepare("UPDATE sessions SET user_id=? WHERE user_id IS NULL").run(LEGACY_USER_ID);
      const legacySetting = this.sqlite.prepare("SELECT value,updated_at FROM app_settings WHERE key='agent_selection'").get() as { value: string; updated_at: string } | undefined;
      if (legacySetting) {
        this.sqlite.prepare("INSERT OR IGNORE INTO user_settings(user_id,key,value,updated_at) VALUES(?,'agent_selection',?,?)")
          .run(LEGACY_USER_ID, legacySetting.value, legacySetting.updated_at);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }

    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS conversations_user_active_idx ON conversations(user_id, deleted_at, updated_at);
      CREATE INDEX IF NOT EXISTS conversations_user_archived_idx ON conversations(user_id, deleted_at, archived_at);
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_conversation_idx ON files(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_pending_prompt_idx ON files(pending_prompt_id, created_at);
      CREATE INDEX IF NOT EXISTS files_composer_draft_idx ON files(composer_draft_id, created_at);
      CREATE INDEX IF NOT EXISTS pending_prompts_queue_idx ON pending_prompts(conversation_id, status, position);
      CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, queue_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS wake_plans_active_conversation_idx ON wake_plans(conversation_id) WHERE state='armed';
      CREATE INDEX IF NOT EXISTS wake_plans_due_idx ON wake_plans(state,deadline_at);
      CREATE INDEX IF NOT EXISTS wake_events_plan_created_idx ON wake_events(wake_plan_id,created_at);
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    `);

    const uploadedFiles = this.sqlite.prepare("SELECT id,original_name FROM files WHERE kind='upload'").all() as Array<{ id: string; original_name: string }>;
    const updateName = this.sqlite.prepare("UPDATE files SET original_name=? WHERE id=?");
    for (const file of uploadedFiles) {
      const normalizedName = normalizeUploadFileName(file.original_name);
      if (normalizedName !== file.original_name) updateName.run(normalizedName, file.id);
    }
    this.sqlite.prepare("UPDATE files SET relative_path=replace(relative_path, '\\', '/') WHERE instr(relative_path, '\\') > 0").run();
  }

  private columnNames(table: string): Set<string> {
    return new Set((this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  }

  listUsers(): UserRow[] {
    return this.sqlite.prepare("SELECT * FROM users ORDER BY created_at,id").all() as UserRow[];
  }

  getUser(id: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined;
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username) as UserRow | undefined;
  }

  createUser(user: UserRow): void {
    this.sqlite.prepare("INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
      user.id, user.username, user.display_name, user.password_hash, user.role, user.status, user.created_at, user.updated_at,
    );
  }

  setUserPassword(userId: string, passwordHash: string): void {
    this.sqlite.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?").run(passwordHash, new Date().toISOString(), userId);
  }

  setUserStatus(userId: string, status: UserRow["status"]): void {
    this.sqlite.prepare("UPDATE users SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), userId);
    if (status === "disabled") this.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  }

  listConversations(userId?: string): ConversationRow[] {
    if (userId) return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`).all(userId) as ConversationRow[];
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`).all() as ConversationRow[];
  }

  searchConversations(userId: string, rawQuery: string): ConversationRow[] {
    const query = rawQuery.trim().slice(0, 100);
    if (!query) return this.listConversations(userId);
    const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    return this.sqlite.prepare(`
      SELECT ${conversationSelect} FROM conversations
      WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL
        AND (
          title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR EXISTS (
            SELECT 1 FROM messages message
            WHERE message.conversation_id=conversations.id AND message.content LIKE ? ESCAPE '\\' COLLATE NOCASE
          )
        )
      ORDER BY updated_at DESC,id LIMIT 100
    `).all(userId, escaped, escaped) as ConversationRow[];
  }

  listArchivedConversations(userId: string, query = ""): ConversationRow[] {
    const normalized = query.trim().slice(0, 100);
    if (!normalized) {
      return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC,id LIMIT 100`)
        .all(userId) as ConversationRow[];
    }
    const escaped = normalized.replace(/[\\%_]/g, "\\$&");
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL AND title LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY archived_at DESC,id LIMIT 100`)
      .all(userId, `%${escaped}%`) as ConversationRow[];
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=?`).get(id) as ConversationRow | undefined;
  }

  getConversationForUser(id: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=? AND user_id=? AND deleted_at IS NULL`).get(id, userId) as ConversationRow | undefined;
  }

  createConversation(id: string, title: string, selection?: StoredAgentSelection, userId = LEGACY_USER_ID): ConversationRow {
    const now = new Date().toISOString();
    this.sqlite.prepare("INSERT INTO conversations(id,user_id,title,title_source,agent_model,reasoning_effort,status,created_at,updated_at) VALUES(?,?,?,'default',?,?,'idle',?,?)").run(
      id, userId, title, selection?.model ?? null, selection?.reasoningEffort ?? null, now, now,
    );
    return this.getConversation(id)!;
  }

  findReusableEmptyConversation(userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`
      SELECT ${conversationSelect} FROM conversations
      WHERE user_id=? AND title='新任务' AND title_source='default'
        AND status='idle' AND codex_thread_id IS NULL
        AND has_unread_result=0 AND unread_anchor_message_id IS NULL
        AND rollout_bytes IS NULL AND context_input_tokens IS NULL AND context_window_tokens IS NULL
        AND context_usage_updated_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id=conversations.id)
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.conversation_id=conversations.id)
        AND NOT EXISTS (SELECT 1 FROM pending_prompts WHERE pending_prompts.conversation_id=conversations.id)
        AND NOT EXISTS (
          SELECT 1 FROM composer_drafts
          WHERE composer_drafts.conversation_id=conversations.id
            AND (composer_drafts.content<>'' OR composer_drafts.quote_excerpt IS NOT NULL)
        )
        AND NOT EXISTS (SELECT 1 FROM files WHERE files.conversation_id=conversations.id)
        AND NOT EXISTS (
          SELECT 1 FROM resumable_uploads
          WHERE resumable_uploads.conversation_id=conversations.id
            AND resumable_uploads.state IN ('uploading','finalizing')
        )
        AND NOT EXISTS (SELECT 1 FROM wake_plans WHERE wake_plans.conversation_id=conversations.id)
      ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1
    `).get(userId) as ConversationRow | undefined;
  }

  reuseEmptyConversationForNewTask(userId: string): ConversationRow | undefined {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const reusable = this.findReusableEmptyConversation(userId);
      if (!reusable) {
        this.sqlite.exec("COMMIT");
        return undefined;
      }
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(new Date().toISOString(), reusable.id);
      const promoted = this.getConversationForUser(reusable.id, userId);
      if (!promoted) throw new Error("Reusable conversation could not be reloaded");
      this.sqlite.exec("COMMIT");
      return promoted;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  createOrReuseEmptyConversation(id: string, selection: StoredAgentSelection, userId: string): { conversation: ConversationRow; reused: boolean } {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const reusable = this.findReusableEmptyConversation(userId);
      if (reusable) {
        this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(new Date().toISOString(), reusable.id);
        const promoted = this.getConversationForUser(reusable.id, userId);
        if (!promoted) throw new Error("Reusable conversation could not be reloaded");
        this.sqlite.exec("COMMIT");
        return { conversation: promoted, reused: true };
      }
      const conversation = this.createConversation(id, "新任务", selection, userId);
      this.sqlite.exec("COMMIT");
      return { conversation, reused: false };
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  updateConversation(id: string, fields: { title?: string; titleSource?: ConversationTitleSource; codexThreadId?: string; agentSelection?: StoredAgentSelection; status?: "idle" | "running" }): void {
    if (fields.title !== undefined) this.sqlite.prepare("UPDATE conversations SET title=?, title_source=COALESCE(?,title_source), updated_at=? WHERE id=?")
      .run(fields.title, fields.titleSource ?? null, new Date().toISOString(), id);
    if (fields.codexThreadId !== undefined) this.sqlite.prepare(`
      UPDATE conversations SET
        context_input_tokens=CASE WHEN codex_thread_id=? THEN context_input_tokens ELSE NULL END,
        context_window_tokens=CASE WHEN codex_thread_id=? THEN context_window_tokens ELSE NULL END,
        context_usage_updated_at=CASE WHEN codex_thread_id=? THEN context_usage_updated_at ELSE NULL END,
        codex_thread_id=?,
        updated_at=?
      WHERE id=?
    `).run(fields.codexThreadId, fields.codexThreadId, fields.codexThreadId, fields.codexThreadId, new Date().toISOString(), id);
    if (fields.agentSelection !== undefined) this.sqlite.prepare("UPDATE conversations SET agent_model=?, reasoning_effort=?, updated_at=? WHERE id=?").run(
      fields.agentSelection.model, fields.agentSelection.reasoningEffort, new Date().toISOString(), id,
    );
    if (fields.status !== undefined) this.sqlite.prepare("UPDATE conversations SET status=?, updated_at=? WHERE id=?").run(fields.status, new Date().toISOString(), id);
  }

  markConversationResultSeenForUser(id: string, userId: string): ConversationRow | undefined {
    const conversation = this.getConversationForUser(id, userId);
    if (!conversation) return undefined;
    this.sqlite.prepare("UPDATE conversations SET has_unread_result=0,unread_anchor_message_id=NULL WHERE id=? AND user_id=? AND deleted_at IS NULL").run(id, userId);
    return this.getConversationForUser(id, userId);
  }

  archiveConversationForUser(id: string, userId: string): ConversationRow | undefined {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE conversations SET archived_at=?
      WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL
    `).run(now, id, userId);
    return result.changes ? this.getConversationForUser(id, userId) : undefined;
  }

  restoreConversationForUser(id: string, userId: string): ConversationRow | undefined {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE conversations SET archived_at=NULL,updated_at=?
      WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL
    `).run(now, id, userId);
    return result.changes ? this.getConversationForUser(id, userId) : undefined;
  }

  setConversationRolloutBytes(id: string, bytes: number | null): void {
    const normalized = bytes === null || !Number.isFinite(bytes) ? null : Math.max(0, Math.trunc(bytes));
    this.sqlite.prepare("UPDATE conversations SET rollout_bytes=? WHERE id=? AND deleted_at IS NULL").run(normalized, id);
  }

  setConversationContextUsage(id: string, usage: ContextTokenUsage): boolean {
    const inputTokens = Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
      ? Math.trunc(usage.inputTokens)
      : null;
    const modelContextWindow = typeof usage.modelContextWindow === "number"
      && Number.isFinite(usage.modelContextWindow)
      && usage.modelContextWindow > 0
      ? Math.trunc(usage.modelContextWindow)
      : null;
    if (!usage.threadId || inputTokens === null) return false;
    const result = this.sqlite.prepare(`
      UPDATE conversations SET context_input_tokens=?,context_window_tokens=?,context_usage_updated_at=?
      WHERE id=? AND codex_thread_id=? AND deleted_at IS NULL
    `).run(inputTokens, modelContextWindow, new Date().toISOString(), id, usage.threadId);
    return result.changes > 0;
  }

  setConversationCodexQuota(id: string, usage: CodexQuotaUsage): boolean {
    const remainingPercent = typeof usage.remainingPercent === "number" && Number.isFinite(usage.remainingPercent)
      ? Math.max(0, Math.min(100, usage.remainingPercent))
      : null;
    if (remainingPercent === null) return false;
    const conversation = this.getConversation(id);
    if (!conversation) return false;
    const scopeId = `user:${conversation.user_id}`;
    this.sqlite.prepare(`
      INSERT INTO codex_quota_snapshots(scope_id,remaining_percent,updated_at)
      VALUES(?,?,?)
      ON CONFLICT(scope_id) DO UPDATE SET remaining_percent=excluded.remaining_percent,updated_at=excluded.updated_at
    `).run(scopeId, remainingPercent, new Date().toISOString());
    return true;
  }

  getConversationCodexQuota(id: string): CodexQuotaSnapshot | null {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    const row = this.sqlite.prepare("SELECT remaining_percent,updated_at FROM codex_quota_snapshots WHERE scope_id=?")
      .get(`user:${conversation.user_id}`) as { remaining_percent: number; updated_at: string } | undefined;
    return row ? { remainingPercent: row.remaining_percent, updatedAt: row.updated_at } : null;
  }

  setAiConversationTitleIfDefault(id: string, title: string): boolean {
    return this.sqlite.prepare(`
      UPDATE conversations SET title=?,title_source='ai',updated_at=?
      WHERE id=? AND title_source='default' AND deleted_at IS NULL
    `).run(title, new Date().toISOString(), id).changes > 0;
  }

  createConversationTitleAudit(row: Omit<ConversationTitleAuditRow, "status" | "output_title" | "applied" | "error" | "completed_at" | "duration_ms">): ConversationTitleAuditRow {
    this.sqlite.prepare(`
      INSERT INTO conversation_title_audits(
        id,conversation_id,user_id,model,reasoning_effort,prompt_version,request_excerpt,request_sha256,
        context_json,status,output_title,applied,error,started_at,completed_at,duration_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,'running',NULL,0,NULL,?,NULL,NULL)
    `).run(row.id, row.conversation_id, row.user_id, row.model, row.reasoning_effort, row.prompt_version,
      row.request_excerpt, row.request_sha256, row.context_json, row.started_at);
    return this.getConversationTitleAudit(row.id)!;
  }

  finishConversationTitleAudit(id: string, result: { status: "succeeded" | "failed"; outputTitle?: string | null; applied?: boolean; error?: string | null; completedAt: string; durationMs: number }): ConversationTitleAuditRow | undefined {
    this.sqlite.prepare(`
      UPDATE conversation_title_audits SET status=?,output_title=?,applied=?,error=?,completed_at=?,duration_ms=?
      WHERE id=? AND status='running'
    `).run(result.status, result.outputTitle ?? null, result.applied ? 1 : 0, result.error?.slice(0, 2_000) ?? null,
      result.completedAt, Math.max(0, Math.trunc(result.durationMs)), id);
    return this.getConversationTitleAudit(id);
  }

  getConversationTitleAudit(id: string): ConversationTitleAuditRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversation_title_audits WHERE id=?").get(id) as ConversationTitleAuditRow | undefined;
  }

  getLatestConversationTitleAudit(conversationId: string): ConversationTitleAuditRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversation_title_audits WHERE conversation_id=? ORDER BY started_at DESC,id DESC LIMIT 1")
      .get(conversationId) as ConversationTitleAuditRow | undefined;
  }

  isFirstUserMessage(conversationId: string, messageId: string): boolean {
    const first = this.sqlite.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at,id LIMIT 1")
      .get(conversationId) as { id: string } | undefined;
    return first?.id === messageId;
  }

  softDeleteConversation(id: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE conversations SET status='idle',deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now, now, id);
  }

  isCodexThreadUsedByAnotherActiveConversation(threadId: string, conversationId: string): boolean {
    const row = this.sqlite.prepare("SELECT 1 AS found FROM conversations WHERE codex_thread_id=? AND id<>? AND deleted_at IS NULL LIMIT 1").get(threadId, conversationId) as { found: number } | undefined;
    return Boolean(row);
  }

  addMessage(message: MessageRow): void {
    this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,is_scheduled,created_at) VALUES(?,?,?,?,?,?,?)").run(
      message.id, message.conversation_id, message.role, message.content, message.quote_excerpt ?? null, message.is_scheduled ? 1 : 0, message.created_at,
    );
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(message.created_at, message.conversation_id);
  }

  getMessage(id: string): MessageRow | undefined {
    return this.sqlite.prepare("SELECT * FROM messages WHERE id=?").get(id) as MessageRow | undefined;
  }

  listMessages(conversationId: string): Array<MessageRow & { files: FileRow[] }> {
    const messages = this.sqlite.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as MessageRow[];
    const files = this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return messages.map((message) => ({
      ...message,
      files: files.filter((file) => file.message_id === message.id && (file.kind === "upload" || isDeliverablePath(file.relative_path))),
    }));
  }

  listMessagesPage(conversationId: string, beforeMessageId?: string, limit = 30): MessagePage | undefined {
    const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)));
    let newestFirst: MessageRow[];
    if (beforeMessageId) {
      const cursor = this.getMessage(beforeMessageId);
      if (!cursor || cursor.conversation_id !== conversationId) return undefined;
      newestFirst = this.sqlite.prepare(`
        SELECT * FROM messages
        WHERE conversation_id=? AND (created_at<? OR (created_at=? AND id<?))
        ORDER BY created_at DESC,id DESC LIMIT ?
      `).all(conversationId, cursor.created_at, cursor.created_at, cursor.id, pageSize + 1) as MessageRow[];
    } else {
      newestFirst = this.sqlite.prepare(`
        SELECT * FROM messages WHERE conversation_id=?
        ORDER BY created_at DESC,id DESC LIMIT ?
      `).all(conversationId, pageSize + 1) as MessageRow[];
    }

    const hasMore = newestFirst.length > pageSize;
    const messages = newestFirst.slice(0, pageSize).reverse();
    if (messages.length === 0) return { messages: [], hasMore: false, nextCursor: null };
    const placeholders = messages.map(() => "?").join(",");
    const files = this.sqlite.prepare(`
      SELECT * FROM files WHERE conversation_id=? AND message_id IN (${placeholders}) ORDER BY created_at,id
    `).all(conversationId, ...messages.map((message) => message.id)) as FileRow[];
    return {
      messages: messages.map((message) => ({
        ...message,
        files: files.filter((file) => file.message_id === message.id && (file.kind === "upload" || isDeliverablePath(file.relative_path))),
      })),
      hasMore,
      nextCursor: hasMore ? messages[0].id : null,
    };
  }

  addFile(file: FileRow): void {
    this.sqlite.prepare("INSERT INTO files(id,conversation_id,message_id,pending_prompt_id,composer_draft_id,original_name,relative_path,mime_type,size,sha256,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      file.id, file.conversation_id, file.message_id, file.pending_prompt_id ?? null, file.composer_draft_id ?? null, file.original_name, normalizeStoredRelativePath(file.relative_path), file.mime_type, file.size, file.sha256 ?? null, file.kind, file.created_at,
    );
  }

  createResumableUpload(input: Omit<ResumableUploadRow, "offset" | "state" | "completed_at">, maximumStoredBytes: number): ResumableUploadRow {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.sqlite.prepare("SELECT user_id,archived_at,deleted_at FROM conversations WHERE id=?").get(input.conversation_id) as { user_id: string; archived_at: string | null; deleted_at: string | null } | undefined;
      if (!conversation || conversation.user_id !== input.user_id || conversation.archived_at || conversation.deleted_at) throw new Error("Upload conversation ownership mismatch");
      if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("Upload size is invalid");
      const activeSlots = this.sqlite.prepare("SELECT count(*) AS value FROM resumable_uploads WHERE conversation_id=? AND state IN ('uploading','finalizing')").get(input.conversation_id) as { value: number };
      const draftSlots = this.sqlite.prepare("SELECT count(*) AS value FROM files WHERE composer_draft_id=?").get(input.conversation_id) as { value: number };
      if (Number(activeSlots.value) + Number(draftSlots.value) >= 12) throw new Error("DRAFT_FILE_LIMIT");
      const maximum = Number.isSafeInteger(maximumStoredBytes) && maximumStoredBytes >= 0 ? maximumStoredBytes : 0;
      if (this.sumStoredFileBytesForUser(input.user_id) + this.sumActiveResumableBytesForUser(input.user_id) + input.size > maximum) throw new StorageQuotaExceededError();
      this.sqlite.prepare(`
        INSERT INTO resumable_uploads(
          id,user_id,conversation_id,file_id,original_name,mime_type,size,offset,storage_name,final_name,state,created_at,updated_at,expires_at,completed_at
        ) VALUES(?,?,?,?,?,?,?,0,?,?,'uploading',?,?,?,NULL)
      `).run(
        input.id, input.user_id, input.conversation_id, input.file_id, input.original_name, input.mime_type,
        input.size, input.storage_name, input.final_name, input.created_at, input.updated_at, input.expires_at,
      );
      this.sqlite.exec("COMMIT");
      return this.getResumableUpload(input.id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getResumableUpload(id: string): ResumableUploadRow | undefined {
    return this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE id=?").get(id) as ResumableUploadRow | undefined;
  }

  getResumableUploadForUser(id: string, userId: string): ResumableUploadRow | undefined {
    return this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE id=? AND user_id=?").get(id, userId) as ResumableUploadRow | undefined;
  }

  listActiveResumableUploads(conversationId?: string): ResumableUploadRow[] {
    return (conversationId
      ? this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE conversation_id=? AND state IN ('uploading','finalizing') ORDER BY created_at,id").all(conversationId)
      : this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE state IN ('uploading','finalizing') ORDER BY created_at,id").all()) as ResumableUploadRow[];
  }

  listExpiredResumableUploads(now: string): ResumableUploadRow[] {
    return this.sqlite.prepare("SELECT * FROM resumable_uploads WHERE state IN ('uploading','finalizing') AND expires_at<=? ORDER BY expires_at,id").all(now) as ResumableUploadRow[];
  }

  sumActiveResumableBytesForUser(userId: string): number {
    const row = this.sqlite.prepare("SELECT COALESCE(sum(size),0) AS value FROM resumable_uploads WHERE user_id=? AND state IN ('uploading','finalizing')").get(userId) as { value: number };
    return Number(row.value);
  }

  updateResumableUploadOffset(id: string, offset: number, expiresAt: string): ResumableUploadRow | undefined {
    this.sqlite.prepare(`
      UPDATE resumable_uploads SET offset=?,updated_at=?,expires_at=?
      WHERE id=? AND state='uploading' AND ? BETWEEN offset AND size
    `).run(offset, new Date().toISOString(), expiresAt, id, offset);
    return this.getResumableUpload(id);
  }

  reconcileResumableUploadOffset(id: string, offset: number, expiresAt: string): ResumableUploadRow | undefined {
    this.sqlite.prepare(`
      UPDATE resumable_uploads SET offset=?,updated_at=?,expires_at=?
      WHERE id=? AND state='uploading' AND ? BETWEEN 0 AND size
    `).run(offset, new Date().toISOString(), expiresAt, id, offset);
    return this.getResumableUpload(id);
  }

  markResumableUploadFinalizing(id: string, offset: number): ResumableUploadRow | undefined {
    this.sqlite.prepare(`
      UPDATE resumable_uploads SET state='finalizing',offset=?,updated_at=?
      WHERE id=? AND state IN ('uploading','finalizing') AND size=?
    `).run(offset, new Date().toISOString(), id, offset);
    return this.getResumableUpload(id);
  }

  completeResumableUpload(id: string, file: FileRow, maximumStoredBytes: number): ResumableUploadRow {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const upload = this.getResumableUpload(id);
      if (!upload) throw new Error("Resumable upload does not exist");
      if (upload.state === "completed") {
        this.sqlite.exec("COMMIT");
        return upload;
      }
      if (upload.state !== "finalizing" || upload.offset !== upload.size || upload.file_id !== file.id || upload.conversation_id !== file.conversation_id) {
        throw new Error("Resumable upload finalization state mismatch");
      }
      const maximum = Number.isSafeInteger(maximumStoredBytes) && maximumStoredBytes >= 0 ? maximumStoredBytes : 0;
      if (this.sumStoredFileBytesForUser(upload.user_id) + this.sumActiveResumableBytesForUser(upload.user_id) > maximum) throw new StorageQuotaExceededError();
      this.ensureComposerDraft(upload.conversation_id);
      if (!this.getFile(file.id)) this.addFile(file);
      const now = new Date().toISOString();
      this.sqlite.prepare("UPDATE resumable_uploads SET state='completed',offset=size,updated_at=?,completed_at=? WHERE id=?").run(now, now, id);
      this.touchComposerDraft(upload.conversation_id);
      this.sqlite.exec("COMMIT");
      return this.getResumableUpload(id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  markResumableUploadTerminated(id: string, state: "cancelled" | "expired"): boolean {
    return this.sqlite.prepare(`
      UPDATE resumable_uploads SET state=?,updated_at=? WHERE id=? AND state IN ('uploading','finalizing')
    `).run(state, new Date().toISOString(), id).changes > 0;
  }

  deleteResumableUploadRecord(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM resumable_uploads WHERE id=? AND state NOT IN ('uploading','finalizing')").run(id).changes > 0;
  }

  deleteCompletedResumableUploadForFile(fileId: string): boolean {
    return this.sqlite.prepare("DELETE FROM resumable_uploads WHERE file_id=? AND state='completed'").run(fileId).changes > 0;
  }

  getFile(id: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT * FROM files WHERE id=?").get(id) as FileRow | undefined;
  }

  getFileForUser(id: string, userId: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT f.* FROM files f JOIN conversations c ON c.id=f.conversation_id WHERE f.id=? AND c.user_id=? AND c.deleted_at IS NULL").get(id, userId) as FileRow | undefined;
  }

  listFiles(conversationId?: string): FileRow[] {
    if (conversationId) return this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return this.sqlite.prepare("SELECT * FROM files ORDER BY created_at,id").all() as FileRow[];
  }

  listFilesForMessage(messageId: string): FileRow[] {
    return this.sqlite.prepare("SELECT * FROM files WHERE message_id=? ORDER BY created_at,id").all(messageId) as FileRow[];
  }

  getPublicFileShare(fileId: string): PublicFileShareRow | undefined {
    return this.sqlite.prepare("SELECT * FROM public_file_shares WHERE file_id=?").get(fileId) as PublicFileShareRow | undefined;
  }

  getActivePublicFile(fileId: string): { share: PublicFileShareRow; file: FileRow } | undefined {
    const share = this.getPublicFileShare(fileId);
    if (!share?.enabled) return undefined;
    const file = this.getFile(fileId);
    if (!file || file.kind !== "output") return undefined;
    const conversation = this.getConversation(file.conversation_id);
    const user = this.getUser(share.user_id);
    if (!conversation || conversation.user_id !== share.user_id || conversation.deleted_at || user?.status !== "active") return undefined;
    return { share, file };
  }

  listPublicFileShareAssets(shareId: string): PublicFileShareAssetRow[] {
    return this.sqlite.prepare("SELECT * FROM public_file_share_assets WHERE share_id=? ORDER BY source_ref,asset_file_id")
      .all(shareId) as PublicFileShareAssetRow[];
  }

  enablePublicFileShare(input: {
    id: string;
    file: FileRow;
    userId: string;
    assets: Array<{ sourceRef: string; assetFileId: string }>;
  }): PublicFileShareRow {
    const now = new Date().toISOString();
    const existing = this.getPublicFileShare(input.file.id);
    const shareId = existing?.id ?? input.id;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO public_file_shares(id,file_id,user_id,file_name_snapshot,enabled,created_at,enabled_at,disabled_at)
        VALUES(?,?,?,?,1,?,?,NULL)
        ON CONFLICT(file_id) DO UPDATE SET
          user_id=excluded.user_id,file_name_snapshot=excluded.file_name_snapshot,
          enabled=1,enabled_at=excluded.enabled_at,disabled_at=NULL
      `).run(shareId, input.file.id, input.userId, input.file.original_name, existing?.created_at ?? now, now);
      this.sqlite.prepare("DELETE FROM public_file_share_assets WHERE share_id=?").run(shareId);
      const insertAsset = this.sqlite.prepare(`
        INSERT INTO public_file_share_assets(share_id,asset_file_id,source_ref,created_at) VALUES(?,?,?,?)
      `);
      for (const asset of input.assets) insertAsset.run(shareId, asset.assetFileId, asset.sourceRef, now);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getPublicFileShare(input.file.id)!;
  }

  disablePublicFileShare(fileId: string, userId: string): PublicFileShareRow | undefined {
    const share = this.getPublicFileShare(fileId);
    if (!share || share.user_id !== userId) return undefined;
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE public_file_shares SET enabled=0,disabled_at=? WHERE file_id=? AND user_id=?")
      .run(now, fileId, userId);
    return this.getPublicFileShare(fileId);
  }

  recordPublicShareAccess(shareId: string, ipAddress: string, viewId: string, userAgent: string | null, accessedAt = new Date().toISOString()): boolean {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.sqlite.prepare(`
        INSERT OR IGNORE INTO public_share_access_events(id,share_id,ip_address,view_id,user_agent,accessed_at)
        VALUES(?,?,?,?,?,?)
      `).run(crypto.randomUUID(), shareId, ipAddress, viewId, userAgent, accessedAt).changes > 0;
      if (inserted) {
        this.sqlite.prepare(`
          INSERT INTO public_share_access_rollups(share_id,ip_address,first_accessed_at,last_accessed_at,access_count)
          VALUES(?,?,?,?,1)
          ON CONFLICT(share_id,ip_address) DO UPDATE SET
            last_accessed_at=excluded.last_accessed_at,
            access_count=public_share_access_rollups.access_count+1
        `).run(shareId, ipAddress, accessedAt, accessedAt);
      }
      this.sqlite.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  prunePublicShareAccessEvents(before: string): number {
    return Number(this.sqlite.prepare("DELETE FROM public_share_access_events WHERE accessed_at<?").run(before).changes);
  }

  updateFilePath(id: string, relativePath: string): void {
    this.sqlite.prepare("UPDATE files SET relative_path=? WHERE id=?").run(normalizeStoredRelativePath(relativePath), id);
  }

  ensureComposerDraft(conversationId: string): ComposerDraftWithFiles {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO composer_drafts(conversation_id,content,quote_excerpt,created_at,updated_at)
      VALUES(?,'',NULL,?,?) ON CONFLICT(conversation_id) DO NOTHING
    `).run(conversationId, now, now);
    return this.getComposerDraft(conversationId)!;
  }

  saveComposerDraft(conversationId: string, content: string, quoteExcerpt: string | null): ComposerDraftWithFiles | undefined {
    const existing = this.getComposerDraft(conversationId);
    if (!content && !quoteExcerpt && (!existing || existing.files.length === 0)) {
      if (existing) this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      return undefined;
    }
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO composer_drafts(conversation_id,content,quote_excerpt,created_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET content=excluded.content,quote_excerpt=excluded.quote_excerpt,updated_at=excluded.updated_at
    `).run(conversationId, content, quoteExcerpt, now, now);
    return this.getComposerDraft(conversationId);
  }

  getComposerDraft(conversationId: string): ComposerDraftWithFiles | undefined {
    const draft = this.sqlite.prepare("SELECT * FROM composer_drafts WHERE conversation_id=?").get(conversationId) as ComposerDraftRow | undefined;
    if (!draft) return undefined;
    const files = this.sqlite.prepare("SELECT * FROM files WHERE composer_draft_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return { ...draft, files };
  }

  deleteComposerDraft(conversationId: string): boolean {
    return this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId).changes > 0;
  }

  touchComposerDraft(conversationId: string): void {
    this.sqlite.prepare("UPDATE composer_drafts SET updated_at=? WHERE conversation_id=?").run(new Date().toISOString(), conversationId);
  }

  pruneEmptyComposerDraft(conversationId: string): void {
    this.sqlite.prepare(`
      DELETE FROM composer_drafts
      WHERE conversation_id=? AND content='' AND quote_excerpt IS NULL
        AND NOT EXISTS (SELECT 1 FROM files WHERE composer_draft_id=?)
    `).run(conversationId, conversationId);
  }

  materializeComposerDraftAsPending(
    pendingId: string,
    conversationId: string,
    content: string,
    selection: StoredAgentSelection,
    quoteExcerpt: string | null,
    status: PendingPromptRow["status"] = "queued",
  ): PendingPromptWithFiles {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),0)+1 AS value FROM pending_prompts WHERE conversation_id=? AND status='queued'").get(conversationId) as { value: number };
      this.sqlite.prepare(`
        INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,agent_model,reasoning_effort,position,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(pendingId, conversationId, content, quoteExcerpt, selection.model, selection.reasoningEffort, next.value, status, now, now);
      this.sqlite.prepare("UPDATE files SET pending_prompt_id=?,composer_draft_id=NULL WHERE conversation_id=? AND composer_draft_id=?")
        .run(pendingId, conversationId, conversationId);
      this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getPendingPrompt(pendingId)!;
  }

  materializeComposerDraftAsJob(
    messageId: string,
    jobId: string,
    conversationId: string,
    content: string,
    selection: StoredAgentSelection,
    quoteExcerpt: string | null,
  ): JobRow {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'user',?,?,?)")
        .run(messageId, conversationId, content, quoteExcerpt, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,composer_draft_id=NULL WHERE conversation_id=? AND composer_draft_id=?")
        .run(messageId, conversationId, conversationId);
      this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, conversationId, messageId, selection.model, selection.reasoningEffort, next.value, now, now);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId)!;
  }

  createPendingPrompt(id: string, conversationId: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null): PendingPromptWithFiles {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),0)+1 AS value FROM pending_prompts WHERE conversation_id=? AND status='queued'").get(conversationId) as { value: number };
    this.sqlite.prepare(`
      INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,agent_model,reasoning_effort,position,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)
    `).run(id, conversationId, content, quoteExcerpt, selection.model, selection.reasoningEffort, next.value, now, now);
    return this.getPendingPrompt(id)!;
  }

  getPendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare("SELECT * FROM pending_prompts WHERE id=?").get(id) as PendingPromptRow | undefined;
    if (!prompt) return undefined;
    const files = this.sqlite.prepare("SELECT * FROM files WHERE pending_prompt_id=? ORDER BY created_at,id").all(id) as FileRow[];
    return { ...prompt, files };
  }

  getPendingPromptForUser(id: string, userId: string): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
    `).get(id, userId) as PendingPromptRow | undefined;
    if (!prompt) return undefined;
    return { ...prompt, files: this.sqlite.prepare("SELECT * FROM files WHERE pending_prompt_id=? ORDER BY created_at,id").all(id) as FileRow[] };
  }

  listPendingPrompts(conversationId: string, status: PendingPromptRow["status"] = "queued"): PendingPromptWithFiles[] {
    const prompts = this.sqlite.prepare("SELECT * FROM pending_prompts WHERE conversation_id=? AND status=? ORDER BY position,id").all(conversationId, status) as PendingPromptRow[];
    const files = this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? AND pending_prompt_id IS NOT NULL ORDER BY created_at,id").all(conversationId) as FileRow[];
    return prompts.map((prompt) => ({ ...prompt, files: files.filter((file) => file.pending_prompt_id === prompt.id) }));
  }

  beginEditingPendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const prompt = this.getPendingPrompt(id);
    if (!prompt || prompt.status !== "queued") return undefined;
    this.sqlite.prepare("UPDATE pending_prompts SET status='editing',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    return this.getPendingPrompt(id);
  }

  restorePendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE pending_prompts SET status='queued',updated_at=? WHERE id=? AND status='editing'").run(now, id);
    return this.getPendingPrompt(id);
  }

  updatePendingPrompt(id: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null): PendingPromptWithFiles | undefined {
    const result = this.sqlite.prepare(`
      UPDATE pending_prompts SET content=?,quote_excerpt=?,agent_model=?,reasoning_effort=?,status='queued',updated_at=? WHERE id=?
    `).run(content, quoteExcerpt, selection.model, selection.reasoningEffort, new Date().toISOString(), id);
    return result.changes ? this.getPendingPrompt(id) : undefined;
  }

  updateEditingPendingPrompt(id: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null): PendingPromptWithFiles | undefined {
    const result = this.sqlite.prepare(`
      UPDATE pending_prompts SET content=?,quote_excerpt=?,agent_model=?,reasoning_effort=?,updated_at=? WHERE id=? AND status='editing'
    `).run(content, quoteExcerpt, selection.model, selection.reasoningEffort, new Date().toISOString(), id);
    return result.changes ? this.getPendingPrompt(id) : undefined;
  }

  reorderPendingPrompts(conversationId: string, orderedIds: string[]): PendingPromptWithFiles[] {
    const current = this.listPendingPrompts(conversationId, "queued").map((prompt) => prompt.id);
    if (current.length !== orderedIds.length || new Set(current).size !== new Set(orderedIds).size || current.some((id) => !orderedIds.includes(id))) {
      throw new Error("待发送队列已经变化，请刷新后重试");
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sqlite.prepare("UPDATE pending_prompts SET position=?,updated_at=? WHERE id=? AND conversation_id=? AND status='queued'");
      const now = new Date().toISOString();
      orderedIds.forEach((id, index) => update.run(index + 1, now, id, conversationId));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.listPendingPrompts(conversationId);
  }

  removeFile(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM files WHERE id=?").run(id).changes > 0;
  }

  deletePendingPrompt(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(id).changes > 0;
  }

  deletePendingPromptsForConversation(conversationId: string): number {
    return Number(this.sqlite.prepare("DELETE FROM pending_prompts WHERE conversation_id=?").run(conversationId).changes);
  }

  createWakePlan(input: {
    id: string;
    conversationId: string;
    createdByJobId?: string | null;
    mode: WakePlanMode;
    label: string;
    runId?: string | null;
    deadlineAt: string;
    successPrompt: string;
    failurePrompt: string;
    timeoutPrompt: string;
    newConversation?: boolean;
    selection: StoredAgentSelection;
    eventTokenHash?: string | null;
  }): WakePlanRow {
    const sourceConversation = this.getConversation(input.conversationId);
    if (!sourceConversation || sourceConversation.deleted_at || sourceConversation.archived_at) throw new Error("会话不存在或已归档");
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      let planConversation = sourceConversation;
      let targetConversationId: string | null = null;
      if (input.newConversation) {
        planConversation = this.createConversation(
          crypto.randomUUID(), continuationConversationTitle(input.label), input.selection, sourceConversation.user_id,
        );
        targetConversationId = planConversation.id;
        this.sqlite.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(planConversation.id);
      }
      this.sqlite.prepare(`
        INSERT INTO wake_plans(
          id,conversation_id,created_by_job_id,mode,state,label,run_id,deadline_at,
          success_prompt,failure_prompt,timeout_prompt,new_conversation,target_conversation_id,
          agent_model,reasoning_effort,event_token_hash,created_at,updated_at
        ) VALUES(?,?,?,?,'armed',?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        input.id, planConversation.id, input.createdByJobId ?? null, input.mode, input.label,
        input.runId ?? null, input.deadlineAt, input.successPrompt, input.failurePrompt, input.timeoutPrompt,
        input.newConversation ? 1 : 0, targetConversationId, input.selection.model, input.selection.reasoningEffort,
        input.eventTokenHash ?? null, now, now,
      );
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, planConversation.id);
      this.sqlite.exec("COMMIT");
      return this.getWakePlan(input.id)!;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getWakePlan(id: string): WakePlanRow | undefined {
    return this.sqlite.prepare("SELECT * FROM wake_plans WHERE id=?").get(id) as WakePlanRow | undefined;
  }

  getWakePlanForUser(id: string, userId: string): WakePlanRow | undefined {
    return this.sqlite.prepare(`
      SELECT wake.* FROM wake_plans wake
      JOIN conversations conversation ON conversation.id=wake.conversation_id
      WHERE wake.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
    `).get(id, userId) as WakePlanRow | undefined;
  }

  getActiveWakePlan(conversationId: string): WakePlanRow | undefined {
    return this.sqlite.prepare("SELECT * FROM wake_plans WHERE conversation_id=? AND state='armed' ORDER BY created_at DESC,id DESC LIMIT 1")
      .get(conversationId) as WakePlanRow | undefined;
  }

  listDueWakePlans(now: string, limit = 100): WakePlanRow[] {
    return this.sqlite.prepare(`
      SELECT wake.* FROM wake_plans wake
      JOIN conversations conversation ON conversation.id=wake.conversation_id
      WHERE wake.state='armed' AND wake.deadline_at<=? AND conversation.deleted_at IS NULL AND conversation.archived_at IS NULL
      ORDER BY wake.deadline_at,wake.id LIMIT ?
    `).all(now, Math.max(1, Math.min(500, Math.trunc(limit)))) as WakePlanRow[];
  }

  listWakeEvents(wakePlanId: string, limit = 100): WakeEventRow[] {
    return this.sqlite.prepare("SELECT * FROM wake_events WHERE wake_plan_id=? ORDER BY created_at,event_id LIMIT ?")
      .all(wakePlanId, Math.max(1, Math.min(500, Math.trunc(limit)))) as WakeEventRow[];
  }

  cancelWakePlan(id: string): WakePlanRow | undefined {
    const plan = this.getWakePlan(id);
    if (!plan || plan.state !== "armed") return undefined;
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE wake_plans SET state='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND state='armed'")
      .run(now, now, id);
    if (!result.changes) return undefined;
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, plan.conversation_id);
    return this.getWakePlan(id);
  }

  cancelArmedWakePlansForConversation(conversationId: string): number {
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE wake_plans SET state='cancelled',cancelled_at=?,updated_at=?
      WHERE conversation_id=? AND state='armed'
    `).run(now, now, conversationId);
    if (result.changes) this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    return Number(result.changes);
  }

  rescheduleWakePlan(id: string, deadlineAt: string): WakePlanRow | undefined {
    const plan = this.getWakePlan(id);
    if (!plan || plan.state !== "armed") return undefined;
    const now = new Date().toISOString();
    const result = this.sqlite.prepare("UPDATE wake_plans SET deadline_at=?,updated_at=? WHERE id=? AND state='armed'")
      .run(deadlineAt, now, id);
    if (!result.changes) return undefined;
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, plan.conversation_id);
    return this.getWakePlan(id);
  }

  updateWakePlanPrompts(input: {
    id: string;
    expectedRevision: number;
    successPrompt: string;
    failurePrompt: string;
    timeoutPrompt: string;
  }): WakePlanRow | undefined {
    const plan = this.getWakePlan(input.id);
    if (!plan || plan.state !== "armed") return undefined;
    const now = new Date().toISOString();
    const result = this.sqlite.prepare(`
      UPDATE wake_plans
      SET success_prompt=?,failure_prompt=?,timeout_prompt=?,revision=revision+1,updated_at=?
      WHERE id=? AND state='armed' AND revision=?
    `).run(input.successPrompt, input.failurePrompt, input.timeoutPrompt, now, input.id, input.expectedRevision);
    if (!result.changes) return undefined;
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, plan.conversation_id);
    return this.getWakePlan(input.id);
  }

  recordWakeEvent(
    wakePlanId: string,
    eventId: string,
    kind: WakeEventKind,
    summary: string | null,
    pendingPromptId: string,
  ): WakeTriggerResult {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.getWakePlan(wakePlanId);
      if (!plan) { this.sqlite.exec("COMMIT"); return { status: "missing" }; }
      const duplicate = this.sqlite.prepare("SELECT 1 AS found FROM wake_events WHERE wake_plan_id=? AND event_id=?")
        .get(wakePlanId, eventId) as { found: number } | undefined;
      if (duplicate) { this.sqlite.exec("COMMIT"); return { status: "duplicate", plan }; }
      if (plan.state !== "armed") { this.sqlite.exec("COMMIT"); return { status: "stale", plan }; }
      this.sqlite.prepare("INSERT INTO wake_events(wake_plan_id,event_id,kind,summary,accepted,created_at) VALUES(?,?,?,?,0,?)")
        .run(wakePlanId, eventId, kind, summary, now);
      if (kind === "heartbeat") {
        this.sqlite.prepare(`
          UPDATE wake_plans SET last_heartbeat_at=?,last_event_at=?,last_event_kind=?,last_event_summary=?,updated_at=? WHERE id=?
        `).run(now, now, kind, summary, now, wakePlanId);
        this.sqlite.prepare("UPDATE wake_events SET accepted=1 WHERE wake_plan_id=? AND event_id=?").run(wakePlanId, eventId);
        this.sqlite.exec("COMMIT");
        return { status: "heartbeat", plan: this.getWakePlan(wakePlanId) };
      }
      const cause = kind as WakeTriggerCause;
      const prompt = cause === "success" ? plan.success_prompt
        : cause === "failure" ? plan.failure_prompt
        : plan.mode === "time" ? plan.success_prompt : plan.timeout_prompt;
      const targetConversation = plan.target_conversation_id
        ? this.getConversation(plan.target_conversation_id)
        : this.getConversation(plan.conversation_id);
      if (!targetConversation || targetConversation.deleted_at || targetConversation.archived_at) throw new Error("等待计划的目标会话不存在或已归档");
      this.sqlite.prepare("UPDATE pending_prompts SET position=position+1 WHERE conversation_id=? AND status='queued'")
        .run(targetConversation.id);
      this.sqlite.prepare(`
        INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,agent_model,reasoning_effort,position,status,created_at,updated_at)
        VALUES(?,?,?,NULL,?,?,?,'queued',?,?)
      `).run(pendingPromptId, targetConversation.id, prompt, plan.agent_model, plan.reasoning_effort, 1, now, now);
      this.sqlite.prepare(`
        UPDATE wake_plans SET state='triggered',trigger_cause=?,triggered_at=?,pending_prompt_id=?,
          last_event_at=?,last_event_kind=?,last_event_summary=?,updated_at=?
        WHERE id=? AND state='armed'
      `).run(cause, now, pendingPromptId, now, kind, summary, now, wakePlanId);
      this.sqlite.prepare("UPDATE wake_events SET accepted=1 WHERE wake_plan_id=? AND event_id=?").run(wakePlanId, eventId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, targetConversation.id);
      this.sqlite.exec("COMMIT");
      return { status: "triggered", plan: this.getWakePlan(wakePlanId), pendingPrompt: this.getPendingPrompt(pendingPromptId), targetConversation };
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getNextDispatchablePendingPrompt(): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.status='queued' AND conversation.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.conversation_id=pending.conversation_id AND active.status IN ('queued','running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM wake_plans wake
          WHERE wake.conversation_id=pending.conversation_id AND wake.state='armed'
        )
      -- Position is the user-controlled order within each conversation. Putting
      -- it first is essential: created_at would otherwise make drag reordering
      -- cosmetic while the original insertion order kept dispatching.
      ORDER BY pending.position,pending.created_at,pending.id
      LIMIT 1
    `).get() as PendingPromptRow | undefined;
    return prompt ? this.getPendingPrompt(prompt.id) : undefined;
  }

  materializePendingPrompt(pendingId: string, messageId: string, jobId: string): JobRow | undefined {
    const prompt = this.getPendingPrompt(pendingId);
    if (!prompt || prompt.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const scheduled = this.sqlite.prepare("SELECT 1 AS value FROM wake_plans WHERE pending_prompt_id=? AND state='triggered'").get(pendingId) as { value: number } | undefined;
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,is_scheduled,created_at) VALUES(?,?,'user',?,?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, scheduled ? 1 : 0, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, prompt.conversation_id, messageId, prompt.agent_model, prompt.reasoning_effort, next.value, now, now);
      this.sqlite.prepare("UPDATE wake_plans SET job_id=?,pending_prompt_id=NULL,updated_at=? WHERE pending_prompt_id=?")
        .run(jobId, now, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, prompt.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId);
  }

  materializeSteeredPrompt(pendingId: string, messageId: string): MessageRow | undefined {
    const prompt = this.getPendingPrompt(pendingId);
    if (!prompt || prompt.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'user',?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, prompt.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getMessage(messageId);
  }

  getAgentSelectionPreference(userId = LEGACY_USER_ID): StoredAgentSelection | undefined {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='agent_selection'").get(userId) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value) as Partial<StoredAgentSelection>;
      if (typeof value.model === "string" && typeof value.reasoningEffort === "string") return { model: value.model, reasoningEffort: value.reasoningEffort };
    } catch {
      // Invalid or manually edited preference is repaired by the caller.
    }
    return undefined;
  }

  setAgentSelectionPreference(selection: StoredAgentSelection, userId = LEGACY_USER_ID): void {
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'agent_selection',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, JSON.stringify(selection), new Date().toISOString());
  }

  getChatFontSize(userId = LEGACY_USER_ID): number {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='chat_font_size'").get(userId) as { value: string } | undefined;
    return normalizeChatFontSize(row?.value, CHAT_FONT_SIZE_DEFAULT);
  }

  setChatFontSize(value: unknown, userId = LEGACY_USER_ID): number {
    const fontSize = normalizeChatFontSize(value, CHAT_FONT_SIZE_DEFAULT);
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'chat_font_size',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, String(fontSize), new Date().toISOString());
    return fontSize;
  }

  createJob(id: string, conversationId: string, messageId?: string, selection?: StoredAgentSelection): JobRow {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
    this.sqlite.prepare("INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(
      id, conversationId, messageId ?? null, selection?.model ?? null, selection?.reasoningEffort ?? null, next.value, now, now,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
  }

  getJobForUser(id: string, userId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=? AND c.user_id=? AND c.deleted_at IS NULL").get(id, userId) as JobRow | undefined;
  }

  getRunningJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  runningJobCount(): number {
    return Number((this.sqlite.prepare("SELECT count(1) AS count FROM jobs WHERE status='running'").get() as { count: number }).count);
  }

  getNextQueuedJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND c.deleted_at IS NULL ORDER BY j.queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  getNextRunnableQueuedJob(): JobRow | undefined {
    return this.sqlite.prepare(`
      SELECT queued.* FROM jobs queued JOIN conversations conversation ON conversation.id=queued.conversation_id
      WHERE queued.status='queued'
        AND conversation.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs running
          WHERE running.conversation_id=queued.conversation_id AND running.status='running'
        )
      ORDER BY queued.queue_seq
      LIMIT 1
    `).get() as JobRow | undefined;
  }

  listQueuedJobs(): JobRow[] {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND c.deleted_at IS NULL ORDER BY j.queue_seq").all() as JobRow[];
  }

  getActiveJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status IN ('running','queued') AND c.deleted_at IS NULL ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END,j.queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  sumStoredFileBytesForUser(userId: string): number {
    const row = this.sqlite.prepare(`
      SELECT COALESCE(sum(file.size),0) AS value FROM files file
      JOIN conversations conversation ON conversation.id=file.conversation_id
      WHERE conversation.user_id=?
    `).get(userId) as { value: number };
    return Number(row.value);
  }

  getActiveJobForConversation(conversationId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId) as JobRow | undefined;
  }

  listActiveJobsForConversation(conversationId: string): JobRow[] {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running') ORDER BY queue_seq,id").all(conversationId) as JobRow[];
  }

  getLatestJobForConversation(conversationId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId) as JobRow | undefined;
  }

  getQueuePosition(jobId: string): number | undefined {
    const job = this.getJob(jobId);
    if (!job || !["queued", "running"].includes(job.status)) return undefined;
    if (job.status === "running") return 0;
    const row = this.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM jobs WHERE conversation_id=? AND status='running') +
        (SELECT COUNT(*) FROM jobs WHERE conversation_id=? AND status='queued' AND queue_seq<=?) AS position
    `).get(job.conversation_id, job.conversation_id, job.queue_seq) as { position: number };
    return row.position;
  }

  updateJob(id: string, status: JobStatus, error: string | null = null): void {
    this.sqlite.prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?").run(status, error, new Date().toISOString(), id);
  }

  cancelQueuedJob(id: string): boolean {
    const result = this.sqlite.prepare("UPDATE jobs SET status='cancelled',error='任务已停止',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  finishJob(id: string, conversationId: string, status: Exclude<JobStatus, "queued" | "running">, error: string | null = null): void {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?").run(status, error, now, id);
      this.sqlite.prepare(`
        UPDATE conversations
        SET status='idle',
          has_unread_result=CASE WHEN ?='completed' THEN 1 ELSE has_unread_result END,
          unread_anchor_message_id=CASE WHEN ?='completed' THEN COALESCE(
            unread_anchor_message_id,
            (
              SELECT assistant.id
              FROM messages assistant
              JOIN jobs job ON job.id=?
              JOIN messages user_message ON user_message.id=job.message_id
              WHERE assistant.conversation_id=? AND assistant.role='assistant'
                AND (assistant.created_at>user_message.created_at OR (assistant.created_at=user_message.created_at AND assistant.id>user_message.id))
              ORDER BY assistant.created_at,assistant.id LIMIT 1
            )
          ) ELSE unread_anchor_message_id END,
          updated_at=?
        WHERE id=?
      `).run(status, status, id, conversationId, now, conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(jobId: string, eventType: string, payload: unknown): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE job_id=?").get(jobId) as { seq: number };
    const now = new Date().toISOString();
    this.sqlite.prepare("INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)").run(jobId, row.seq, eventType, JSON.stringify(payload), now);
    this.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(now, jobId);
    return row.seq;
  }

  listEvents(jobId: string, after = 0): JobEventRow[] {
    return this.sqlite.prepare("SELECT seq,event_type,payload,created_at FROM job_events WHERE job_id=? AND seq>? ORDER BY seq").all(jobId, after) as JobEventRow[];
  }

  createSession(tokenHash: string, csrfToken: string, expiresAt: string, userId = LEGACY_USER_ID): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
    this.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)").run(tokenHash, userId, csrfToken, now, expiresAt);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    return this.sqlite.prepare(`
      SELECT s.token_hash,s.csrf_token,s.expires_at,s.user_id,u.username,u.display_name,u.role
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
    `).get(tokenHash, new Date().toISOString()) as SessionRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }

  close(): void {
    this.sqlite.close();
  }
}

function continuationConversationTitle(label: string): string {
  const normalized = label.trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized ? `${normalized} · 续跑` : "自动续跑";
}
