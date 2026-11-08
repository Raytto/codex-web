import { verifiedWebBody } from "./web-presentation.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { HOST_ROOT_USER_ID } from "./host-root-user.js";
import type { ConversationStorageState } from "./db.js";
import { retryColdOperation } from "./cold-storage-maintenance.js";

import { collectConversationLineage, conversationThreadReferences, readLineageInventory, mutateThreadIndex, validateRestoredLineage, type ThreadLineage, type LineageInventory } from "./conversation-lineage.js";
import { acquireCodexLifecycleLock, assertNoUnmanagedCodexRuntime, codexHomeRuntimeBusy } from "./codex-lifecycle-lock.js";
import { isTransientRestoreBlock } from "../src/conversation-restore-state.js";

export const COLD_STORAGE_FORMAT = "conversation-cold-storage-v3";
const V2_COLD_STORAGE_FORMAT = "conversation-cold-storage-v2";
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

type FileRow = { presentation_mode?: "reader" | "web"; presentation_manifest?: string | null; sha256?: string | null;
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
  mode?: number;
  uid?: number;
  gid?: number;
};

export type ColdManifest = {
  format: typeof COLD_STORAGE_FORMAT | typeof V2_COLD_STORAGE_FORMAT | typeof LEGACY_COLD_STORAGE_FORMAT;
  conversationId: string;
  userId: string;
  threadId: string;
  generation: number;
  createdAt: string;
  plaintextBytes: number;
  entries: ColdManifestEntry[];
  lineage?: ThreadLineage;
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
  rootRolloutBytes: number;
  childRolloutBytes: number;
  childRollouts: number;
  lineageThreads: number;
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

export function sha256File(filePath: string): string {
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

export function safeRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("冷存储清单包含不安全路径");
  }
  return normalized;
}

function safeRootMember(root: string, relativePath: string): string {
  const parts = safeRelative(relativePath).split("/");
  let current = path.resolve(root);
  if (fs.existsSync(current) && fs.realpathSync(current) !== current) throw new Error("cold_storage_root_symlink");
  for (const part of parts) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("cold_storage_member_symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

export function openColdStorageDb(databasePath: string): DatabaseSync {
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
  return sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY id").all(conversationId) as FileRow[];
}

function sharedFileIds(sqlite: DatabaseSync, conversationId: string): Set<string> {
  const now = new Date().toISOString();
  const rows = sqlite.prepare(`
    SELECT DISTINCT f.id FROM files f
    LEFT JOIN public_file_shares share ON share.file_id=f.id AND share.enabled=1 AND share.expires_at>?
    LEFT JOIN public_file_share_assets asset ON asset.asset_file_id=f.id
    LEFT JOIN public_file_shares parent ON parent.id=asset.share_id AND parent.enabled=1 AND parent.expires_at>?
    WHERE f.conversation_id=? AND (share.file_id IS NOT NULL OR parent.id IS NOT NULL)
  `).all(now, now, conversationId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function storedManifest(row: StorageDbRow): ColdManifest | undefined {
  if (!row.manifest_json || !row.remote_path || !row.archive_sha256) return undefined;
  const manifest = JSON.parse(row.manifest_json) as ColdManifest;
  if (crypto.createHash("sha256").update(row.manifest_json).digest("hex") !== row.manifest_sha256
    || ![COLD_STORAGE_FORMAT, V2_COLD_STORAGE_FORMAT, LEGACY_COLD_STORAGE_FORMAT].includes(manifest.format)
    || manifest.conversationId !== row.conversation_id || manifest.userId !== row.user_id
    || manifest.threadId !== row.codex_thread_id || manifest.generation !== row.generation) {
    throw new Error("已有冷存储清单不一致");
  }
  return manifest;
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

function lineageFor(sqlite: DatabaseSync, roots: ColdStorageRoots, row: StorageDbRow, archivedEntries: ColdManifestEntry[] = [], inventory?: LineageInventory, references?: Map<string, Set<string>>) {
  return collectConversationLineage(sqlite, {
    conversationId: row.conversation_id, userId: row.user_id, executorId: row.executor_id!, codexHome: codexHomeFor(roots, row.user_id),
  }, archivedEntries.filter((entry) => entry.root === "codexHome").map((entry) => entry.relativePath), inventory, references);
}

function addEntry(entries: ColdManifestEntry[], kind: ColdManifestEntry["kind"], root: ColdManifestEntry["root"], rootPath: string, absolute: string): void {
  safeRootMember(rootPath, path.relative(rootPath, absolute));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`冷存储目标不是普通文件: ${absolute}`);
  entries.push({ kind, root, relativePath: safeRelative(path.relative(rootPath, absolute)), size: stat.size, sha256: fileSha256(absolute), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid });
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
      if (entry.name.startsWith(".ppa-transfer-")) continue;
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
  archivedEntries: ColdManifestEntry[] = [],
): ColdFileSource[] {
  const files = fileRows(sqlite, row.conversation_id);
  const protectedPaths = new Set(files.filter((file) => shared.has(file.id)).map((file) => file.relative_path));
  const sources: ColdFileSource[] = [];
  const seen = new Set<string>();
  const archivedPaths = new Set(archivedEntries.map((entry) => `${entry.root}:${entry.relativePath}`));
  for (const file of files) {
    // A path referenced by a shared file is protected even if a legacy DB has
    // a second file row pointing at the same path.
    if (shared.has(file.id) || protectedPaths.has(file.relative_path)) continue;
    let source: ColdFileSource | undefined;
    try { source = fileSourceFor(roots, row, file); } catch { reasons.push("unsafe_file_path"); continue; }
    if (!source) { reasons.push("unsupported_file_path"); continue; }
    if (!fs.existsSync(source.absolute)) {
      if (!archivedPaths.has(`${source.root}:${file.relative_path}`)) reasons.push("file_missing");
      continue;
    }
    const stat = fs.lstatSync(source.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { reasons.push("file_not_regular"); continue; }
    if (file.presentation_mode === "web") {
      try { verifiedWebBody(file, source.absolute); } catch { reasons.push("web_version_integrity"); continue; }
    }
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

function candidateFor(sqlite: DatabaseSync, roots: ColdStorageRoots, row: StorageDbRow, cutoff: number, inventory?: LineageInventory, references?: Map<string, Set<string>>): ColdCandidate {
  const reasons: string[] = [];
  const now = Date.now();
  const lastActive = row.last_active_at ? Date.parse(row.last_active_at) : 0;
  const ageHours = lastActive > 0 ? Math.max(0, (now - lastActive) / (60 * 60 * 1_000)) : Number.POSITIVE_INFINITY;
  if (!row.codex_thread_id) reasons.push("no_codex_thread");
  if (!row.executor_id || row.executor_id.startsWith("remote:")) reasons.push("remote_executor_unsupported");
  else if (row.executor_id !== (row.user_id === HOST_ROOT_USER_ID ? "local-host" : "tenant-local")) reasons.push("local_executor_scope_mismatch");
  if (row.status !== "idle" || row.external_status !== "idle") reasons.push("conversation_busy");
  if (row.deleted_at || row.deletion_state !== "active") reasons.push("deleting_or_deleted");
  const archived = Boolean(row.archived_at);
  // User-archived conversations are candidates on the next run; the 15-day
  // inactivity window applies only to ordinary, still-visible sessions.
  if (!archived && lastActive >= cutoff) reasons.push("active_within_15_days");
  if (!["local", "error", "cold"].includes(row.storage_state)) reasons.push(`storage_${row.storage_state}`);
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

  const shared = sharedFileIds(sqlite, row.conversation_id);
  const files = fileRows(sqlite, row.conversation_id);
  const drawingFiles = files.filter((file) => file.kind === "output" && /^image\//i.test(file.mime_type));
  const drawing = drawingFiles.length > 0;
  // A cold conversation may retain publicly shared files. Once they expire or
  // are closed, pick those local leftovers up without treating archived files
  // as missing. Archive restores the verified old generation before merging.
  let archivedEntries: ColdManifestEntry[] = [];
  if (["cold", "error"].includes(row.storage_state) && row.remote_path) {
    try { archivedEntries = storedManifest(row)?.entries ?? []; }
    catch { reasons.push("invalid_stored_manifest"); }
  }
  const coldFiles = coldFileSources(sqlite, roots, row, shared, reasons, archivedEntries);
  let rolloutBytes = 0;
  let rolloutEntries = 0;
  let rootRolloutBytes = 0;
  let childRolloutBytes = 0;
  let childRollouts = 0;
  let lineageThreads = 0;
  if (row.codex_thread_id && row.executor_id && !row.executor_id.startsWith("remote:")) {
    try {
      if (codexHomeRuntimeBusy(codexHomeFor(roots, row.user_id))) reasons.push("codex_runtime_active");
      const found = lineageFor(sqlite, roots, row, archivedEntries, inventory, references);
      reasons.push(...found.reasons);
      rolloutBytes = found.rollouts.reduce((sum, file) => sum + file.size, 0);
      rolloutEntries = found.rollouts.length;
      ({ rootRolloutBytes, childRolloutBytes, childRollouts } = found);
      lineageThreads = found.lineage.threads.length;
    } catch (error) { reasons.push(`lineage_scan_failed:${error instanceof Error ? error.message : "unknown"}`); }
  }
  const deliverableBytes = coldFiles.reduce((sum, source) => sum + source.file.size, 0);
  if (rolloutEntries === 0 && coldFiles.length === 0) reasons.push("no_local_cold_files");
  return {
    conversationId: row.conversation_id, userId: row.user_id, title: row.title, lastActiveAt: row.last_active_at,
    ageHours, state: row.storage_state, drawing, archived, eligible: reasons.length === 0, reasons,
    rolloutBytes, rootRolloutBytes, childRolloutBytes, childRollouts, lineageThreads, deliverableBytes, sharedFiles: shared.size, entries: rolloutEntries + coldFiles.length,
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
  const sqlite = new DatabaseSync(roots.databasePath, { readOnly: true });
  try {
    const cutoff = Date.now() - inactiveDays * DAY_MS;
    const rows = sqlite.prepare("SELECT c.id AS conversation_id,c.user_id,c.project_id,c.codex_thread_id,c.title,c.status,c.external_status,c.deleted_at,c.deletion_state,c.archived_at,c.last_active_at,p.executor_id,COALESCE(s.state,'local') AS storage_state,COALESCE(s.generation,0) AS generation,COALESCE(s.revision,0) AS revision,s.manifest_json,s.manifest_sha256,s.archive_sha256,s.archive_bytes,s.plaintext_bytes,s.remote_drive_id,s.remote_path,s.local_isolated_path,COALESCE(s.retry_count,0) AS retry_count,s.last_error FROM conversations c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN conversation_storage s ON s.conversation_id=c.id WHERE c.deleted_at IS NULL").all() as StorageDbRow[];
    const inventories = new Map<string, LineageInventory>();
    const referenceSets = new Map<string, Map<string, Set<string>>>();
    return rows.map((row) => {
      const home = codexHomeFor(roots, row.user_id);
      if (row.executor_id && !row.executor_id.startsWith("remote:") && !inventories.has(home)) {
        try { inventories.set(home, readLineageInventory(home)); } catch { /* candidate reports failure */ }
      }
      const key = `${row.user_id}:${row.executor_id}`;
      if (row.executor_id && !row.executor_id.startsWith("remote:") && !referenceSets.has(key)) {
        try { referenceSets.set(key, conversationThreadReferences(sqlite, row.user_id, row.executor_id)); } catch { /* candidate reports corrupt reference evidence */ }
      }
      return candidateFor(sqlite, roots, row, cutoff, inventories.get(home), referenceSets.get(key));
    }).sort((left, right) => {
      // Explicitly archived conversations take precedence within each snapshot.
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

const coldLockDescriptors = new Map<string, number>();

export function acquireColdStorageLock(roots: ColdStorageRoots, conversationId: string): string {
  const lockRoot = path.join(path.dirname(roots.isolationRoot), "locks");
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(lockRoot, conversationId);
  const fd = fs.openSync(`${lock}.flock`, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    execFileSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch {
      // Reclaim only a recorded, dead owner. A missing/malformed owner is not
      // proof of death (it can be the mkdir/write window of a live acquirer).
      const owner = Number(fs.readFileSync(path.join(lock, "owner"), "utf8").split("\n")[0]);
      if (!Number.isSafeInteger(owner) || owner < 1) throw new Error("冷存储锁 owner 无效");
      try { process.kill(owner, 0); throw new Error("该会话已有归档或恢复操作正在执行"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const stale = `${lock}.stale-${crypto.randomUUID()}`;
      fs.renameSync(lock, stale);
      try { fs.mkdirSync(lock, { mode: 0o700 }); } finally { fs.rmSync(stale, { recursive: true }); }
    }
    fs.writeFileSync(path.join(lock, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
    coldLockDescriptors.set(lock, fd);
    return lock;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function removeColdStorageLock(lock: string): void {
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
  const fd = coldLockDescriptors.get(lock);
  if (fd !== undefined) { coldLockDescriptors.delete(lock); fs.closeSync(fd); }
}

export function runAliyun(roots: ColdStorageRoots, args: string[], timeout = 6 * 60 * 60_000): string {
  return execFileSync(roots.aliyunpan, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
}

function assertColdStorageConfigured(roots: ColdStorageRoots): void {
  if (!roots.aliyunpan.trim() || !roots.driveId.trim()) throw new Error("冷存储 provider/Drive ID 尚未配置");
  if (!fs.existsSync(roots.ageRecipient) || !fs.existsSync(roots.ageIdentity)) throw new Error("age 密钥边界不可用");
}

function remoteTree(roots: ColdStorageRoots, remotePath: string): string {
  return retryColdOperation(() => {
    const listing = runAliyun(roots, ["tree", "--driveId", roots.driveId, "-fp", remotePath]);
    // The CLI sometimes exits zero after a failed API request. Never confuse
    // an invalid listing with an empty directory and upload a duplicate.
    if (!listing.split(/\r?\n/).some((line) => line.trim() === remotePath)) throw new Error(`云端目录读取失败: ${remotePath}`);
    return listing;
  });
}

function ensureRemoteDirectory(roots: ColdStorageRoots, remotePath: string): void {
  const verify = () => {
    // tree recursively enumerates every conversation below the archive root. Directory
    // creation needs only the bounded direct listing and its exact root header.
    const listing = runAliyun(roots, ["ls", "--driveId", roots.driveId, remotePath], 120_000);
    if (!listing.split(/\r?\n/).some((line) => line.trim() === `当前目录: ${remotePath}`)) throw new Error(`云端目录读取失败: ${remotePath}`);
  };
  retryColdOperation(() => {
    try { retryColdOperation(verify); return; } catch { /* create below */ }
    runAliyun(roots, ["mkdir", "--driveId", roots.driveId, remotePath], 120_000);
    verify();
  });
}

export function ensureRemotePath(roots: ColdStorageRoots, remotePath: string): void {
  const parts = remotePath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) { current += `/${part}`; ensureRemoteDirectory(roots, current); }
}

export function remoteObjectVisible(roots: ColdStorageRoots, remotePath: string): boolean {
  const parent = path.posix.dirname(remotePath);
  const name = path.posix.basename(remotePath);
  return remoteTree(roots, parent).split(/\r?\n/).some((line) => line.includes(`-> ${remotePath}`) || line.trim().endsWith(`/${name}`));
}

export function uploadColdArchive(roots: ColdStorageRoots, stage: string, remoteDirectory: string): void {
  const remotePath = path.posix.join(remoteDirectory, path.basename(stage));
  retryColdOperation(() => {
    // File names include the ciphertext hash. An upload may have committed
    // before its process failed: check that exact object before each retry.
    // Callers still download and verify its size/hash before local eviction.
    if (remoteObjectVisible(roots, remotePath)) return;
    runAliyun(roots, ["upload", "--driveId", roots.driveId, "--np", "--retry", "5", "--timeout", "120", stage, remoteDirectory]);
    if (!remoteObjectVisible(roots, remotePath)) throw new Error("归档上传后云端精确对象不可见");
  });
}

export function stageForUpload(roots: ColdStorageRoots, source: string): string {
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

export function prepareDownloadDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const uid = Number(execFileSync("id", ["-u", "aliyunpan"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "aliyunpan"], { encoding: "utf8" }).trim());
    fs.chownSync(directory, uid, gid);
    fs.chmodSync(directory, 0o700);
  } catch (error) { throw new Error(`阿里云盘下载目录权限不可用: ${error instanceof Error ? error.message : "unknown"}`); }
}

export function findDownloadedFile(root: string, name: string, fallbackRoots: string[] = []): string {
  const matches: string[] = [];
  const visited = new Set<string>();
  const visit = (directory: string): void => {
    const resolved = path.resolve(directory);
    if (visited.has(resolved) || !fs.existsSync(resolved)) return;
    visited.add(resolved);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".ppa-transfer-")) continue;
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

export function packageArchive(roots: ColdStorageRoots, staging: string, archivePath: string): void {
  const plain = `${archivePath}.plain`;
  execFileSync("tar", ["-cf", plain, "--sort=name", "-C", staging, "."], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
  try { execFileSync(roots.age, ["-R", roots.ageRecipient, "-o", archivePath, plain], { stdio: "ignore", timeout: 6 * 60 * 60_000 }); }
  finally { try { fs.unlinkSync(plain); } catch {} }
}

export function verifyAgeArchive(roots: ColdStorageRoots, archivePath: string): void {
  execFileSync(roots.age, ["-d", "-i", roots.ageIdentity, archivePath], { stdio: ["ignore", "ignore", "pipe"], timeout: 6 * 60 * 60_000 });
}

function copyOrLink(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
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
      const source = safeRootMember(sourceRoot, entry.relativePath);
      if (!fs.existsSync(source)) throw new Error(`归档前文件消失: ${entry.relativePath}`);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || fileSha256(source) !== entry.sha256) throw new Error(`归档前文件已变化: ${entry.relativePath}`);
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
  const lock = acquireColdStorageLock(roots, conversationId);
  const sqlite = openColdStorageDb(roots.databasePath);
  let work = "";
  let releaseHome: (() => void) | undefined;
  try {
    let row = rowForConversation(sqlite, conversationId);
    if (!row) throw new Error("会话不存在");
    if (!row.executor_id || row.executor_id.startsWith("remote:")) throw new Error("remote_executor_unsupported");
    if (row.storage_state === "uploading") row = transition(sqlite, row, ["uploading"], "local", "interrupted_upload_retained");
    if (["remote_verified", "evicting", "restoring"].includes(row.storage_state)) {
      row = transition(sqlite, row, [row.storage_state], "error", "interrupted_operation_recovered");
      if (row.remote_path) restoreColdConversationLocked(roots, sqlite, conversationId, row.user_id);
      else row = transition(sqlite, row, ["error"], "local", "interrupted_upload_retained");
      row = rowForConversation(sqlite, conversationId)!;
    }
    const candidate = candidateFor(sqlite, roots, row, Date.now() - 15 * DAY_MS);
    if (!candidate.eligible) throw new Error(`会话不满足冷存储条件: ${candidate.reasons.join(",")}`);
    assertColdStorageConfigured(roots);
    if (["cold", "error"].includes(row.storage_state) && row.remote_path) {
      restoreColdConversationLocked(roots, sqlite, conversationId, row.user_id);
      row = rowForConversation(sqlite, conversationId)!;
      const refreshed = candidateFor(sqlite, roots, row, Date.now() - 15 * DAY_MS);
      if (!refreshed.eligible) throw new Error(`恢复后会话不满足冷存储条件: ${refreshed.reasons.join(",")}`);
    }
    releaseHome = acquireCodexLifecycleLock(codexHomeFor(roots, row.user_id));
    const generation = row.generation + 1;
    // Keep the old generation usable if upload/verification fails. Advance it
    // atomically with its new verified manifest, never before that point.
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      row = rowForConversation(sqlite, conversationId)!;
      const gate = candidateFor(sqlite, roots, row, Date.now() - 15 * DAY_MS);
      if (!gate.eligible) throw new Error(`归档门禁已变化: ${gate.reasons.join(",")}`);
      row = transition(sqlite, row, ["local", "error"], "uploading", "archive_begin", { retry_count: 0, last_error: null });
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    work = fs.mkdtempSync(path.join(path.dirname(roots.isolationRoot), `.package-${conversationId}-`));
    const codexHome = codexHomeFor(roots, row.user_id);
    const entries: ColdManifestEntry[] = [];
    const found = lineageFor(sqlite, roots, row);
    if (found.reasons.length) throw new Error(`lineage: ${found.reasons.join(",")}`);
    assertNoUnmanagedCodexRuntime(codexHome, found.rollouts.map((file) => path.join(codexHome, file.relativePath)));
    for (const file of found.rollouts) addEntry(entries, "rollout", "codexHome", codexHome, path.join(codexHome, file.relativePath));
    const shared = sharedFileIds(sqlite, conversationId);
    const fileReasons: string[] = [];
    const coldFiles = coldFileSources(sqlite, roots, row, shared, fileReasons);
    if (fileReasons.length) throw new Error(`会话文件不满足冷存储条件: ${[...new Set(fileReasons)].join(",")}`);
    for (const source of coldFiles) addEntry(entries, "file", source.root, source.rootPath, source.absolute);
    if (!entries.length) throw new Error("没有可归档的 rollout 或会话文件");
    const manifest: ColdManifest = {
      format: COLD_STORAGE_FORMAT, conversationId, userId: row.user_id, threadId: row.codex_thread_id!, generation,
      lineage: found.lineage,
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
    for (const entry of entries) {
      const staged = path.join(work, entry.kind, entry.relativePath);
      if (fs.statSync(staged).size !== entry.size || fileSha256(staged) !== entry.sha256) throw new Error("snapshot_copy_changed");
    }
    const archiveLocal = path.join(work, `generation-${generation}.tar.age`);
    packageArchive(roots, work, archiveLocal);
    verifyAgeArchive(roots, archiveLocal);
    const archiveSha256 = sha256File(archiveLocal);
    const archiveBytes = fs.statSync(archiveLocal).size;
    // The upload uses an immutable independent snapshot. Let unrelated Home
    // jobs run during network I/O; reacquire and revalidate before eviction.
    releaseHome(); releaseHome = undefined;
    const remoteDirectory = `${roots.remoteRoot}/${row.user_id}/${conversationId}`;
    const remotePath = `${remoteDirectory}/generation-${generation}-${archiveSha256}.tar.age`;
    const remoteArchiveLocal = path.join(work, path.basename(remotePath));
    fs.renameSync(archiveLocal, remoteArchiveLocal);
    ensureRemotePath(roots, remoteDirectory);
    const stage = stageForUpload(roots, remoteArchiveLocal);
    try { uploadColdArchive(roots, stage, remoteDirectory); }
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
    audit(sqlite, conversationId, generation, row.revision, "uploading", "uploading", "candidate_remote_verified", { remotePath, archiveSha256, archiveBytes, manifestSha256 });
    releaseHome = acquireCodexLifecycleLock(codexHome);
    row = rowForConversation(sqlite, conversationId)!;
    const finalGate = candidateFor(sqlite, roots, { ...row, storage_state: "local" }, Date.now() - 15 * DAY_MS);
    if (!finalGate.eligible) throw new Error(`归档门禁已变化: ${finalGate.reasons.join(",")}`);
    const latest = lineageFor(sqlite, roots, row);
    if (latest.reasons.length || JSON.stringify(latest.lineage) !== JSON.stringify(found.lineage)) throw new Error("lineage_snapshot_changed");
    assertNoUnmanagedCodexRuntime(codexHome, latest.rollouts.map((file) => path.join(codexHome, file.relativePath)));
    for (const entry of entries) {
      const sourceRoot = entry.root === "codexHome" ? codexHome : entry.root === "conversation" ? conversationWorkspaceFor(roots, row.user_id, conversationId) : roots.dataRoot;
      const source = path.join(sourceRoot, entry.relativePath);
      if (fs.statSync(source).size !== entry.size || fileSha256(source) !== entry.sha256) throw new Error("snapshot_source_changed");
    }
    row = transition(sqlite, row, ["uploading"], "remote_verified", "remote_verify", {
      generation,
      manifest_json: manifestText, manifest_sha256: manifestSha256, archive_sha256: archiveSha256, archive_bytes: archiveBytes,
      plaintext_bytes: manifest.plaintextBytes, remote_drive_id: roots.driveId, remote_path: remotePath,
      uploaded_at: new Date().toISOString(), verified_at: new Date().toISOString(), last_error: null,
    });
    row = transition(sqlite, row, ["remote_verified"], "evicting", "local_evict_begin");
    const isolatedPath = moveToIsolation(roots, manifest, conversationId);
    mutateThreadIndex(codexHome, found.lineage.index, "remove");
    row = rowForConversation(sqlite, conversationId)!;
    transition(sqlite, row, ["evicting"], "cold", "local_evict_complete", { local_isolated_path: isolatedPath, last_error: null });
    // Every generation keeps its own isolation clock and verification record.
    // A later archive or restore never authorizes early deletion of this one.
    return { conversationId, generation, archiveBytes, plaintextBytes: manifest.plaintextBytes, archiveSha256, manifestSha256, remotePath, isolatedPath };
  } catch (error) {
    const row = rowForConversation(sqlite, conversationId);
    if (row && ["uploading", "remote_verified", "evicting"].includes(row.storage_state)) {
      try {
        const next = transition(sqlite, row, [row.storage_state], row.storage_state === "uploading" ? "local" : "error", "archive_error", { last_error: error instanceof Error ? error.message.slice(0, 2_000) : "archive_failed" });
        sqlite.prepare("UPDATE conversation_storage SET retry_count=retry_count+1 WHERE conversation_id=? AND revision=?").run(conversationId, next.revision);
      } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    sqlite.close();
    if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    releaseHome?.();
    removeColdStorageLock(lock);
  }
}

function restoreFilesFromExtract(roots: ColdStorageRoots, manifest: ColdManifest, extractRoot: string): void {
  const installed: Array<{ source: string; target: string }> = [];
  try {
    for (const entry of manifest.entries) {
      const source = safeRootMember(extractRoot, `${entry.kind}/${entry.relativePath}`);
      const targetRoot = entry.root === "codexHome"
        ? codexHomeFor(roots, manifest.userId)
        : entry.root === "conversation"
          ? conversationWorkspaceFor(roots, manifest.userId, manifest.conversationId)
          : roots.dataRoot;
      const target = safeRootMember(targetRoot, entry.relativePath);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || fileSha256(source) !== entry.sha256) throw new Error(`冷存储成员校验失败: ${entry.relativePath}`);
      if (fs.existsSync(target)) {
        const existing = fs.lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== entry.size || fileSha256(target) !== entry.sha256) throw new Error(`恢复目标已存在且内容不同: ${entry.relativePath}`);
        continue;
      }
      const temporary = `${target}.cold-restore-${process.pid}-${crypto.randomUUID()}`;
      const created: string[] = [];
      for (let dir = path.dirname(target); !fs.existsSync(dir); dir = path.dirname(dir)) created.push(dir);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const owner = fs.statSync(targetRoot);
      if (process.getuid?.() === 0) for (const dir of created) fs.chownSync(dir, owner.uid, owner.gid);
      fs.copyFileSync(source, temporary);
      fs.chmodSync(temporary, entry.mode ?? (stat.mode & 0o777));
      if (process.getuid?.() === 0) fs.chownSync(temporary, entry.uid ?? owner.uid, entry.gid ?? owner.gid);
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
  const lock = acquireColdStorageLock(roots, conversationId);
  const sqlite = openColdStorageDb(roots.databasePath);
  try {
    const row = rowForConversation(sqlite, conversationId, userId);
    if (!row || !row.executor_id || row.executor_id.startsWith("remote:")) throw new Error("local_conversation_required");
    if (row.storage_state === "uploading") { transition(sqlite, row, ["uploading"], "local", "interrupted_upload_retained"); return; }
    if (["remote_verified", "evicting"].includes(row.storage_state)) transition(sqlite, row, [row.storage_state], "error", "interrupted_operation_recovered");
    restoreColdConversationLocked(roots, sqlite, conversationId, userId);
  }
  finally { sqlite.close(); removeColdStorageLock(lock); }
}

// The archive path reuses this under the same conversation lock, so a residual
// share cannot race an independent restore or discard the earlier manifest.
function restoreColdConversationLocked(roots: ColdStorageRoots, sqlite: DatabaseSync, conversationId: string, userId: string): void {
  let downloadWork = "";
  let extractWork = "";
  let releaseHome: (() => void) | undefined;
  try {
    let row = rowForConversation(sqlite, conversationId, userId);
    if (!row) throw new Error("会话不存在或账号不匹配");
    if (row.storage_state === "local") return;
    if (!row.remote_path || !row.archive_sha256 || !row.manifest_sha256 || !row.manifest_json) throw new Error("冷存储清单不完整");
    const remotePath = row.remote_path;
    const manifestSha256 = row.manifest_sha256;
    const manifestJson = row.manifest_json;
    if (!["cold", "restoring", "error"].includes(row.storage_state)) throw new Error(`当前状态不能恢复: ${row.storage_state}`);
    if (row.storage_state !== "restoring") row = transition(sqlite, row, ["cold", "error"], "restoring", "restore_begin");
    // Avoid repeatedly downloading the archive while another runtime owns this
    // Home. Recheck under the exclusive lease before installing any files.
    releaseHome = acquireCodexLifecycleLock(codexHomeFor(roots, userId));
    assertNoUnmanagedCodexRuntime(codexHomeFor(roots, userId), []);
    releaseHome(); releaseHome = undefined;
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
    if (![COLD_STORAGE_FORMAT, V2_COLD_STORAGE_FORMAT, LEGACY_COLD_STORAGE_FORMAT].includes(manifest.format) || manifest.conversationId !== conversationId || manifest.userId !== userId || manifest.threadId !== row.codex_thread_id || manifest.generation !== row.generation) throw new Error("恢复 manifest 身份或代次不一致");
    if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(manifestJson))) throw new Error("恢复 manifest 内容与数据库不一致");
    if (manifest.format === COLD_STORAGE_FORMAT && (!manifest.lineage || manifest.lineage.userId !== userId || manifest.lineage.executorId !== row.executor_id || manifest.lineage.codexHome !== codexHomeFor(roots, userId))) throw new Error("lineage_scope_mismatch");
    releaseHome = acquireCodexLifecycleLock(codexHomeFor(roots, userId));
    assertNoUnmanagedCodexRuntime(codexHomeFor(roots, userId), manifest.entries.filter((entry) => entry.root === "codexHome").map((entry) => path.join(codexHomeFor(roots, userId), entry.relativePath)));
    restoreFilesFromExtract(roots, manifest, extractWork);
    for (const file of fileRows(sqlite, conversationId)) {
      if (file.presentation_mode !== "web") continue;
      const source = fileSourceFor(roots, row, file);
      if (!source) throw new Error("web_version_path_invalid");
      verifiedWebBody(file, source.absolute);
    }
    if (manifest.lineage) {
      validateRestoredLineage(codexHomeFor(roots, userId), manifest.lineage);
      mutateThreadIndex(codexHomeFor(roots, userId), manifest.lineage.index, "restore");
    }
    row = rowForConversation(sqlite, conversationId, userId)!;
    transition(sqlite, row, ["restoring"], "local", "restore_complete", { restored_at: new Date().toISOString(), last_error: null });
  } catch (error) {
    const row = rowForConversation(sqlite, conversationId, userId);
    if (row && ["restoring", "cold"].includes(row.storage_state)) {
      try {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : "restore_failed";
        const waiting = isTransientRestoreBlock(message);
        // Occupancy is temporary. Persist the restore intent for the Web
        // scheduler (including after restart), without counting it as failure.
        if (!waiting || row.last_error !== message) {
          const next = transition(sqlite, row, [row.storage_state], waiting ? "restoring" : "error", waiting ? "restore_waiting_for_runtime" : "restore_error", { last_error: message });
          if (!waiting) sqlite.prepare("UPDATE conversation_storage SET retry_count=retry_count+1 WHERE conversation_id=? AND revision=?").run(conversationId, next.revision);
        }
      } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    releaseHome?.();
    if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {}
    if (extractWork) try { fs.rmSync(extractWork, { recursive: true, force: true }); } catch {}
    if (extractWork) try { fs.rmSync(`${extractWork}.plain.tar`, { force: true }); } catch {}
  }
}

export function coldStorageSummary(rootsInput: Partial<ColdStorageRoots> = {}) {
  const roots = defaultColdStorageRoots(rootsInput);
  const sqlite = new DatabaseSync(roots.databasePath, { readOnly: true });
  try {
    const rows = sqlite.prepare("SELECT state,count(*) AS conversations,COALESCE(sum(archive_bytes),0) AS archive_bytes,COALESCE(sum(plaintext_bytes),0) AS plaintext_bytes FROM conversation_storage GROUP BY state ORDER BY state").all();
    return { rows, candidates: listColdCandidates(roots) };
  } finally { sqlite.close(); }
}

/** Read-only capacity inventory. Unattributed records are reported, never
 * treated as a deletion list. Public legacy Homes and Remote Workers are out
 * of scope. Bytes here are logical sizes, separately from allocated blocks. */
export function auditConversationLineage(rootsInput: Partial<ColdStorageRoots> = {}) {
  const roots = defaultColdStorageRoots(rootsInput);
  const sqlite = new DatabaseSync(roots.databasePath, { readOnly: true });
  try {
    const scopes = sqlite.prepare("SELECT DISTINCT c.user_id,p.executor_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE p.executor_id NOT LIKE 'remote:%'").all() as Array<{ user_id: string; executor_id: string }>;
    return scopes.map((scope) => {
      const home = codexHomeFor(roots, scope.user_id);
      const inventory = readLineageInventory(home);
      const references = conversationThreadReferences(sqlite, scope.user_id, scope.executor_id);
      const conversationIds = new Set([...references.values()].flatMap((ids) => [...ids]));
      const attributed = new Map<string, Set<string>>();
      const skipped: Array<{ conversationId: string; reasons: string[] }> = [];
      for (const id of conversationIds) {
        const row = rowForConversation(sqlite, id)!;
        const manifest = storedManifest(row);
        const found = lineageFor(sqlite, roots, row, manifest?.entries, inventory, references);
        if (found.reasons.length) skipped.push({ conversationId: id, reasons: found.reasons });
        for (const file of found.rollouts) {
          if (!attributed.has(file.relativePath)) attributed.set(file.relativePath, new Set());
          attributed.get(file.relativePath)!.add(id);
        }
      }
      const counts = { root: { files: 0, bytes: 0, allocatedBytes: 0 }, descendant: { files: 0, bytes: 0, allocatedBytes: 0 }, unresolved: { files: 0, bytes: 0, allocatedBytes: 0 } };
      const unresolved: Array<{ threadId: string | null; reason: string; bytes: number }> = [];
      for (const file of inventory.rollouts) {
        const owners = attributed.get(file.relativePath);
        const kind = owners?.size === 1 ? (file.parentId ? "descendant" : "root") : "unresolved";
        counts[kind].files += 1; counts[kind].bytes += file.size; counts[kind].allocatedBytes += file.allocated;
        if (kind === "unresolved") unresolved.push({ threadId: file.id, bytes: file.size, reason: owners?.size ? "multiple_conversation_references" : "no_trusted_conversation_lineage" });
      }
      for (const file of inventory.unclassified) {
        counts.unresolved.files += 1; counts.unresolved.bytes += file.size;
        unresolved.push({ threadId: null, bytes: file.size, reason: file.reason });
      }
      return { userId: scope.user_id, executorId: scope.executor_id, counts, unresolved, skipped };
    });
  } finally { sqlite.close(); }
}

/** Called only after the Web tombstone and runtime drain. Remote ciphertext
 * follows the existing retained-backup policy; keep its recovery receipt even
 * after the conversation's cascading DB rows are removed. */
export function garbageCollectConversationRecords(rootsInput: Partial<ColdStorageRoots>, conversationId: string, userId: string): number {
  const roots = defaultColdStorageRoots(rootsInput);
  assertUuid(conversationId, "conversation id"); assertUuid(userId, "user id");
  const lock = acquireColdStorageLock(roots, conversationId);
  const sqlite = openColdStorageDb(roots.databasePath);
  let releaseHome: (() => void) | undefined;
  try {
    const row = rowForConversation(sqlite, conversationId, userId);
    if (!row) return 0;
    if (!row.deleted_at || !["deleting", "cleanup_failed"].includes(row.deletion_state)) throw new Error("conversation_tombstone_required");
    if (!row.executor_id || row.executor_id.startsWith("remote:")) throw new Error("local_conversation_required");
    const active = sqlite.prepare("SELECT 1 FROM jobs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conversationId);
    if (active) throw new Error("conversation_jobs_not_drained");
    const home = codexHomeFor(roots, userId);
    releaseHome = acquireCodexLifecycleLock(home);
    const previous = storedManifest(row);
    const directory = path.join(path.dirname(roots.isolationRoot), "gc-receipts");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(directory, `${conversationId}.json`);
    const inventory = readLineageInventory(home);
    if (fs.existsSync(receiptPath)) {
      const prior = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { conversationId: string; userId: string; executorId: string; threads: ThreadLineage["threads"] };
      if (prior.conversationId !== conversationId || prior.userId !== userId || prior.executorId !== row.executor_id) throw new Error("gc_receipt_scope_mismatch");
      // A previous attempt may have removed the root before a child. Retain
      // traversal evidence until the whole tombstone saga has completed.
      for (const thread of prior.threads) if (thread.parentId) inventory.edges.push({ parent_thread_id: thread.parentId, child_thread_id: thread.id, status: "gc_receipt" });
    }
    const found = lineageFor(sqlite, roots, row, previous?.entries, inventory);
    const errors = found.reasons.filter((reason) => !["shared_codex_thread", "lineage_rollout_missing", "lineage_thread_missing"].includes(reason));
    if (errors.length) throw new Error(`lineage_gc_unsafe:${errors.join(",")}`);
    assertNoUnmanagedCodexRuntime(home, found.rollouts.map((file) => path.join(home, file.relativePath)));
    const shared = found.reasons.includes("shared_codex_thread");
    const receipt = {
      conversationId, userId, executorId: row.executor_id, at: new Date().toISOString(),
      retainedReason: shared ? "shared_codex_thread" : null,
      remotePolicy: "retain_encrypted_backup", remotePath: row.remote_path,
      manifestSha256: row.manifest_sha256, archiveSha256: row.archive_sha256,
      generation: row.generation, threads: found.lineage.threads,
    };
    if (!fs.existsSync(receiptPath)) fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
    if (shared) return 0;
    mutateThreadIndex(home, found.lineage.index, "remove");
    for (const file of found.rollouts) fs.unlinkSync(path.join(home, file.relativePath));
    // Only this conversation's controlled isolation tree, never a whole Home.
    const isolated = path.join(roots.isolationRoot, conversationId);
    if (fs.existsSync(isolated)) {
      if (fs.lstatSync(isolated).isSymbolicLink()) throw new Error("gc_isolation_symlink");
      fs.rmSync(isolated, { recursive: true });
    }
    return found.rollouts.length;
  } finally { releaseHome?.(); sqlite.close(); removeColdStorageLock(lock); }
}

export type ColdPurgeResult = { conversationId: string; isolatedPath: string; deleted: boolean; reason?: string };

/** Remove only delayed local isolation copies after the configured grace period.
 * The encrypted remote object remains the source of truth for a future restore. */
export function purgeColdIsolated(rootsInput: Partial<ColdStorageRoots> = {}, graceDays = 7): ColdPurgeResult[] {
  const roots = defaultColdStorageRoots(rootsInput);
  if (!Number.isFinite(graceDays) || graceDays < 1) throw new Error("graceDays must be at least 1");
  const sqlite = openColdStorageDb(roots.databasePath);
  const results: ColdPurgeResult[] = [];
  try {
    const cutoff = Date.now() - graceDays * DAY_MS;
    const rows = sqlite.prepare("SELECT conversation_id,generation,revision,state,local_isolated_path,updated_at FROM conversation_storage WHERE state='cold' AND local_isolated_path IS NOT NULL").all() as Array<{ conversation_id: string; generation: number; revision: number; state: string; local_isolated_path: string; updated_at: string }>;
    for (const row of rows) {
      if (Date.parse(row.updated_at) > cutoff) continue;
      const lock = acquireColdStorageLock(roots, row.conversation_id);
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
      finally { removeColdStorageLock(lock); }
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
  const sqlite = openColdStorageDb(roots.databasePath);
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
  const lock = acquireColdStorageLock(roots, `voice-${transcriptionId}`); const sqlite = openColdStorageDb(roots.databasePath); let work = ""; let downloadWork = "";
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
    try { uploadColdArchive(roots, stage, remoteDirectory); } finally { try { fs.unlinkSync(stage); } catch {} }
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
  } finally { sqlite.close(); if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {} if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} removeColdStorageLock(lock); }
}

export function restoreVoiceRecording(rootsInput: Partial<ColdStorageRoots>, transcriptionId: string, userId: string): void {
  const roots = defaultColdStorageRoots(rootsInput); assertUuid(transcriptionId, "transcription id"); assertUuid(userId, "user id");
  const lock = acquireColdStorageLock(roots, `voice-${transcriptionId}`); const sqlite = openColdStorageDb(roots.databasePath); let downloadWork = ""; let work = "";
  try {
    let row = voiceRow(sqlite, transcriptionId, userId); if (!row) throw new Error("语音记录不存在或账号不匹配"); if (row.audio_storage_state === "local") return;
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
  } finally { sqlite.close(); if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {} removeColdStorageLock(lock); }
}

export type VoicePurgeResult = { transcriptionId: string; isolatedPath: string; deleted: boolean; reason?: string };

export function purgeVoiceRecordingIsolation(rootsInput: Partial<ColdStorageRoots> = {}, graceDays = 7): VoicePurgeResult[] {
  const roots = defaultColdStorageRoots(rootsInput); if (!Number.isFinite(graceDays) || graceDays < 1) throw new Error("graceDays must be at least 1");
  const sqlite = openColdStorageDb(roots.databasePath); const results: VoicePurgeResult[] = [];
  try {
    const cutoff = Date.now() - graceDays * DAY_MS;
    const rows = sqlite.prepare("SELECT id,audio_generation,audio_revision,audio_local_isolated_path,audio_updated_at FROM voice_transcriptions WHERE audio_storage_state='cold' AND audio_local_isolated_path IS NOT NULL").all() as Array<Pick<VoiceStorageRow, "id" | "audio_generation" | "audio_revision" | "audio_local_isolated_path" | "audio_updated_at">>;
    for (const row of rows) {
      if (!row.audio_updated_at || Date.parse(row.audio_updated_at) > cutoff) continue;
      const lock = acquireColdStorageLock(roots, `voice-${row.id}`);
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
      finally { removeColdStorageLock(lock); }
    }
    return results;
  } finally { sqlite.close(); }
}

export function formatCandidateJson(candidates: ColdCandidate[]): string {
  return JSON.stringify(candidates, null, 2);
}
