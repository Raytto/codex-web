import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { HOST_ROOT_USER_ID } from "./host-root-user.js";
import type { ConversationStorageState } from "./db.js";

export const COLD_STORAGE_FORMAT = "conversation-cold-storage-v2";
const LEGACY_COLD_STORAGE_FORMAT = "conversation-cold-storage-v1";
export const COLD_STORAGE_DRIVE_ID = "";
export const COLD_STORAGE_AGE_RECIPIENT = "";
export const COLD_STORAGE_AGE_IDENTITY = "";
const DEFAULT_STATE_ROOT = process.env.CODEX_WEB_STATE_ROOT || path.join(process.cwd(), ".state");
export const COLD_STORAGE_RELAY_DIR = path.join(DEFAULT_STATE_ROOT, "cold-storage", "relay");
export const COLD_STORAGE_DOWNLOAD_DIR = path.join(DEFAULT_STATE_ROOT, "cold-storage", "downloads");
export const COLD_STORAGE_REMOTE_ROOT = process.env.CODEX_WEB_COLD_STORAGE_REMOTE_ROOT || "/codex-web/conversations";
export const VOICE_RECORDING_REMOTE_ROOT = process.env.CODEX_WEB_VOICE_REMOTE_ROOT || "/codex-web/voice-recordings";
const DAY_MS = 24 * 60 * 60 * 1_000;

type StorageDbRow = {
  conversation_id: string;
  user_id: string;
  project_id: string | null;
  codex_thread_id: string | null;
  title: string;
  status: string;
  external_status: string;
  deleted_at: string | null;
  deletion_state: string;
  archived_at: string | null;
  last_active_at: string | null;
  executor_id: string | null;
  storage_state: ConversationStorageState;
  generation: number;
  revision: number;
  manifest_json: string | null;
  manifest_sha256: string | null;
  archive_sha256: string | null;
  archive_bytes: number | null;
  plaintext_bytes: number | null;
  remote_drive_id: string | null;
  remote_path: string | null;
  local_isolated_path: string | null;
  retry_count: number;
  last_error: string | null;
};

type FileRow = {
  id: string;
  relative_path: string;
  mime_type: string;
  kind: "upload" | "output";
  size: number;
};

export type ColdManifestEntry = {
  // v1 called every data-root member a deliverable. v2 also stores
  // conversation-workspace uploads and outputs.
  kind: "rollout" | "file" | "deliverable";
  root: "codexHome" | "dataRoot" | "conversation";
  relativePath: string;
  size: number;
  sha256: string;
};

export type ColdManifest = {
  format: typeof COLD_STORAGE_FORMAT | typeof LEGACY_COLD_STORAGE_FORMAT;
  conversationId: string;
  userId: string;
  threadId: string;
  generation: number;
  createdAt: string;
  plaintextBytes: number;
  entries: ColdManifestEntry[];
};

export type ColdStorageRoots = {
  dataRoot: string;
  tenantRoot: string;
  hostRootCodexHome: string;
  databasePath: string;
  aliyunpan: string;
  age: string;
  relayDir: string;
  downloadDir: string;
  remoteRoot: string;
  driveId: string;
  ageRecipient: string;
  ageIdentity: string;
  isolationRoot: string;
  voiceIsolationRoot: string;
};

export type ColdCandidate = {
  conversationId: string;
  userId: string;
  title: string;
  lastActiveAt: string | null;
  ageHours: number;
  state: ConversationStorageState;
  drawing: boolean;
  eligible: boolean;
  reasons: string[];
  rolloutBytes: number;
  deliverableBytes: number;
  sharedFiles: number;
  entries: number;
  archived: boolean;
};

export type ColdArchiveResult = {
  conversationId: string;
  generation: number;
  archiveBytes: number;
  plaintextBytes: number;
  archiveSha256: string;
  manifestSha256: string;
  remotePath: string;
  isolatedPath: string;
};

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`Invalid ${label}`);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const input = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    do {
      read = fs.readSync(input, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally { fs.closeSync(input); }
  return hash.digest("hex");
}

function fileSha256(filePath: string): string { return sha256File(filePath); }

function safeRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("冷存储清单包含不安全路径");
  }
  return normalized;
}

function openDb(databasePath: string): DatabaseSync {
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
  return sqlite;
}

function rowForConversation(sqlite: DatabaseSync, conversationId: string, userId?: string): StorageDbRow | undefined {
  const row = sqlite.prepare(`
    SELECT c.id AS conversation_id,c.user_id,c.project_id,c.codex_thread_id,c.title,c.status,c.external_status,
      c.deleted_at,c.deletion_state,c.archived_at,c.last_active_at,p.executor_id,
      COALESCE(s.state,'local') AS storage_state,COALESCE(s.generation,0) AS generation,
      COALESCE(s.revision,0) AS revision,s.manifest_json,s.manifest_sha256,s.archive_sha256,s.archive_bytes,
      s.plaintext_bytes,s.remote_drive_id,s.remote_path,s.local_isolated_path,COALESCE(s.retry_count,0) AS retry_count,s.last_error
    FROM conversations c
    LEFT JOIN projects p ON p.id=c.project_id
    LEFT JOIN conversation_storage s ON s.conversation_id=c.id
    WHERE c.id=? ${userId ? "AND c.user_id=?" : ""}
  `).get(...(userId ? [conversationId, userId] : [conversationId])) as StorageDbRow | undefined;
  return row;
}

function fileRows(sqlite: DatabaseSync, conversationId: string): FileRow[] {
  return sqlite.prepare("SELECT id,relative_path,mime_type,kind,size FROM files WHERE conversation_id=? ORDER BY id").all(conversationId) as FileRow[];
}

function sharedFileIds(sqlite: DatabaseSync, conversationId: string): Set<string> {
  const rows = sqlite.prepare(`
    SELECT DISTINCT f.id FROM files f
    LEFT JOIN public_file_shares share ON share.file_id=f.id AND share.enabled=1
    LEFT JOIN public_file_share_assets asset ON asset.asset_file_id=f.id
    WHERE f.conversation_id=? AND (share.file_id IS NOT NULL OR asset.asset_file_id IS NOT NULL)
  `).all(conversationId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function codexHomeFor(roots: ColdStorageRoots, userId: string): string {
  assertUuid(userId, "user id");
  return userId === HOST_ROOT_USER_ID ? roots.hostRootCodexHome : path.join(roots.tenantRoot, userId, "codex-home");
}

function conversationWorkspaceFor(roots: ColdStorageRoots, userId: string, conversationId: string): string {
  assertUuid(userId, "user id");
  assertUuid(conversationId, "conversation id");
  return path.join(roots.tenantRoot, userId, "conversations", conversationId);
}

function walkThreadRollouts(codexHome: string, threadId: string): string[] {
  assertUuid(threadId, "thread id");
  const result: string[] = [];
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = path.resolve(codexHome, directoryName);
    if (!fs.existsSync(root)) continue;
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.resolve(directory, entry.name);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("rollout path escapes Codex Home");
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && entry.name.includes(threadId)) result.push(absolute);
      }
    };
    visit(root);
  }
  return result.sort();
}

function addEntry(entries: ColdManifestEntry[], kind: ColdManifestEntry["kind"], root: ColdManifestEntry["root"], rootPath: string, absolute: string): void {
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`冷存储目标不是普通文件: ${absolute}`);
  entries.push({ kind, root, relativePath: safeRelative(path.relative(rootPath, absolute)), size: stat.size, sha256: fileSha256(absolute) });
}

type ColdFileSource = {
  file: FileRow;
  root: "dataRoot" | "conversation";
  rootPath: string;
  absolute: string;
};

// These entries are workspace scaffolding or control metadata. They are
// recreated/managed outside the conversation's user data and must not be
// swept into a cold archive (in particular, the per-conversation .git repo
// can otherwise duplicate a large amount of unrelated history).
const WORKSPACE_CONTROL_ENTRIES = new Set([".git", ".gitignore", "AGENTS.md", ".agents", ".codex", ".automation"]);

function fileSourceFor(roots: ColdStorageRoots, row: StorageDbRow, file: FileRow): ColdFileSource | undefined {
  const relative = safeRelative(file.relative_path);
  const workspace = conversationWorkspaceFor(roots, row.user_id, row.conversation_id);
  if (relative.startsWith("uploads/") || relative.startsWith("outputs/")) {
    const conversationPath = path.resolve(workspace, ...relative.split("/"));
    if (fs.existsSync(conversationPath)) return { file, root: "conversation", rootPath: workspace, absolute: conversationPath };
    // Early installations could place outputs under dataRoot. Keep those
    // files recoverable while new workspace files use the conversation root.
    const legacyPath = path.resolve(roots.dataRoot, ...relative.split("/"));
    if (fs.existsSync(legacyPath)) return { file, root: "dataRoot", rootPath: roots.dataRoot, absolute: legacyPath };
    return { file, root: "conversation", rootPath: workspace, absolute: conversationPath };
  }
  if (relative.startsWith("deliverables/")) {
    return { file, root: "dataRoot", rootPath: roots.dataRoot, absolute: path.resolve(roots.dataRoot, ...relative.split("/")) };
  }
  return undefined;
}

function workspaceFileSources(roots: ColdStorageRoots, row: StorageDbRow, protectedPaths: Set<string>, reasons: string[]): ColdFileSource[] {
  const workspace = conversationWorkspaceFor(roots, row.user_id, row.conversation_id);
  if (!fs.existsSync(workspace)) return [];
  const sources: ColdFileSource[] = [];
  const visit = (directory: string, relativeDirectory: string, topLevel: boolean): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { reasons.push("workspace_scan_failed"); return; }
    for (const entry of entries) {
      if (topLevel && WORKSPACE_CONTROL_ENTRIES.has(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.resolve(directory, entry.name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolute); }
      catch { reasons.push("workspace_file_missing"); continue; }
      if (stat.isSymbolicLink()) { reasons.push("workspace_symbolic_link"); continue; }
      if (stat.isDirectory()) { visit(absolute, relativePath, false); continue; }
      if (!stat.isFile()) { reasons.push("workspace_non_regular_file"); continue; }
      const normalized = safeRelative(relativePath);
      if (protectedPaths.has(normalized)) continue;
      sources.push({
        file: {
          id: `workspace:${normalized}`,
          relative_path: normalized,
          mime_type: "application/octet-stream",
          kind: "output",
          size: stat.size,
        },
        root: "conversation",
        rootPath: workspace,
        absolute,
      });
    }
  };
  visit(workspace, "", true);
  return sources;
}

function coldFileSources(
  sqlite: DatabaseSync,
  roots: ColdStorageRoots,
  row: StorageDbRow,
  shared: Set<string>,
  reasons: string[],
): ColdFileSource[] {
  const files = fileRows(sqlite, row.conversation_id);
  const protectedPaths = new Set(files.filter((file) => shared.has(file.id)).map((file) => file.relative_path));
  const sources: ColdFileSource[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    // A path referenced by a shared file is protected even if a legacy DB has
    // a second file row pointing at the same path.
    if (shared.has(file.id) || protectedPaths.has(file.relative_path)) continue;
    let source: ColdFileSource | undefined;
    try { source = fileSourceFor(roots, row, file); } catch { reasons.push("unsafe_file_path"); continue; }
    if (!source) { reasons.push("unsupported_file_path"); continue; }
    if (!fs.existsSync(source.absolute)) { reasons.push("file_missing"); continue; }
    const stat = fs.lstatSync(source.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { reasons.push("file_not_regular"); continue; }
    const key = `${source.root}:${file.relative_path}`;
    if (seen.has(key)) { reasons.push("duplicate_file_path"); continue; }
    seen.add(key);
    sources.push(source);
  }
  for (const source of workspaceFileSources(roots, row, protectedPaths, reasons)) {
    const key = `${source.root}:${source.file.relative_path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

function candidateFor(sqlite: DatabaseSync, roots: ColdStorageRoots, row: StorageDbRow, cutoff: number): ColdCandidate {
  const reasons: string[] = [];
  const now = Date.now();
  const lastActive = row.last_active_at ? Date.parse(row.last_active_at) : 0;
  const ageHours = lastActive > 0 ? Math.max(0, (now - lastActive) / (60 * 60 * 1_000)) : Number.POSITIVE_INFINITY;
  if (!row.codex_thread_id) reasons.push("no_codex_thread");
  if (!row.executor_id || row.executor_id.startsWith("remote:")) reasons.push("remote_executor_unsupported");
  if (row.status !== "idle" || row.external_status !== "idle") reasons.push("conversation_busy");
  if (row.deleted_at || row.deletion_state !== "active") reasons.push("deleting_or_deleted");
  const archived = Boolean(row.archived_at);
  // User-archived conversations are candidates on the next run; the 15-day
  // inactivity window applies only to ordinary, still-visible sessions.
  if (!archived && lastActive >= cutoff) reasons.push("active_within_15_days");
  if (!["local", "error"].includes(row.storage_state)) reasons.push(`storage_${row.storage_state}`);
  const jobs = Number((sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE conversation_id=? AND status IN ('queued','running')").get(row.conversation_id) as { n: number }).n);
  if (jobs) reasons.push("queued_or_running_job");
  const prompts = Number((sqlite.prepare("SELECT count(*) AS n FROM pending_prompts WHERE conversation_id=? AND status IN ('queued','editing')").get(row.conversation_id) as { n: number }).n);
  if (prompts) reasons.push("pending_prompt");
  const draft = Number((sqlite.prepare("SELECT count(*) AS n FROM composer_drafts d WHERE d.conversation_id=? AND (d.content<>'' OR d.quote_excerpt IS NOT NULL OR EXISTS (SELECT 1 FROM files f WHERE f.composer_draft_id=d.conversation_id))").get(row.conversation_id) as { n: number }).n);
  if (draft) reasons.push("draft");
  const wakes = Number((sqlite.prepare("SELECT count(*) AS n FROM wake_plans WHERE state='armed' AND (conversation_id=? OR target_conversation_id=?)").get(row.conversation_id, row.conversation_id) as { n: number }).n);
  if (wakes) reasons.push("armed_wake");
  const uploads = Number((sqlite.prepare("SELECT count(*) AS n FROM resumable_uploads WHERE conversation_id=? AND state IN ('uploading','finalizing')").get(row.conversation_id) as { n: number }).n);
  if (uploads) reasons.push("shared_file_transfer");
  const usedByAnother = row.codex_thread_id && Number((sqlite.prepare("SELECT count(*) AS n FROM conversations WHERE codex_thread_id=? AND id<>? AND deleted_at IS NULL AND deletion_state='active'").get(row.codex_thread_id, row.conversation_id) as { n: number }).n);
  if (usedByAnother) reasons.push("shared_codex_thread");

  const shared = sharedFileIds(sqlite, row.conversation_id);
  const files = fileRows(sqlite, row.conversation_id);
  const drawingFiles = files.filter((file) => file.kind === "output" && /^image\//i.test(file.mime_type));
  const drawing = drawingFiles.length > 0;
  const coldFiles = coldFileSources(sqlite, roots, row, shared, reasons);
  let rolloutBytes = 0;
  let rolloutEntries = 0;
  if (row.codex_thread_id) {
    try {
      for (const file of walkThreadRollouts(codexHomeFor(roots, row.user_id), row.codex_thread_id)) {
        rolloutBytes += fs.statSync(file).size;
        rolloutEntries += 1;
      }
    } catch { reasons.push("rollout_scan_failed"); }
  }
  const deliverableBytes = coldFiles.reduce((sum, source) => sum + source.file.size, 0);
  if (rolloutEntries === 0 && coldFiles.length === 0) reasons.push("no_local_cold_files");
  return {
    conversationId: row.conversation_id, userId: row.user_id, title: row.title, lastActiveAt: row.last_active_at,
    ageHours, state: row.storage_state, drawing, archived, eligible: reasons.length === 0, reasons,
    rolloutBytes, deliverableBytes, sharedFiles: shared.size, entries: rolloutEntries + coldFiles.length,
  };
}

export function defaultColdStorageRoots(overrides: Partial<ColdStorageRoots> = {}): ColdStorageRoots {
  const stateRoot = process.env.CODEX_WEB_STATE_ROOT || path.join(process.cwd(), ".state");
  return {
    dataRoot: overrides.dataRoot ?? path.join(stateRoot, "data"),
    tenantRoot: overrides.tenantRoot ?? path.join(stateRoot, "tenants"),
    hostRootCodexHome: overrides.hostRootCodexHome ?? path.join(stateRoot, "owner-codex-home"),
    databasePath: overrides.databasePath ?? path.join(stateRoot, "data", "codex-web.sqlite"),
    aliyunpan: overrides.aliyunpan ?? process.env.CODEX_WEB_COLD_STORAGE_CLI ?? "aliyunpan",
    age: overrides.age ?? "age",
    relayDir: overrides.relayDir ?? COLD_STORAGE_RELAY_DIR,
    downloadDir: overrides.downloadDir ?? COLD_STORAGE_DOWNLOAD_DIR,
    remoteRoot: overrides.remoteRoot ?? COLD_STORAGE_REMOTE_ROOT,
    driveId: overrides.driveId ?? process.env.CODEX_WEB_COLD_STORAGE_DRIVE_ID ?? "",
    ageRecipient: overrides.ageRecipient ?? process.env.CODEX_WEB_COLD_STORAGE_AGE_RECIPIENT ?? "",
    ageIdentity: overrides.ageIdentity ?? process.env.CODEX_WEB_COLD_STORAGE_AGE_IDENTITY ?? "",
    isolationRoot: overrides.isolationRoot ?? path.join(stateRoot, "cold-storage", "isolated"),
    voiceIsolationRoot: overrides.voiceIsolationRoot ?? path.join(stateRoot, "cold-storage", "voice-isolated"),
  };
}

export function listColdCandidates(roots: ColdStorageRoots, inactiveDays = 15): ColdCandidate[] {
  const sqlite = openDb(roots.databasePath);
  try {
    const cutoff = Date.now() - inactiveDays * DAY_MS;
    const rows = sqlite.prepare("SELECT c.id AS conversation_id,c.user_id,c.project_id,c.codex_thread_id,c.title,c.status,c.external_status,c.deleted_at,c.deletion_state,c.archived_at,c.last_active_at,p.executor_id,COALESCE(s.state,'local') AS storage_state,COALESCE(s.generation,0) AS generation,COALESCE(s.revision,0) AS revision,s.manifest_json,s.manifest_sha256,s.archive_sha256,s.archive_bytes,s.plaintext_bytes,s.remote_drive_id,s.remote_path,s.local_isolated_path,COALESCE(s.retry_count,0) AS retry_count,s.last_error FROM conversations c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN conversation_storage s ON s.conversation_id=c.id WHERE c.deleted_at IS NULL").all() as StorageDbRow[];
    return rows.map((row) => candidateFor(sqlite, roots, row, cutoff)).sort((left, right) => {
      // The daily job archives at most one conversation. Explicitly archived
      // conversations therefore take precedence over ordinary aged candidates.
      const archivedOrder = Number(right.archived) - Number(left.archived);
      if (archivedOrder) return archivedOrder;
      const ageOrder = right.ageHours - left.ageHours;
      return Number.isNaN(ageOrder) ? left.conversationId.localeCompare(right.conversationId) : ageOrder || left.conversationId.localeCompare(right.conversationId);
    });
  } finally { sqlite.close(); }
}

function audit(sqlite: DatabaseSync, conversationId: string, generation: number, revision: number, fromState: string, toState: string, action: string, details?: unknown): void {
  sqlite.prepare("INSERT INTO conversation_storage_audit(id,conversation_id,generation,revision,from_state,to_state,action,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), conversationId, generation, revision, fromState, toState, action, details === undefined ? null : JSON.stringify(details), new Date().toISOString());
}

function transition(sqlite: DatabaseSync, row: StorageDbRow, expected: ConversationStorageState[], to: ConversationStorageState, action: string, patch: Record<string, string | number | null> = {}): StorageDbRow {
  if (!expected.includes(row.storage_state)) throw new Error(`会话存储状态已变化: ${row.storage_state}`);
  const allowed = new Set(["generation", "retry_count", "manifest_json", "manifest_sha256", "archive_sha256", "archive_bytes", "plaintext_bytes", "remote_drive_id", "remote_path", "local_isolated_path", "last_error", "uploaded_at", "verified_at", "restored_at"]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  const sql = `UPDATE conversation_storage SET state=?,revision=revision+1,updated_at=?${entries.map(([key]) => `,${key}=?`).join("")} WHERE conversation_id=? AND revision=? AND state IN (${expected.map(() => "?").join(",")})`;
  const result = sqlite.prepare(sql).run(to, new Date().toISOString(), ...entries.map(([, value]) => value), row.conversation_id, row.revision, ...expected);
  if (!result.changes) throw new Error("会话存储 CAS 冲突");
  const next = rowForConversation(sqlite, row.conversation_id);
  if (!next) throw new Error("会话在存储转换后消失");
  audit(sqlite, row.conversation_id, next.generation, next.revision, row.storage_state, to, action, entries.length ? Object.fromEntries(entries) : undefined);
  return next;
}

function acquireOperationLock(roots: ColdStorageRoots, conversationId: string): string {
  const lockRoot = path.join(path.dirname(roots.isolationRoot), "locks");
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(lockRoot, conversationId);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error("该会话已有归档或恢复操作正在执行"); }
  fs.writeFileSync(path.join(lock, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
  return lock;
}

function removeOperationLock(lock: string): void {
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
}

function runAliyun(roots: ColdStorageRoots, args: string[], timeout = 6 * 60 * 60_000): string {
  return execFileSync(roots.aliyunpan, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
}

function assertColdStorageConfigured(roots: ColdStorageRoots): void {
  if (!roots.aliyunpan.trim() || !roots.driveId.trim()) throw new Error("冷存储 provider/Drive ID 尚未配置");
  if (!fs.existsSync(roots.ageRecipient) || !fs.existsSync(roots.ageIdentity)) throw new Error("age 密钥边界不可用");
}

function remoteTree(roots: ColdStorageRoots, remotePath: string): string {
  return runAliyun(roots, ["tree", "--driveId", roots.driveId, "-fp", remotePath]);
}

function ensureRemoteDirectory(roots: ColdStorageRoots, remotePath: string): void {
  let listing = "";
  try { listing = remoteTree(roots, remotePath); } catch { /* create below */ }
  if (listing.split(/\r?\n/).some((line) => line.trim() === remotePath)) return;
  runAliyun(roots, ["mkdir", "--driveId", roots.driveId, remotePath], 120_000);
  if (!remoteTree(roots, remotePath).split(/\r?\n/).some((line) => line.trim() === remotePath)) throw new Error(`云端目录创建后不可见: ${remotePath}`);
}

function ensureRemotePath(roots: ColdStorageRoots, remotePath: string): void {
  const parts = remotePath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) { current += `/${part}`; ensureRemoteDirectory(roots, current); }
}

function remoteObjectVisible(roots: ColdStorageRoots, remotePath: string): boolean {
  const parent = path.posix.dirname(remotePath);
  const name = path.posix.basename(remotePath);
  return remoteTree(roots, parent).split(/\r?\n/).some((line) => line.includes(`-> ${remotePath}`) || line.trim().endsWith(`/${name}`));
}

function stageForUpload(roots: ColdStorageRoots, source: string): string {
  fs.mkdirSync(roots.relayDir, { recursive: true, mode: 0o700 });
  const target = path.join(roots.relayDir, path.basename(source));
  if (fs.existsSync(target)) throw new Error(`阿里云盘中转目录已有同名文件: ${path.basename(source)}`);
  fs.copyFileSync(source, target);
  try {
    const uid = Number(execFileSync("id", ["-u", "aliyunpan"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "aliyunpan"], { encoding: "utf8" }).trim());
    fs.chownSync(target, uid, gid);
    fs.chmodSync(target, 0o600);
  } catch (error) { try { fs.unlinkSync(target); } catch {} throw error; }
  return target;
}

function prepareDownloadDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const uid = Number(execFileSync("id", ["-u", "aliyunpan"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "aliyunpan"], { encoding: "utf8" }).trim());
    fs.chownSync(directory, uid, gid);
    fs.chmodSync(directory, 0o700);
  } catch (error) { throw new Error(`阿里云盘下载目录权限不可用: ${error instanceof Error ? error.message : "unknown"}`); }
}

function findDownloadedFile(root: string, name: string, fallbackRoots: string[] = []): string {
  const matches: string[] = [];
  const visited = new Set<string>();
  const visit = (directory: string): void => {
    const resolved = path.resolve(directory);
    if (visited.has(resolved) || !fs.existsSync(resolved)) return;
    visited.add(resolved);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === name) matches.push(absolute);
    }
  };
  visit(root);
  for (const fallbackRoot of fallbackRoots) {
    if (matches.length > 0) break;
    visit(fallbackRoot);
  }
  if (matches.length !== 1) throw new Error(`云端回下载后找不到唯一归档文件: ${name}`);
  return matches[0];
}

function packageArchive(roots: ColdStorageRoots, staging: string, archivePath: string): void {
  const plain = `${archivePath}.plain`;
  execFileSync("tar", ["-cf", plain, "--sort=name", "-C", staging, "."], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
  try { execFileSync(roots.age, ["-R", roots.ageRecipient, "-o", archivePath, plain], { stdio: "ignore", timeout: 6 * 60 * 60_000 }); }
  finally { try { fs.unlinkSync(plain); } catch {} }
}

function verifyAgeArchive(roots: ColdStorageRoots, archivePath: string): void {
  execFileSync(roots.age, ["-d", "-i", roots.ageIdentity, archivePath], { stdio: ["ignore", "ignore", "pipe"], timeout: 6 * 60 * 60_000 });
}

function copyOrLink(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try { fs.linkSync(source, destination); }
  catch { fs.copyFileSync(source, destination); }
}

function moveToIsolation(roots: ColdStorageRoots, manifest: ColdManifest, conversationId: string): string {
  const isolated = path.join(roots.isolationRoot, conversationId, String(manifest.generation));
  fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
  const moved: Array<{ source: string; target: string }> = [];
  try {
    for (const entry of manifest.entries) {
      const sourceRoot = entry.root === "codexHome"
        ? codexHomeFor(roots, manifest.userId)
        : entry.root === "conversation"
          ? conversationWorkspaceFor(roots, manifest.userId, manifest.conversationId)
          : roots.dataRoot;
      const source = path.resolve(sourceRoot, ...safeRelative(entry.relativePath).split("/"));
      if (!fs.existsSync(source)) throw new Error(`归档前文件消失: ${entry.relativePath}`);
      const target = path.join(isolated, entry.kind, entry.relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(source, target);
      moved.push({ source, target });
    }
  } catch (error) {
    for (const item of moved.reverse()) { try { fs.mkdirSync(path.dirname(item.source), { recursive: true }); fs.renameSync(item.target, item.source); } catch {} }
    throw error;
  }
  return isolated;
}

export function archiveConversation(rootsInput: Partial<ColdStorageRoots>, conversationId: string): ColdArchiveResult {
  const roots = defaultColdStorageRoots(rootsInput);
  assertUuid(conversationId, "conversation id");
  const lock = acquireOperationLock(roots, conversationId);
  const sqlite = openDb(roots.databasePath);
  let work = "";
  try {
    let row = rowForConversation(sqlite, conversationId);
    if (!row) throw new Error("会话不存在");
    const candidate = candidateFor(sqlite, roots, row, Date.now() - 15 * DAY_MS);
    if (!candidate.eligible) throw new Error(`会话不满足冷存储条件: ${candidate.reasons.join(",")}`);
    assertColdStorageConfigured(roots);
    const generation = row.generation + 1;
    row = transition(sqlite, row, ["local", "error"], "uploading", "archive_begin", { generation, retry_count: 0, last_error: null });
    work = fs.mkdtempSync(path.join(path.dirname(roots.isolationRoot), `.package-${conversationId}-`));
    const codexHome = codexHomeFor(roots, row.user_id);
    const entries: ColdManifestEntry[] = [];
    for (const file of walkThreadRollouts(codexHome, row.codex_thread_id!)) addEntry(entries, "rollout", "codexHome", codexHome, file);
    const shared = sharedFileIds(sqlite, conversationId);
    const fileReasons: string[] = [];
    const coldFiles = coldFileSources(sqlite, roots, row, shared, fileReasons);
    if (fileReasons.length) throw new Error(`会话文件不满足冷存储条件: ${[...new Set(fileReasons)].join(",")}`);
    for (const source of coldFiles) addEntry(entries, "file", source.root, source.rootPath, source.absolute);
    if (!entries.length) throw new Error("没有可归档的 rollout 或会话文件");
    const manifest: ColdManifest = {
      format: COLD_STORAGE_FORMAT, conversationId, userId: row.user_id, threadId: row.codex_thread_id!, generation,
      createdAt: new Date().toISOString(), plaintextBytes: entries.reduce((sum, entry) => sum + entry.size, 0), entries,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = crypto.createHash("sha256").update(manifestText).digest("hex");
    fs.writeFileSync(path.join(work, "manifest.json"), manifestText, { mode: 0o600 });
    for (const entry of entries) {
      const root = entry.root === "codexHome"
        ? codexHome
        : entry.root === "conversation"
          ? conversationWorkspaceFor(roots, row.user_id, conversationId)
          : roots.dataRoot;
      copyOrLink(path.resolve(root, ...entry.relativePath.split("/")), path.join(work, entry.kind, entry.relativePath));
    }
    const archiveLocal = path.join(work, `generation-${generation}.tar.age`);
    packageArchive(roots, work, archiveLocal);
    verifyAgeArchive(roots, archiveLocal);
    const archiveSha256 = sha256File(archiveLocal);
    const archiveBytes = fs.statSync(archiveLocal).size;
    const remoteDirectory = `${roots.remoteRoot}/${row.user_id}/${conversationId}`;
    const remotePath = `${remoteDirectory}/generation-${generation}-${archiveSha256}.tar.age`;
    const remoteArchiveLocal = path.join(work, path.basename(remotePath));
    fs.renameSync(archiveLocal, remoteArchiveLocal);
    ensureRemotePath(roots, remoteDirectory);
    const stage = stageForUpload(roots, remoteArchiveLocal);
    try { runAliyun(roots, ["upload", "--driveId", roots.driveId, "--np", "--retry", "5", "--timeout", "120", stage, remoteDirectory]); }
    finally { try { fs.unlinkSync(stage); } catch {} }
    if (!remoteObjectVisible(roots, remotePath)) throw new Error("归档上传后云端精确对象不可见");
    prepareDownloadDirectory(roots.downloadDir);
    const downloadWork = fs.mkdtempSync(path.join(roots.downloadDir, `${conversationId}-`));
    prepareDownloadDirectory(downloadWork);
    try {
      runAliyun(roots, ["download", "--driveId", roots.driveId, "--np", `--saveto=${downloadWork}`, remotePath], 6 * 60 * 60_000);
      const downloaded = findDownloadedFile(downloadWork, path.basename(remotePath), [path.dirname(roots.downloadDir)]);
      if (sha256File(downloaded) !== archiveSha256 || fs.statSync(downloaded).size !== archiveBytes) throw new Error("云端回下载 SHA-256/字节数不一致");
    } finally { try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} }
    row = rowForConversation(sqlite, conversationId)!;
    row = transition(sqlite, row, ["uploading"], "remote_verified", "remote_verify", {
      manifest_json: manifestText, manifest_sha256: manifestSha256, archive_sha256: archiveSha256, archive_bytes: archiveBytes,
      plaintext_bytes: manifest.plaintextBytes, remote_drive_id: roots.driveId, remote_path: remotePath,
      uploaded_at: new Date().toISOString(), verified_at: new Date().toISOString(), last_error: null,
    });
    row = transition(sqlite, row, ["remote_verified"], "evicting", "local_evict_begin");
    const isolatedPath = moveToIsolation(roots, manifest, conversationId);
    row = rowForConversation(sqlite, conversationId)!;
    transition(sqlite, row, ["evicting"], "cold", "local_evict_complete", { local_isolated_path: isolatedPath, last_error: null });
    return { conversationId, generation, archiveBytes, plaintextBytes: manifest.plaintextBytes, archiveSha256, manifestSha256, remotePath, isolatedPath };
  } catch (error) {
    const row = rowForConversation(sqlite, conversationId);
    if (row && ["uploading", "remote_verified", "evicting"].includes(row.storage_state)) {
      try {
        const next = transition(sqlite, row, [row.storage_state], "error", "archive_error", { last_error: error instanceof Error ? error.message.slice(0, 2_000) : "archive_failed" });
        sqlite.prepare("UPDATE conversation_storage SET retry_count=retry_count+1 WHERE conversation_id=? AND revision=?").run(conversationId, next.revision);
      } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    sqlite.close();
    if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    removeOperationLock(lock);
  }
}

function restoreFilesFromExtract(roots: ColdStorageRoots, manifest: ColdManifest, extractRoot: string): void {
  const installed: Array<{ source: string; target: string }> = [];
  try {
    for (const entry of manifest.entries) {
      const source = path.resolve(extractRoot, entry.kind, ...safeRelative(entry.relativePath).split("/"));
      const targetRoot = entry.root === "codexHome"
        ? codexHomeFor(roots, manifest.userId)
        : entry.root === "conversation"
          ? conversationWorkspaceFor(roots, manifest.userId, manifest.conversationId)
          : roots.dataRoot;
      const target = path.resolve(targetRoot, ...safeRelative(entry.relativePath).split("/"));
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || fileSha256(source) !== entry.sha256) throw new Error(`冷存储成员校验失败: ${entry.relativePath}`);
      if (fs.existsSync(target)) {
        const existing = fs.lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== entry.size || fileSha256(target) !== entry.sha256) throw new Error(`恢复目标已存在且内容不同: ${entry.relativePath}`);
        continue;
      }
      const temporary = `${target}.cold-restore-${process.pid}-${crypto.randomUUID()}`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, temporary);
      fs.chmodSync(temporary, stat.mode & 0o777);
      fs.renameSync(temporary, target);
      installed.push({ source, target });
    }
  } catch (error) {
    for (const item of installed.reverse()) { try { fs.unlinkSync(item.target); } catch {} }
    throw error;
  }
}

export function restoreColdConversation(rootsInput: Partial<ColdStorageRoots>, conversationId: string, userId: string): void {
  const roots = defaultColdStorageRoots(rootsInput);
  assertUuid(conversationId, "conversation id"); assertUuid(userId, "user id");
  const lock = acquireOperationLock(roots, conversationId);
  const sqlite = openDb(roots.databasePath);
  let downloadWork = "";
  let extractWork = "";
  try {
    let row = rowForConversation(sqlite, conversationId, userId);
    if (!row) throw new Error("会话不存在或账号不匹配");
    if (row.storage_state === "local") return;
    assertColdStorageConfigured(roots);
    if (!row.remote_path || !row.archive_sha256 || !row.manifest_sha256 || !row.manifest_json) throw new Error("冷存储清单不完整");
    const remotePath = row.remote_path;
    const manifestSha256 = row.manifest_sha256;
    const manifestJson = row.manifest_json;
    if (!["cold", "restoring", "error"].includes(row.storage_state)) throw new Error(`当前状态不能恢复: ${row.storage_state}`);
    if (row.storage_state !== "restoring") row = transition(sqlite, row, ["cold", "error"], "restoring", "restore_begin");
    prepareDownloadDirectory(roots.downloadDir);
    downloadWork = fs.mkdtempSync(path.join(roots.downloadDir, `${conversationId}-`));
    prepareDownloadDirectory(downloadWork);
    runAliyun(roots, ["download", "--driveId", roots.driveId, "--np", `--saveto=${downloadWork}`, remotePath], 6 * 60 * 60_000);
    const archive = findDownloadedFile(downloadWork, path.basename(remotePath), [path.dirname(roots.downloadDir)]);
    if (fs.statSync(archive).size !== row.archive_bytes || sha256File(archive) !== row.archive_sha256) throw new Error("恢复归档密文 SHA-256/字节数不一致");
    extractWork = fs.mkdtempSync(path.join(path.dirname(roots.isolationRoot), `.restore-${conversationId}-`));
    const plain = `${extractWork}.plain.tar`;
    execFileSync(roots.age, ["-d", "-i", roots.ageIdentity, "-o", plain, archive], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
    const listing = execFileSync("tar", ["-tf", plain], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    for (const item of listing.split(/\r?\n/).filter(Boolean)) {
      const normalized = item.replace(/^\.\//, "").replace(/\/$/, "");
      if (normalized === "" || normalized === "rollout" || normalized === "file" || normalized === "deliverable") continue;
      if (normalized !== "manifest.json" && !normalized.startsWith("rollout/") && !normalized.startsWith("file/") && !normalized.startsWith("deliverable/")) throw new Error("归档包含不允许的路径");
      safeRelative(normalized);
    }
    execFileSync("tar", ["-xf", plain, "--no-same-owner", "--no-same-permissions", "-C", extractWork], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
    try { fs.unlinkSync(plain); } catch {}
    const manifestText = fs.readFileSync(path.join(extractWork, "manifest.json"), "utf8");
    if (crypto.createHash("sha256").update(manifestText).digest("hex") !== manifestSha256) throw new Error("恢复 manifest SHA-256 不一致");
    const manifest = JSON.parse(manifestText) as ColdManifest;
    if (![COLD_STORAGE_FORMAT, LEGACY_COLD_STORAGE_FORMAT].includes(manifest.format) || manifest.conversationId !== conversationId || manifest.userId !== userId || manifest.threadId !== row.codex_thread_id || manifest.generation !== row.generation) throw new Error("恢复 manifest 身份或代次不一致");
    if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(manifestJson))) throw new Error("恢复 manifest 内容与数据库不一致");
    restoreFilesFromExtract(roots, manifest, extractWork);
    row = rowForConversation(sqlite, conversationId, userId)!;
    transition(sqlite, row, ["restoring"], "local", "restore_complete", { restored_at: new Date().toISOString(), last_error: null });
  } catch (error) {
    const row = rowForConversation(sqlite, conversationId, userId);
    if (row && ["restoring", "cold"].includes(row.storage_state)) {
      try {
        const next = transition(sqlite, row, [row.storage_state], "error", "restore_error", { last_error: error instanceof Error ? error.message.slice(0, 2_000) : "restore_failed" });
        sqlite.prepare("UPDATE conversation_storage SET retry_count=retry_count+1 WHERE conversation_id=? AND revision=?").run(conversationId, next.revision);
      } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    sqlite.close();
    if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {}
    if (extractWork) try { fs.rmSync(extractWork, { recursive: true, force: true }); } catch {}
    removeOperationLock(lock);
  }
}

export function coldStorageSummary(rootsInput: Partial<ColdStorageRoots> = {}) {
  const roots = defaultColdStorageRoots(rootsInput);
  const sqlite = openDb(roots.databasePath);
  try {
    const rows = sqlite.prepare("SELECT state,count(*) AS conversations,COALESCE(sum(archive_bytes),0) AS archive_bytes,COALESCE(sum(plaintext_bytes),0) AS plaintext_bytes FROM conversation_storage GROUP BY state ORDER BY state").all();
    return { rows, candidates: listColdCandidates(roots) };
  } finally { sqlite.close(); }
}

export type ColdPurgeResult = { conversationId: string; isolatedPath: string; deleted: boolean; reason?: string };

/** Remove only delayed local isolation copies after the configured grace period.
 * The encrypted remote object remains the source of truth for a future restore. */
export function purgeColdIsolated(rootsInput: Partial<ColdStorageRoots> = {}, graceDays = 7): ColdPurgeResult[] {
  const roots = defaultColdStorageRoots(rootsInput);
  if (!Number.isFinite(graceDays) || graceDays < 1) throw new Error("graceDays must be at least 1");
  const sqlite = openDb(roots.databasePath);
  const results: ColdPurgeResult[] = [];
  try {
    const cutoff = Date.now() - graceDays * DAY_MS;
    const rows = sqlite.prepare("SELECT conversation_id,generation,revision,state,local_isolated_path,updated_at FROM conversation_storage WHERE state='cold' AND local_isolated_path IS NOT NULL").all() as Array<{ conversation_id: string; generation: number; revision: number; state: string; local_isolated_path: string; updated_at: string }>;
    for (const row of rows) {
      if (Date.parse(row.updated_at) > cutoff) continue;
      const lock = acquireOperationLock(roots, row.conversation_id);
      try {
        const source = path.resolve(row.local_isolated_path);
        const isolationRoot = path.resolve(roots.isolationRoot);
        if (!source.startsWith(`${isolationRoot}${path.sep}`)) throw new Error("隔离路径越界");
        if (!fs.existsSync(source)) {
          sqlite.prepare("UPDATE conversation_storage SET local_isolated_path=NULL,updated_at=? WHERE conversation_id=? AND revision=? AND state='cold'").run(new Date().toISOString(), row.conversation_id, row.revision);
          audit(sqlite, row.conversation_id, row.generation, row.revision + 1, "cold", "cold", "local_isolation_already_absent");
          results.push({ conversationId: row.conversation_id, isolatedPath: source, deleted: true });
          continue;
        }
        const trash = path.join(path.dirname(source), `.purged-${path.basename(source)}-${crypto.randomUUID()}`);
        fs.renameSync(source, trash);
        const updated = sqlite.prepare("UPDATE conversation_storage SET local_isolated_path=NULL,updated_at=?,revision=revision+1 WHERE conversation_id=? AND revision=? AND state='cold'").run(new Date().toISOString(), row.conversation_id, row.revision);
        if (!updated.changes) { try { fs.renameSync(trash, source); } catch {} throw new Error("清理 CAS 冲突"); }
        audit(sqlite, row.conversation_id, row.generation, row.revision + 1, "cold", "cold", "local_isolation_purged", { graceDays });
        try { fs.rmSync(trash, { recursive: true, force: true }); } catch (error) { results.push({ conversationId: row.conversation_id, isolatedPath: source, deleted: false, reason: `已从工作路径移出，等待删除: ${error instanceof Error ? error.message : "unknown"}` }); continue; }
        results.push({ conversationId: row.conversation_id, isolatedPath: source, deleted: true });
      } catch (error) { results.push({ conversationId: row.conversation_id, isolatedPath: row.local_isolated_path, deleted: false, reason: error instanceof Error ? error.message : "purge_failed" }); }
      finally { removeOperationLock(lock); }
    }
    return results;
  } finally { sqlite.close(); }
}

type VoiceStorageRow = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  created_at: string;
  status: string;
  audio_relative_path: string | null;
  audio_mime_type: string | null;
  audio_bytes: number | null;
  audio_sha256: string | null;
  audio_storage_state: string;
  audio_generation: number;
  audio_revision: number;
  audio_archive_sha256: string | null;
  audio_archive_bytes: number | null;
  audio_remote_drive_id: string | null;
  audio_remote_path: string | null;
  audio_local_isolated_path: string | null;
  audio_last_error: string | null;
  audio_updated_at: string | null;
};

export type VoiceRecordingCandidate = {
  transcriptionId: string;
  userId: string;
  conversationId: string | null;
  createdAt: string;
  ageHours: number;
  bytes: number;
  state: string;
  eligible: boolean;
  reasons: string[];
};

export type VoiceRecordingArchiveResult = {
  transcriptionId: string;
  generation: number;
  archiveBytes: number;
  archiveSha256: string;
  remotePath: string;
  isolatedPath: string;
};

function voiceRow(sqlite: DatabaseSync, transcriptionId: string, userId?: string): VoiceStorageRow | undefined {
  return sqlite.prepare(`
    SELECT id,user_id,conversation_id,created_at,status,audio_relative_path,audio_mime_type,audio_bytes,audio_sha256,
      audio_storage_state,audio_generation,audio_revision,audio_archive_sha256,audio_archive_bytes,audio_remote_drive_id,
      audio_remote_path,audio_local_isolated_path,audio_last_error,audio_updated_at
    FROM voice_transcriptions WHERE id=?${userId ? " AND user_id=?" : ""}
  `).get(...(userId ? [transcriptionId, userId] : [transcriptionId])) as VoiceStorageRow | undefined;
}

function voiceAbsolutePath(roots: ColdStorageRoots, relativePath: string): string {
  if (!/^voice-recordings\/[0-9a-f-]{36}\/[0-9]{4}-[0-9]{2}\/[0-9a-f-]{36}\.(?:webm|ogg|mp4|mp3|wav|aac|flac)$/i.test(relativePath)) throw new Error("语音本地路径格式无效");
  const root = path.resolve(roots.dataRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("语音本地路径越界");
  return target;
}

function voiceAudit(sqlite: DatabaseSync, row: VoiceStorageRow, fromState: string, toState: string, action: string, details?: unknown): void {
  sqlite.prepare("INSERT INTO voice_recording_storage_audit(id,transcription_id,generation,revision,from_state,to_state,action,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), row.id, row.audio_generation, row.audio_revision, fromState, toState, action, details === undefined ? null : JSON.stringify(details), new Date().toISOString());
}

function voiceTransition(sqlite: DatabaseSync, row: VoiceStorageRow, expected: string[], to: string, action: string, patch: Record<string, string | number | null> = {}): VoiceStorageRow {
  if (!expected.includes(row.audio_storage_state)) throw new Error(`语音存储状态已变化: ${row.audio_storage_state}`);
  const allowed = new Set(["audio_generation", "audio_archive_sha256", "audio_archive_bytes", "audio_remote_drive_id", "audio_remote_path", "audio_local_isolated_path", "audio_last_error", "audio_uploaded_at", "audio_verified_at", "audio_restored_at"]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  const sql = `UPDATE voice_transcriptions SET audio_storage_state=?,audio_revision=audio_revision+1,audio_updated_at=?${entries.map(([key]) => `,${key}=?`).join("")} WHERE id=? AND audio_revision=? AND audio_storage_state IN (${expected.map(() => "?").join(",")})`;
  const result = sqlite.prepare(sql).run(to, new Date().toISOString(), ...entries.map(([, value]) => value), row.id, row.audio_revision, ...expected);
  if (!result.changes) throw new Error("语音存储 CAS 冲突");
  const next = voiceRow(sqlite, row.id);
  if (!next) throw new Error("语音记录在存储转换后消失");
  voiceAudit(sqlite, next, row.audio_storage_state, to, action, entries.length ? Object.fromEntries(entries) : undefined);
  return next;
}

function voiceIsolationPath(roots: ColdStorageRoots, row: VoiceStorageRow): string {
  if (!row.audio_relative_path) throw new Error("语音本地路径缺失");
  return path.join(roots.voiceIsolationRoot, row.user_id, row.id, String(row.audio_generation), path.basename(row.audio_relative_path));
}

function moveVoiceToIsolation(roots: ColdStorageRoots, row: VoiceStorageRow): string {
  const source = voiceAbsolutePath(roots, row.audio_relative_path!);
  if (!fs.existsSync(source)) throw new Error("归档前语音文件消失");
  const target = voiceIsolationPath(roots, row);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.renameSync(source, target); fs.chmodSync(target, 0o600);
  return target;
}

function encryptVoiceRecording(roots: ColdStorageRoots, source: string, target: string): void {
  execFileSync(roots.age, ["-R", roots.ageRecipient, "-o", target, source], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
  const check = `${target}.check-${crypto.randomUUID()}`;
  try { execFileSync(roots.age, ["-d", "-i", roots.ageIdentity, "-o", check, target], { stdio: "ignore", timeout: 6 * 60 * 60_000 }); }
  finally { try { fs.rmSync(check, { force: true }); } catch {} }
}

function verifyVoicePlaintext(roots: ColdStorageRoots, encrypted: string, row: VoiceStorageRow, output: string): void {
  execFileSync(roots.age, ["-d", "-i", roots.ageIdentity, "-o", output, encrypted], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
  if (!row.audio_bytes || !row.audio_sha256 || fs.statSync(output).size !== row.audio_bytes || sha256File(output) !== row.audio_sha256) throw new Error("语音归档明文 SHA-256/字节数不一致");
}

export function listVoiceRecordingCandidates(rootsInput: Partial<ColdStorageRoots> = {}, inactiveDays = 15): VoiceRecordingCandidate[] {
  const roots = defaultColdStorageRoots(rootsInput);
  const sqlite = openDb(roots.databasePath);
  try {
    const cutoff = Date.now() - inactiveDays * DAY_MS;
    const rows = sqlite.prepare("SELECT id,user_id,conversation_id,created_at,status,audio_relative_path,audio_bytes,audio_storage_state FROM voice_transcriptions WHERE audio_relative_path IS NOT NULL AND audio_storage_state IN ('local','error') ORDER BY created_at").all() as Array<Pick<VoiceStorageRow, "id" | "user_id" | "conversation_id" | "created_at" | "status" | "audio_relative_path" | "audio_bytes" | "audio_storage_state">>;
    return rows.map((row) => {
      const reasons: string[] = [];
      const createdAt = Date.parse(row.created_at);
      if (!Number.isFinite(createdAt) || createdAt > cutoff) reasons.push("未满不活跃期限");
      if (row.status === "processing") reasons.push("正在复核");
      if (!row.audio_relative_path) reasons.push("本地路径缺失");
      else { try { if (!fs.existsSync(voiceAbsolutePath(roots, row.audio_relative_path))) reasons.push("本地文件不存在"); } catch { reasons.push("本地路径无效"); } }
      if (row.conversation_id && sqlite.prepare("SELECT 1 AS found FROM jobs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(row.conversation_id)) reasons.push("关联会话仍在运行");
      return { transcriptionId: row.id, userId: row.user_id, conversationId: row.conversation_id, createdAt: row.created_at, ageHours: Number.isFinite(createdAt) ? Math.max(0, (Date.now() - createdAt) / (60 * 60 * 1_000)) : 0, bytes: row.audio_bytes ?? 0, state: row.audio_storage_state, eligible: reasons.length === 0, reasons };
    });
  } finally { sqlite.close(); }
}

export function archiveVoiceRecording(rootsInput: Partial<ColdStorageRoots>, transcriptionId: string): VoiceRecordingArchiveResult {
  const roots = defaultColdStorageRoots(rootsInput); assertUuid(transcriptionId, "transcription id");
  const lock = acquireOperationLock(roots, `voice-${transcriptionId}`); const sqlite = openDb(roots.databasePath); let work = ""; let downloadWork = "";
  try {
    let row = voiceRow(sqlite, transcriptionId); if (!row) throw new Error("语音转写记录不存在");
    if (!row.audio_relative_path || !row.audio_sha256 || !row.audio_bytes) throw new Error("语音文件清单不完整");
    const candidate = listVoiceRecordingCandidates(roots).find((item) => item.transcriptionId === transcriptionId);
    if (!candidate?.eligible) throw new Error(`语音不满足冷存储条件: ${candidate?.reasons.join(",") || "不存在"}`);
    assertColdStorageConfigured(roots);
    row = voiceTransition(sqlite, row, ["local", "error"], "uploading", "archive_begin", { audio_generation: row.audio_generation + 1, audio_last_error: null });
    work = fs.mkdtempSync(path.join(path.dirname(roots.voiceIsolationRoot), `.voice-package-${transcriptionId}-`));
    const source = voiceAbsolutePath(roots, row.audio_relative_path!); if (fs.statSync(source).size !== row.audio_bytes || sha256File(source) !== row.audio_sha256) throw new Error("本地语音 SHA-256/字节数不一致");
    const encrypted = path.join(work, `${transcriptionId}.age`); encryptVoiceRecording(roots, source, encrypted);
    const archiveSha256 = sha256File(encrypted); const archiveBytes = fs.statSync(encrypted).size;
    const remoteDirectory = `${VOICE_RECORDING_REMOTE_ROOT}/${row.user_id}/${row.created_at.slice(0, 7)}`; const remotePath = `${remoteDirectory}/${transcriptionId}-${archiveSha256}.age`;
    const remoteArchiveLocal = path.join(work, path.basename(remotePath)); fs.copyFileSync(encrypted, remoteArchiveLocal);
    ensureRemotePath(roots, remoteDirectory); const stage = stageForUpload(roots, remoteArchiveLocal);
    try { runAliyun(roots, ["upload", "--driveId", roots.driveId, "--np", "--retry", "5", "--timeout", "120", stage, remoteDirectory]); } finally { try { fs.unlinkSync(stage); } catch {} }
    if (!remoteObjectVisible(roots, remotePath)) throw new Error("语音归档上传后云端精确对象不可见");
    prepareDownloadDirectory(roots.downloadDir); downloadWork = fs.mkdtempSync(path.join(roots.downloadDir, `voice-${transcriptionId}-`)); prepareDownloadDirectory(downloadWork);
    runAliyun(roots, ["download", "--driveId", roots.driveId, "--np", `--saveto=${downloadWork}`, remotePath], 6 * 60 * 60_000);
    const downloaded = findDownloadedFile(downloadWork, path.basename(remotePath), [path.dirname(roots.downloadDir)]);
    if (fs.statSync(downloaded).size !== archiveBytes || sha256File(downloaded) !== archiveSha256) throw new Error("语音云端密文 SHA-256/字节数不一致");
    verifyVoicePlaintext(roots, downloaded, row, path.join(work, "plaintext-check"));
    row = voiceTransition(sqlite, voiceRow(sqlite, transcriptionId)!, ["uploading"], "remote_verified", "archive_remote_verified", { audio_archive_sha256: archiveSha256, audio_archive_bytes: archiveBytes, audio_remote_drive_id: roots.driveId, audio_remote_path: remotePath, audio_uploaded_at: new Date().toISOString(), audio_verified_at: new Date().toISOString(), audio_last_error: null });
    row = voiceTransition(sqlite, row, ["remote_verified"], "evicting", "local_evict_begin"); const isolatedPath = moveVoiceToIsolation(roots, row);
    row = voiceRow(sqlite, transcriptionId)!; voiceTransition(sqlite, row, ["evicting"], "cold", "local_evict_complete", { audio_local_isolated_path: isolatedPath, audio_last_error: null });
    return { transcriptionId, generation: row.audio_generation, archiveBytes, archiveSha256, remotePath, isolatedPath };
  } catch (error) {
    const row = voiceRow(sqlite, transcriptionId); if (row && ["uploading", "remote_verified", "evicting"].includes(row.audio_storage_state)) { try { voiceTransition(sqlite, row, [row.audio_storage_state], "error", "archive_error", { audio_last_error: error instanceof Error ? error.message.slice(0, 2_000) : "archive_failed" }); } catch {} }
    throw error;
  } finally { sqlite.close(); if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {} if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} removeOperationLock(lock); }
}

export function restoreVoiceRecording(rootsInput: Partial<ColdStorageRoots>, transcriptionId: string, userId: string): void {
  const roots = defaultColdStorageRoots(rootsInput); assertUuid(transcriptionId, "transcription id"); assertUuid(userId, "user id");
  const lock = acquireOperationLock(roots, `voice-${transcriptionId}`); const sqlite = openDb(roots.databasePath); let downloadWork = ""; let work = "";
  try {
    let row = voiceRow(sqlite, transcriptionId, userId); if (!row) throw new Error("语音记录不存在或账号不匹配"); if (row.audio_storage_state === "local") return;
    assertColdStorageConfigured(roots);
    if (!row.audio_remote_path || !row.audio_archive_sha256 || !row.audio_archive_bytes || !row.audio_relative_path) throw new Error("语音远端清单不完整");
    if (!["cold", "restoring", "error"].includes(row.audio_storage_state)) throw new Error(`当前语音状态不能恢复: ${row.audio_storage_state}`);
    if (row.audio_storage_state !== "restoring") row = voiceTransition(sqlite, row, ["cold", "error"], "restoring", "restore_begin");
    prepareDownloadDirectory(roots.downloadDir); downloadWork = fs.mkdtempSync(path.join(roots.downloadDir, `voice-restore-${transcriptionId}-`)); prepareDownloadDirectory(downloadWork);
    runAliyun(roots, ["download", "--driveId", roots.driveId, "--np", `--saveto=${downloadWork}`, row.audio_remote_path!], 6 * 60 * 60_000);
    const encrypted = findDownloadedFile(downloadWork, path.basename(row.audio_remote_path!), [path.dirname(roots.downloadDir)]);
    if (fs.statSync(encrypted).size !== row.audio_archive_bytes || sha256File(encrypted) !== row.audio_archive_sha256) throw new Error("语音恢复密文 SHA-256/字节数不一致");
    work = fs.mkdtempSync(path.join(path.dirname(roots.voiceIsolationRoot), `.voice-restore-${transcriptionId}-`)); const restored = path.join(work, path.basename(row.audio_relative_path!)); verifyVoicePlaintext(roots, encrypted, row, restored);
    const target = voiceAbsolutePath(roots, row.audio_relative_path!); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) { if (fs.statSync(target).size !== row.audio_bytes || sha256File(target) !== row.audio_sha256) throw new Error("恢复目标已有不同内容的语音文件"); }
    else { const temporary = `${target}.restore-${process.pid}-${crypto.randomUUID()}`; fs.copyFileSync(restored, temporary); fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, target); }
    row = voiceRow(sqlite, transcriptionId, userId)!; voiceTransition(sqlite, row, ["restoring"], "local", "restore_complete", { audio_restored_at: new Date().toISOString(), audio_last_error: null });
  } catch (error) {
    const row = voiceRow(sqlite, transcriptionId, userId); if (row && ["restoring", "cold"].includes(row.audio_storage_state)) { try { voiceTransition(sqlite, row, [row.audio_storage_state], "error", "restore_error", { audio_last_error: error instanceof Error ? error.message.slice(0, 2_000) : "restore_failed" }); } catch {} }
    throw error;
  } finally { sqlite.close(); if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {} removeOperationLock(lock); }
}

export type VoicePurgeResult = { transcriptionId: string; isolatedPath: string; deleted: boolean; reason?: string };

export function purgeVoiceRecordingIsolation(rootsInput: Partial<ColdStorageRoots> = {}, graceDays = 7): VoicePurgeResult[] {
  const roots = defaultColdStorageRoots(rootsInput); if (!Number.isFinite(graceDays) || graceDays < 1) throw new Error("graceDays must be at least 1");
  const sqlite = openDb(roots.databasePath); const results: VoicePurgeResult[] = [];
  try {
    const cutoff = Date.now() - graceDays * DAY_MS;
    const rows = sqlite.prepare("SELECT id,audio_generation,audio_revision,audio_local_isolated_path,audio_updated_at FROM voice_transcriptions WHERE audio_storage_state='cold' AND audio_local_isolated_path IS NOT NULL").all() as Array<Pick<VoiceStorageRow, "id" | "audio_generation" | "audio_revision" | "audio_local_isolated_path" | "audio_updated_at">>;
    for (const row of rows) {
      if (!row.audio_updated_at || Date.parse(row.audio_updated_at) > cutoff) continue;
      const lock = acquireOperationLock(roots, `voice-${row.id}`);
      try {
        const source = path.resolve(row.audio_local_isolated_path!); const isolationRoot = path.resolve(roots.voiceIsolationRoot); if (!source.startsWith(`${isolationRoot}${path.sep}`)) throw new Error("语音隔离路径越界");
        if (!fs.existsSync(source)) { sqlite.prepare("UPDATE voice_transcriptions SET audio_local_isolated_path=NULL,audio_revision=audio_revision+1,audio_updated_at=? WHERE id=? AND audio_revision=? AND audio_storage_state='cold'").run(new Date().toISOString(), row.id, row.audio_revision); results.push({ transcriptionId: row.id, isolatedPath: source, deleted: true }); continue; }
        const trash = `${source}.purged-${crypto.randomUUID()}`; fs.renameSync(source, trash);
        const updated = sqlite.prepare("UPDATE voice_transcriptions SET audio_local_isolated_path=NULL,audio_revision=audio_revision+1,audio_updated_at=? WHERE id=? AND audio_revision=? AND audio_storage_state='cold'").run(new Date().toISOString(), row.id, row.audio_revision);
        if (!updated.changes) { try { fs.renameSync(trash, source); } catch {} throw new Error("语音清理 CAS 冲突"); }
        const next = voiceRow(sqlite, row.id)!; voiceAudit(sqlite, next, "cold", "cold", "local_isolation_purged", { graceDays });
        try { fs.rmSync(trash, { force: true }); } catch (error) { results.push({ transcriptionId: row.id, isolatedPath: source, deleted: false, reason: `已移出工作路径，等待删除: ${error instanceof Error ? error.message : "unknown"}` }); continue; }
        results.push({ transcriptionId: row.id, isolatedPath: source, deleted: true });
      } catch (error) { results.push({ transcriptionId: row.id, isolatedPath: row.audio_local_isolated_path!, deleted: false, reason: error instanceof Error ? error.message : "purge_failed" }); }
      finally { removeOperationLock(lock); }
    }
    return results;
  } finally { sqlite.close(); }
}

export function formatCandidateJson(candidates: ColdCandidate[]): string {
  return JSON.stringify(candidates, null, 2);
}
