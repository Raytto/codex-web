import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { isDeliverablePath, normalizeStoredRelativePath, normalizeUploadFileName } from "./paths.js";

export const LEGACY_USER_ID = "00000000-0000-4000-8000-000000000001";

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
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ConversationTitleSource = "default" | "ai" | "manual" | "legacy";

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  quote_excerpt?: string | null;
  created_at: string;
};

export type FileRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  pending_prompt_id?: string | null;
  original_name: string;
  relative_path: string;
  mime_type: string;
  size: number;
  kind: "upload" | "output";
  created_at: string;
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

type LegacyUserSeed = { username: string; passwordHash: string; displayName?: string };

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(dataRoot: string, legacyUser: LegacyUserSeed = { username: "owner", passwordHash: "", displayName: "Owner" }, recoverJobs = true) {
    fs.mkdirSync(dataRoot, { recursive: true });
    this.sqlite = new DatabaseSync(path.join(dataRoot, "codex-web.sqlite"));
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate(legacyUser);
    if (recoverJobs) {
      // A running child process cannot survive an application restart. Queued work is
      // deliberately retained and the queue pump will resume it in FIFO order.
      this.sqlite.prepare("UPDATE jobs SET status='interrupted', error=COALESCE(error,'服务重启，原运行任务已中断'), updated_at=? WHERE status='running'").run(new Date().toISOString());
      this.sqlite.prepare("UPDATE conversations SET status='idle' WHERE status='running'").run();
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
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
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
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
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
    `);

    const conversationColumns = this.columnNames("conversations");
    if (!conversationColumns.has("user_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id)");
    if (!conversationColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN agent_model TEXT");
    if (!conversationColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT");
    if (!conversationColumns.has("deleted_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN deleted_at TEXT");
    if (!conversationColumns.has("title_source")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'");
    const messageColumns = this.columnNames("messages");
    if (!messageColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN quote_excerpt TEXT");
    const pendingPromptColumns = this.columnNames("pending_prompts");
    if (!pendingPromptColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN quote_excerpt TEXT");
    const sessionColumns = this.columnNames("sessions");
    if (!sessionColumns.has("user_id")) this.sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
    const jobColumns = this.columnNames("jobs");
    if (!jobColumns.has("message_id")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
    if (!jobColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN agent_model TEXT");
    if (!jobColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN reasoning_effort TEXT");
    if (!jobColumns.has("queue_seq")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN queue_seq INTEGER");
    const fileColumns = this.columnNames("files");
    if (!fileColumns.has("pending_prompt_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE");
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
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_conversation_idx ON files(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_pending_prompt_idx ON files(pending_prompt_id, created_at);
      CREATE INDEX IF NOT EXISTS pending_prompts_queue_idx ON pending_prompts(conversation_id, status, position);
      CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, queue_seq);
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
    if (userId) return this.sqlite.prepare("SELECT * FROM conversations WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC").all(userId) as ConversationRow[];
    return this.sqlite.prepare("SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC").all() as ConversationRow[];
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversations WHERE id=?").get(id) as ConversationRow | undefined;
  }

  getConversationForUser(id: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare("SELECT * FROM conversations WHERE id=? AND user_id=? AND deleted_at IS NULL").get(id, userId) as ConversationRow | undefined;
  }

  createConversation(id: string, title: string, selection?: StoredAgentSelection, userId = LEGACY_USER_ID): ConversationRow {
    const now = new Date().toISOString();
    this.sqlite.prepare("INSERT INTO conversations(id,user_id,title,title_source,agent_model,reasoning_effort,status,created_at,updated_at) VALUES(?,?,?,'default',?,?,'idle',?,?)").run(
      id, userId, title, selection?.model ?? null, selection?.reasoningEffort ?? null, now, now,
    );
    return this.getConversation(id)!;
  }

  updateConversation(id: string, fields: { title?: string; titleSource?: ConversationTitleSource; codexThreadId?: string; agentSelection?: StoredAgentSelection; status?: "idle" | "running" }): void {
    if (fields.title !== undefined) this.sqlite.prepare("UPDATE conversations SET title=?, title_source=COALESCE(?,title_source), updated_at=? WHERE id=?")
      .run(fields.title, fields.titleSource ?? null, new Date().toISOString(), id);
    if (fields.codexThreadId !== undefined) this.sqlite.prepare("UPDATE conversations SET codex_thread_id=?, updated_at=? WHERE id=?").run(fields.codexThreadId, new Date().toISOString(), id);
    if (fields.agentSelection !== undefined) this.sqlite.prepare("UPDATE conversations SET agent_model=?, reasoning_effort=?, updated_at=? WHERE id=?").run(
      fields.agentSelection.model, fields.agentSelection.reasoningEffort, new Date().toISOString(), id,
    );
    if (fields.status !== undefined) this.sqlite.prepare("UPDATE conversations SET status=?, updated_at=? WHERE id=?").run(fields.status, new Date().toISOString(), id);
  }

  setAiConversationTitleIfDefault(id: string, title: string): boolean {
    return this.sqlite.prepare(`
      UPDATE conversations SET title=?,title_source='ai',updated_at=?
      WHERE id=? AND title_source='default' AND deleted_at IS NULL
    `).run(title, new Date().toISOString(), id).changes > 0;
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
    this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,?,?,?,?)").run(
      message.id, message.conversation_id, message.role, message.content, message.quote_excerpt ?? null, message.created_at,
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
    this.sqlite.prepare("INSERT INTO files(id,conversation_id,message_id,pending_prompt_id,original_name,relative_path,mime_type,size,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      file.id, file.conversation_id, file.message_id, file.pending_prompt_id ?? null, file.original_name, normalizeStoredRelativePath(file.relative_path), file.mime_type, file.size, file.kind, file.created_at,
    );
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

  updateFilePath(id: string, relativePath: string): void {
    this.sqlite.prepare("UPDATE files SET relative_path=? WHERE id=?").run(normalizeStoredRelativePath(relativePath), id);
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

  getNextDispatchablePendingPrompt(): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.status='queued' AND conversation.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.conversation_id=pending.conversation_id AND active.status IN ('queued','running')
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
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'user',?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, prompt.conversation_id, messageId, prompt.agent_model, prompt.reasoning_effort, next.value, now, now);
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
      this.sqlite.prepare("UPDATE conversations SET status='idle', updated_at=? WHERE id=?").run(now, conversationId);
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
