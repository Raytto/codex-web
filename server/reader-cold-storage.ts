import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  acquireColdStorageLock, defaultColdStorageRoots, findDownloadedFile, openColdStorageDb, packageArchive,
  prepareDownloadDirectory, remoteObjectVisible, removeColdStorageLock, runAliyun, safeRelative,
  sha256File, stageForUpload, ensureRemotePath, verifyAgeArchive, type ColdStorageRoots,
} from "./conversation-cold-storage.js";
import { READER_V1_RETENTION_DAYS } from "./reader-policy.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const READER_REMOTE_ROOT = "/codex-web/readers";
const READER_ARCHIVE_FORMAT = "reader-normalized-v1";

export type ReaderColdRoots = ColdStorageRoots & { readerIsolationRoot: string; readerRemoteRoot: string };
export type ReaderColdCandidate = {
  versionId: string;
  sourceId: string;
  userId: string;
  fileId: string;
  title: string;
  format: string;
  status: string;
  storageState: string;
  lastAccessedAt: string;
  ageHours: number;
  bytes: number;
  eligible: boolean;
  reasons: string[];
};
export type ReaderColdArchiveResult = { versionId: string; generation: number; archiveBytes: number; plaintextBytes: number; archiveSha256: string; remotePath: string; isolatedPath: string };

type ReaderStorageRow = {
  id: string; source_id: string; user_id: string; file_id: string; title: string; format: string; derived_kind: string; status: string;
  storage_state: string; storage_generation: number; storage_revision: number; normalized_root: string | null;
  last_accessed_at: string; storage_manifest_json: string | null; storage_manifest_sha256: string | null;
  storage_archive_sha256: string | null; storage_archive_bytes: number | null; storage_plaintext_bytes: number | null;
  remote_drive_id: string | null; remote_path: string | null; local_isolated_path: string | null;
  last_error: string | null;
};

function assertReaderId(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`阅读${label}格式无效`);
  }
}

function assertNoSymlinkAncestors(base: string, target: string): void {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relativeTarget = path.relative(resolvedBase, resolvedTarget);
  if (path.isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) throw new Error("阅读资源路径越界");
  try {
    const baseStat = fs.lstatSync(resolvedBase);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error("阅读资源根目录类型不安全");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let current = resolvedBase;
  for (const part of (relativeTarget || "").split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("阅读资源目录类型不安全");
  }
}

function readerRoots(input: Partial<ReaderColdRoots> = {}): ReaderColdRoots {
  const base = defaultColdStorageRoots(input);
  return {
    ...base,
    readerIsolationRoot: input.readerIsolationRoot ?? path.join(path.dirname(base.isolationRoot), "reader-isolated"),
    readerRemoteRoot: input.readerRemoteRoot ?? READER_REMOTE_ROOT,
  };
}

function rowFor(sqlite: DatabaseSync, versionId: string, userId?: string): ReaderStorageRow | undefined {
  return sqlite.prepare(`
    SELECT version.id,version.source_id,version.user_id,version.file_id,source.title,source.format,version.derived_kind,version.status,
      version.storage_state,version.storage_generation,version.storage_revision,version.normalized_root,
      version.last_accessed_at,version.storage_manifest_json,version.storage_manifest_sha256,version.storage_archive_sha256,
      version.storage_archive_bytes,version.storage_plaintext_bytes,version.remote_drive_id,version.remote_path,
      version.local_isolated_path,version.last_error
    FROM reading_source_versions version JOIN reading_sources source ON source.id=version.source_id
    WHERE version.id=? ${userId ? "AND version.user_id=?" : ""}
  `).get(...(userId ? [versionId, userId] : [versionId])) as ReaderStorageRow | undefined;
}

function readerVersionIsActive(sqlite: DatabaseSync, row: ReaderStorageRow): boolean {
  const match = sqlite.prepare(`
    SELECT 1 AS present
    FROM reading_source_versions version
    JOIN reading_sources source ON source.id=version.source_id AND source.user_id=version.user_id AND source.file_id=version.file_id
    JOIN files file ON file.id=version.file_id
    JOIN conversations conversation ON conversation.id=file.conversation_id AND conversation.user_id=version.user_id
    WHERE version.id=? AND version.user_id=? AND conversation.deleted_at IS NULL AND conversation.deletion_state='active'
  `).get(row.id, row.user_id) as { present?: number } | undefined;
  return Boolean(match?.present);
}

function rootPath(roots: ReaderColdRoots, row: ReaderStorageRow): string {
  assertReaderId(row.user_id, "账号 ID");
  assertReaderId(row.id, "版本 ID");
  assertReaderId(row.source_id, "来源 ID");
  assertReaderId(row.file_id, "文件 ID");
  if (!row.normalized_root) throw new Error("阅读版本缺少规范化目录");
  const root = path.resolve(roots.dataRoot, row.normalized_root);
  const allowed = path.resolve(path.join(roots.dataRoot, "reader-resources"));
  if (!root.startsWith(`${allowed}${path.sep}`)) throw new Error("规范化目录越界");
  const expected = path.resolve(path.join(allowed, row.user_id, row.id));
  if (root !== expected) throw new Error("规范化目录不是该阅读版本的专属目录");
  assertNoSymlinkAncestors(roots.dataRoot, root);
  return root;
}

function removeOwnedReaderTree(target: string): void {
  const resolved = path.resolve(target);
  const stat = (() => {
    try { return fs.lstatSync(resolved); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })();
  if (!stat) return;
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("阅读资源目录类型不安全");
  fs.rmSync(resolved, { recursive: true, force: true });
}

function readerRowsForConversation(sqlite: DatabaseSync, conversationId: string, userId: string): ReaderStorageRow[] {
  return sqlite.prepare(`
    SELECT version.id,version.source_id,version.user_id,version.file_id,source.title,source.format,version.derived_kind,version.status,
      version.storage_state,version.storage_generation,version.storage_revision,version.normalized_root,
      version.last_accessed_at,version.storage_manifest_json,version.storage_manifest_sha256,version.storage_archive_sha256,
      version.storage_archive_bytes,version.storage_plaintext_bytes,version.remote_drive_id,version.remote_path,
      version.local_isolated_path,version.last_error
    FROM reading_source_versions version
    JOIN reading_sources source ON source.id=version.source_id AND source.user_id=version.user_id AND source.file_id=version.file_id
    JOIN files file ON file.id=version.file_id
    JOIN conversations conversation ON conversation.id=file.conversation_id
    WHERE file.conversation_id=? AND conversation.user_id=? AND version.user_id=?
    ORDER BY version.created_at,version.id
  `).all(conversationId, userId, userId) as ReaderStorageRow[];
}

/** Remove reader-owned local trees from the host-side storage boundary.
 *
 * A deployment may keep cold-storage locks and provider credentials outside
 * the web process. Each version is locked independently so the
 * maintenance CLI cannot move a normalized tree while deletion is walking it.
 * Remote archives are intentionally retained by the existing cold-storage
 * retention policy; this operation only removes local copies owned by the
 * deleted conversation.
 */
export function removeReaderResourcesForConversation(input: Partial<ReaderColdRoots>, conversationId: string, userId: string): void {
  assertReaderId(conversationId, "会话 ID");
  assertReaderId(userId, "账号 ID");
  const roots = readerRoots(input);
  const sqlite = openColdStorageDb(roots.databasePath);
  try {
    for (const row of readerRowsForConversation(sqlite, conversationId, userId)) {
      assertReaderId(row.id, "版本 ID");
      const lock = acquireColdStorageLock(roots, `reader-${row.id}`);
      try {
        if (row.normalized_root) removeOwnedReaderTree(rootPath(roots, row));
        if (!Number.isSafeInteger(row.storage_generation) || row.storage_generation < 0) throw new Error("阅读隔离代次无效");
        if (row.storage_generation >= 1) {
          const deterministicIsolated = path.resolve(path.join(roots.readerIsolationRoot, row.id, String(row.storage_generation)));
          const isolationRoot = path.resolve(roots.readerIsolationRoot);
          if (!deterministicIsolated.startsWith(`${isolationRoot}${path.sep}`)) throw new Error("阅读隔离路径越界");
          assertNoSymlinkAncestors(path.dirname(isolationRoot), deterministicIsolated);
          removeOwnedReaderTree(deterministicIsolated);
        }
        if (row.local_isolated_path) {
          const isolated = path.resolve(row.local_isolated_path);
          const expectedRoot = path.resolve(roots.readerIsolationRoot);
          if (!isolated.startsWith(`${expectedRoot}${path.sep}`)) throw new Error("阅读隔离路径越界");
          const expected = path.resolve(path.join(expectedRoot, row.id, String(row.storage_generation)));
          if (isolated !== expected) throw new Error("阅读隔离目录不是该版本的专属目录");
          assertNoSymlinkAncestors(path.dirname(expectedRoot), isolated);
          removeOwnedReaderTree(isolated);
        }
      } finally { removeColdStorageLock(lock); }
    }
  } finally { sqlite.close(); }
}

function assertRemoteArchiveIdentity(roots: ReaderColdRoots, row: ReaderStorageRow): void {
  assertReaderId(row.source_id, "来源 ID");
  assertReaderId(row.user_id, "账号 ID");
  if (!row.remote_drive_id || row.remote_drive_id !== roots.driveId) throw new Error("阅读归档所属云盘不匹配");
  if (!Number.isSafeInteger(row.storage_generation) || row.storage_generation < 1) throw new Error("阅读归档代次无效");
  if (!row.remote_path) throw new Error("阅读归档远端路径缺失");
  const remoteRoot = `/${roots.readerRemoteRoot.replace(/^\/+|\/+$/g, "")}`;
  const expectedDirectory = path.posix.join(remoteRoot, row.user_id, row.source_id);
  // Require the exact canonical parent, not merely a string prefix.  This
  // prevents a tampered DB row from redirecting restore into a nested or
  // sibling remote directory while still looking superficially in-bounds.
  if (path.posix.dirname(row.remote_path) !== expectedDirectory || row.remote_path.includes("\\") || row.remote_path.includes("..")) {
    throw new Error("阅读归档远端路径越界");
  }
  const name = path.posix.basename(row.remote_path);
  const match = /^generation-(\d+)-([0-9a-f]{64})\.tar\.age$/i.exec(name);
  if (!match || Number(match[1]) !== row.storage_generation) throw new Error("阅读归档远端文件名无效");
  if (row.storage_archive_sha256 && match[2].toLowerCase() !== row.storage_archive_sha256.toLowerCase()) {
    throw new Error("阅读归档远端文件哈希与清单不匹配");
  }
}

function retentionDays(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(READER_V1_RETENTION_DAYS, Math.floor(value))) : READER_V1_RETENTION_DAYS;
}

function assertNormalizedEpub(row: Pick<ReaderStorageRow, "format" | "derived_kind">): void {
  if (row.format !== "epub" || row.derived_kind !== "normalized") {
    throw new Error("只有已完成规范化的 EPUB 阅读版本可以进入阅读器冷存储");
  }
}

function walkFiles(root: string): Array<{ relativePath: string; absolute: string; size: number; sha256: string }> {
  const result: Array<{ relativePath: string; absolute: string; size: number; sha256: string }> = [];
  const visit = (directory: string, relativeDirectory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.resolve(directory, entry.name);
      const relative = safeRelative(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`规范化资源包含符号链接: ${relative}`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) result.push({ relativePath: relative, absolute, size: stat.size, sha256: sha256File(absolute) });
      else throw new Error(`规范化资源不是普通文件: ${relative}`);
    }
  };
  visit(root, "");
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function audit(sqlite: DatabaseSync, row: ReaderStorageRow, fromState: string, toState: string, action: string, details?: unknown): void {
  sqlite.prepare("INSERT INTO reading_storage_audit(id,version_id,generation,revision,from_state,to_state,action,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), row.id, row.storage_generation, row.storage_revision, fromState, toState, action, details === undefined ? null : JSON.stringify(details), new Date().toISOString());
}

function transition(sqlite: DatabaseSync, row: ReaderStorageRow, expected: string[], to: string, action: string, patch: Record<string, string | number | null> = {}): ReaderStorageRow {
  if (!expected.includes(row.storage_state)) throw new Error(`阅读版本存储状态已变化: ${row.storage_state}`);
  const allowed = new Set(["storage_generation", "storage_manifest_json", "storage_manifest_sha256", "storage_archive_sha256", "storage_archive_bytes", "storage_plaintext_bytes", "storage_uploaded_at", "storage_verified_at", "storage_restored_at", "remote_drive_id", "remote_path", "local_isolated_path", "last_error", "status", "normalized_root"]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  const result = sqlite.prepare(`UPDATE reading_source_versions SET storage_state=?,storage_revision=storage_revision+1,updated_at=?${entries.map(([key]) => `,${key}=?`).join("")} WHERE id=? AND storage_revision=? AND storage_state IN (${expected.map(() => "?").join(",")})`)
    .run(to, new Date().toISOString(), ...entries.map(([, value]) => value), row.id, row.storage_revision, ...expected);
  if (!result.changes) throw new Error("阅读版本存储 CAS 冲突");
  const next = rowFor(sqlite, row.id);
  if (!next) throw new Error("阅读版本在存储转换后消失");
  audit(sqlite, next, row.storage_state, to, action, entries.length ? Object.fromEntries(entries) : undefined);
  return next;
}

function copyFile(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target); fs.chmodSync(target, 0o600);
}

export function listReaderColdCandidates(input: Partial<ReaderColdRoots> = {}, inactiveDays = 15): ReaderColdCandidate[] {
  const roots = readerRoots(input); const sqlite = openColdStorageDb(roots.databasePath);
  try {
    const cutoff = Date.now() - retentionDays(inactiveDays) * DAY_MS;
    // A deletion tombstone must win over maintenance.  Keep versions from
    // deleting/removed conversations out of the candidate list so the cold
    // worker cannot move a tree while conversation GC is removing it.
    const rows = sqlite.prepare(`
      SELECT version.id,version.source_id,version.user_id,version.file_id,source.title,source.format,version.derived_kind,version.status,
        version.storage_state,version.storage_generation,version.storage_revision,version.normalized_root,
        version.last_accessed_at,version.storage_manifest_json,version.storage_manifest_sha256,version.storage_archive_sha256,
        version.storage_archive_bytes,version.storage_plaintext_bytes,version.remote_drive_id,version.remote_path,
        version.local_isolated_path,version.last_error
      FROM reading_source_versions version
      JOIN reading_sources source ON source.id=version.source_id AND source.user_id=version.user_id AND source.file_id=version.file_id
      JOIN files file ON file.id=version.file_id
      JOIN conversations conversation ON conversation.id=file.conversation_id AND conversation.user_id=version.user_id
      WHERE conversation.deleted_at IS NULL AND conversation.deletion_state='active'
    `).all() as ReaderStorageRow[];
    return rows.map((row) => {
      const reasons: string[] = []; const last = Date.parse(row.last_accessed_at); const ageHours = Number.isFinite(last) ? Math.max(0, (Date.now() - last) / 3_600_000) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(last) || last >= cutoff) reasons.push("active_within_retention");
      if (row.format !== "epub") reasons.push(`format_${row.format}`);
      if (row.derived_kind !== "normalized") reasons.push(`derived_${row.derived_kind}`);
      if (row.status !== "ready") reasons.push(`status_${row.status}`);
      if (!['local', 'error'].includes(row.storage_state)) reasons.push(`storage_${row.storage_state}`);
      let bytes = 0;
      if (row.format === "epub" && row.derived_kind === "normalized") {
        try { const root = rootPath(roots, row); if (!fs.existsSync(root)) reasons.push("normalized_root_missing"); else bytes = walkFiles(root).reduce((sum, file) => sum + file.size, 0); }
        catch { reasons.push("normalized_root_invalid"); }
      }
      if (!bytes) reasons.push("no_normalized_resources");
      return { versionId: row.id, sourceId: row.source_id, userId: row.user_id, fileId: row.file_id, title: row.title, format: row.format, status: row.status, storageState: row.storage_state, lastAccessedAt: row.last_accessed_at, ageHours, bytes, eligible: reasons.length === 0, reasons };
    }).sort((a, b) => b.ageHours - a.ageHours || a.versionId.localeCompare(b.versionId));
  } finally { sqlite.close(); }
}

export function archiveReaderVersion(input: Partial<ReaderColdRoots>, versionId: string, inactiveDays = 15): ReaderColdArchiveResult {
  assertReaderId(versionId, "版本");
  const roots = readerRoots(input);
  const lock = acquireColdStorageLock(roots, `reader-${versionId}`);
  const sqlite = openColdStorageDb(roots.databasePath);
  let work = "";
  let downloadWork = "";
  let normalized = "";
  let isolated = "";
  try {
    let row = rowFor(sqlite, versionId); if (!row) throw new Error("阅读版本不存在");
    assertNormalizedEpub(row);
    const candidate = listReaderColdCandidates(roots, inactiveDays).find((item) => item.versionId === versionId);
    if (!candidate?.eligible) throw new Error(`阅读版本不满足冷存储条件: ${candidate?.reasons.join(",") || "不存在"}`);
    // Re-read the access timestamp after taking the per-version lock.  A page
    // request can touch the version between candidate enumeration and this
    // point; archiving must never turn that fresh call into an immediate cold
    // transition merely because the dry-run snapshot was stale.
    row = rowFor(sqlite, versionId);
    if (!row) throw new Error("阅读版本不存在");
    assertNormalizedEpub(row);
    if (!readerVersionIsActive(sqlite, row)) throw new Error("所属会话正在删除或已不可用");
    const cutoff = Date.now() - retentionDays(inactiveDays) * DAY_MS;
    const lastAccessed = Date.parse(row.last_accessed_at);
    if (!Number.isFinite(lastAccessed) || lastAccessed >= cutoff) throw new Error("阅读版本刚刚被访问，暂不转入冷存储");
    if (!fs.existsSync(roots.ageRecipient) || !fs.existsSync(roots.ageIdentity)) throw new Error("age 密钥边界不可用");
    const generation = row.storage_generation + 1;
    // A retry after an interrupted archive must not leave the previous
    // generation's remote metadata attached to the new generation.  Keeping
    // it would make a later `error` state look restorable even though the
    // recorded filename/hash no longer matches storage_generation.
    row = transition(sqlite, row, ["local", "error"], "uploading", "archive_begin", {
      storage_generation: generation,
      storage_manifest_json: null,
      storage_manifest_sha256: null,
      storage_archive_sha256: null,
      storage_archive_bytes: null,
      storage_plaintext_bytes: null,
      storage_uploaded_at: null,
      storage_verified_at: null,
      storage_restored_at: null,
      remote_drive_id: null,
      remote_path: null,
      local_isolated_path: null,
      last_error: null,
    });
    normalized = rootPath(roots, row); const files = walkFiles(normalized);
    if (files.length === 0 || files.length > 4_000) throw new Error("规范化资源成员数量超过安全上限");
    const plaintextBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 1 || plaintextBytes > 512 * 1024 * 1024) throw new Error("规范化资源明文大小超过安全上限");
    work = fs.mkdtempSync(path.join(path.dirname(roots.readerIsolationRoot), `.reader-package-${versionId}-`));
    const manifest = { format: READER_ARCHIVE_FORMAT, versionId, sourceId: row.source_id, userId: row.user_id, generation, normalizedRoot: row.normalized_root, createdAt: new Date().toISOString(), plaintextBytes, entries: files.map((file) => ({ relativePath: file.relativePath, size: file.size, sha256: file.sha256 })) };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`; const manifestSha = crypto.createHash("sha256").update(manifestText).digest("hex"); fs.writeFileSync(path.join(work, "manifest.json"), manifestText, { mode: 0o600 });
    for (const file of files) copyFile(file.absolute, path.join(work, "resources", file.relativePath));
    const encrypted = path.join(work, `generation-${generation}.tar.age`); packageArchive(roots, work, encrypted); verifyAgeArchive(roots, encrypted);
    const archiveSha = sha256File(encrypted); const archiveBytes = fs.statSync(encrypted).size;
    const remoteRoot = `/${roots.readerRemoteRoot.replace(/^\/+|\/+$/g, "")}`;
    const remoteDir = path.posix.join(remoteRoot, row.user_id, row.source_id);
    const remotePath = `${remoteDir}/generation-${generation}-${archiveSha}.tar.age`;
    const remoteLocal = path.join(work, path.basename(remotePath)); fs.copyFileSync(encrypted, remoteLocal); ensureRemotePath(roots, remoteDir); const stage = stageForUpload(roots, remoteLocal); try { runAliyun(roots, ["upload", "--driveId", roots.driveId, "--np", "--retry", "5", "--timeout", "120", stage, remoteDir]); } finally { try { fs.unlinkSync(stage); } catch {} }
    if (!remoteObjectVisible(roots, remotePath)) throw new Error("阅读资源归档上传后云端对象不可见");
    prepareDownloadDirectory(roots.downloadDir); downloadWork = fs.mkdtempSync(path.join(roots.downloadDir, `reader-${versionId}-`)); prepareDownloadDirectory(downloadWork); runAliyun(roots, ["download", "--driveId", roots.driveId, "--np", `--saveto=${downloadWork}`, remotePath]); const downloaded = findDownloadedFile(downloadWork, path.basename(remotePath), [path.dirname(roots.downloadDir)]); if (fs.statSync(downloaded).size !== archiveBytes || sha256File(downloaded) !== archiveSha) throw new Error("阅读资源云端回下载校验失败");
    row = rowFor(sqlite, versionId)!; row = transition(sqlite, row, ["uploading"], "remote_verified", "remote_verify", { storage_manifest_json: manifestText, storage_manifest_sha256: manifestSha, storage_archive_sha256: archiveSha, storage_archive_bytes: archiveBytes, storage_plaintext_bytes: manifest.plaintextBytes, remote_drive_id: roots.driveId, remote_path: remotePath, storage_uploaded_at: new Date().toISOString(), storage_verified_at: new Date().toISOString(), last_error: null }); row = transition(sqlite, row, ["remote_verified"], "evicting", "local_evict_begin");
    isolated = path.join(roots.readerIsolationRoot, versionId, String(generation));
    // Re-check immediately before creating/renaming the isolated tree so a
    // pre-existing symlink cannot redirect the move outside this boundary.
    assertNoSymlinkAncestors(path.dirname(roots.readerIsolationRoot), path.dirname(isolated));
    fs.mkdirSync(path.dirname(isolated), { recursive: true, mode: 0o700 });
    assertNoSymlinkAncestors(path.dirname(roots.readerIsolationRoot), path.dirname(isolated));
    const isolatedStat = (() => { try { return fs.lstatSync(isolated); } catch { return null; } })();
    if (isolatedStat) throw new Error("阅读资源隔离目录已存在");
    fs.renameSync(normalized, isolated); row = rowFor(sqlite, versionId)!; transition(sqlite, row, ["evicting"], "cold", "local_evict_complete", { local_isolated_path: isolated, last_error: null });
    return { versionId, generation, archiveBytes, plaintextBytes: manifest.plaintextBytes, archiveSha256: archiveSha, remotePath, isolatedPath: isolated };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "archive_failed";
    let row = rowFor(sqlite, versionId);
    // If the filesystem move succeeded but the final CAS/audit write did not,
    // put the normalized tree back before exposing an error state.  Otherwise
    // a failed archive would strand the only local copy in an unreferenced
    // isolation directory and the next retry could not find a candidate.
    let rollbackRestored = false;
    if (isolated && normalized && row?.storage_state !== "cold") {
      try {
        if (!fs.existsSync(normalized) && fs.existsSync(isolated)) {
          fs.mkdirSync(path.dirname(normalized), { recursive: true, mode: 0o700 });
          fs.renameSync(isolated, normalized);
        }
        rollbackRestored = fs.existsSync(normalized);
        row = rowFor(sqlite, versionId);
      } catch { /* preserve the original failure; the state transition below remains auditable */ }
    }
    if (row && ["uploading", "remote_verified", "evicting"].includes(row.storage_state)) {
      try {
        transition(sqlite, row, [row.storage_state], "error", "archive_error", {
          // If the move-back failed, retain the deterministic isolation path
          // so a maintenance operator can recover it instead of silently
          // losing the only local copy.
          local_isolated_path: rollbackRestored ? null : isolated || row.local_isolated_path,
          last_error: message,
        });
      } catch {}
    }
    throw error;
  } finally { sqlite.close(); if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {} if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} removeColdStorageLock(lock); }
}

type ReaderArchiveManifest = {
  format: string;
  versionId: string;
  sourceId: string;
  userId: string;
  generation: number;
  normalizedRoot: string | null;
  plaintextBytes: number;
  entries: Array<{ relativePath: string; size: number; sha256: string }>;
};

function walkExtractedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = safeRelative(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`阅读归档包含符号链接: ${relative}`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push(relative);
      else throw new Error(`阅读归档包含非普通文件: ${relative}`);
    }
  };
  visit(root, "");
  return files.sort();
}

function parseReaderArchiveManifest(row: ReaderStorageRow, text: string): ReaderArchiveManifest {
  if (row.storage_manifest_json !== null && row.storage_manifest_json !== text) throw new Error("阅读归档清单内容不匹配");
  if (row.storage_manifest_sha256) {
    const actual = crypto.createHash("sha256").update(text).digest("hex");
    if (actual !== row.storage_manifest_sha256) throw new Error("阅读归档清单哈希不匹配");
  }
  let manifest: ReaderArchiveManifest;
  try { manifest = JSON.parse(text) as ReaderArchiveManifest; }
  catch { throw new Error("阅读归档清单格式无效"); }
  if (!manifest || manifest.format !== READER_ARCHIVE_FORMAT || manifest.versionId !== row.id
    || manifest.sourceId !== row.source_id || manifest.userId !== row.user_id
    || manifest.generation !== row.storage_generation || manifest.normalizedRoot !== row.normalized_root) {
    throw new Error("阅读归档清单身份不匹配");
  }
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1) throw new Error("阅读归档代次无效");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > 4_000) throw new Error("阅读归档成员数量无效");
  if (!Number.isSafeInteger(manifest.plaintextBytes) || manifest.plaintextBytes < 1 || manifest.plaintextBytes > 512 * 1024 * 1024) throw new Error("阅读归档明文大小无效");
  const seen = new Set<string>();
  let total = 0;
  for (const entry of manifest.entries) {
    const relative = safeRelative(entry.relativePath);
    if (seen.has(relative) || (!relative.startsWith("units/") && !relative.startsWith("assets/"))) throw new Error("阅读归档成员路径无效");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024 || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw new Error("阅读归档成员元数据无效");
    seen.add(relative); total += entry.size;
    if (total > 512 * 1024 * 1024) throw new Error("阅读归档明文大小超限");
  }
  if (total !== manifest.plaintextBytes) throw new Error("阅读归档明文大小校验失败");
  return manifest;
}

export function restoreReaderVersion(input: Partial<ReaderColdRoots>, versionId: string, userId: string): void {
  assertReaderId(versionId, "版本");
  assertReaderId(userId, "账号");
  const roots = readerRoots(input); const lock = acquireColdStorageLock(roots, `reader-${versionId}`); const sqlite = openColdStorageDb(roots.databasePath); let work = ""; let downloadWork = "";
  try {
    let row = rowFor(sqlite, versionId, userId); if (!row) throw new Error("阅读版本不存在或账号不匹配");
    assertNormalizedEpub(row);
    if (!readerVersionIsActive(sqlite, row)) throw new Error("所属会话正在删除或已不可用"); if (row.storage_state === "local") return; if (!row.remote_path || !row.storage_archive_sha256 || !row.storage_archive_bytes || !row.storage_manifest_json) throw new Error("阅读资源远端清单不完整");
    if (!["cold", "restoring", "error"].includes(row.storage_state)) throw new Error(`当前阅读版本不能恢复: ${row.storage_state}`);
    if (row.storage_state !== "restoring") row = transition(sqlite, row, ["cold", "error"], "restoring", "restore_begin");
    assertRemoteArchiveIdentity(roots, row);
    const remotePath = row.remote_path!; const archiveSha = row.storage_archive_sha256!; const archiveBytes = row.storage_archive_bytes!;
    prepareDownloadDirectory(roots.downloadDir);
    downloadWork = fs.mkdtempSync(path.join(roots.downloadDir, `reader-restore-${versionId}-`));
    prepareDownloadDirectory(downloadWork);
    runAliyun(roots, ["download", "--driveId", roots.driveId, "--np", `--saveto=${downloadWork}`, remotePath]);
    const encrypted = findDownloadedFile(downloadWork, path.basename(remotePath), [path.dirname(roots.downloadDir)]);
    if (fs.statSync(encrypted).size !== archiveBytes || sha256File(encrypted) !== archiveSha) throw new Error("阅读资源恢复密文校验失败");

    work = fs.mkdtempSync(path.join(path.dirname(roots.readerIsolationRoot), `.reader-restore-${versionId}-`));
    const plain = path.join(work, "archive.tar");
    execFileSync(roots.age, ["-d", "-i", roots.ageIdentity, "-o", plain, encrypted], { stdio: "ignore", timeout: 6 * 60 * 60_000 });
    const extract = path.join(work, "extract");
    fs.mkdirSync(extract, { mode: 0o700 });
    // Validate the member names before extraction.  Hash verification proves
    // the archive is the expected object, but this second boundary prevents a
    // malformed/tampered tar from writing through `..` or absolute paths.
    const listing = execFileSync("tar", ["-tf", plain], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 6 * 60 * 60_000 });
    const members = listing.split(/\r?\n/).filter(Boolean);
    if (members.length > 20_000) throw new Error("阅读归档成员数量超过安全上限");
    for (const member of members) {
      const normalized = member.replace(/^\.\//, "").replace(/\/$/, "");
      if (!normalized) continue;
      if (normalized !== "manifest.json" && normalized !== "resources" && !normalized.startsWith("resources/")) throw new Error("阅读归档包含不允许的路径");
      if (normalized !== "resources") safeRelative(normalized);
    }
    execFileSync("tar", ["--no-same-owner", "--no-same-permissions", "-xf", plain, "-C", extract], { stdio: "ignore", timeout: 6 * 60 * 60_000 });

    const manifestText = fs.readFileSync(path.join(extract, "manifest.json"), "utf8");
    const manifest = parseReaderArchiveManifest(row, manifestText);
    const extracted = walkExtractedFiles(extract);
    const expected = new Set(["manifest.json", ...manifest.entries.map((entry) => `resources/${safeRelative(entry.relativePath)}`)]);
    if (extracted.length !== expected.size || extracted.some((relative) => !expected.has(relative))) throw new Error("阅读归档包含未声明成员");

    const target = rootPath(roots, { ...row, normalized_root: row.normalized_root });
    if (fs.existsSync(target)) throw new Error("恢复目标目录已经存在");
    const restored = path.join(work, "restored");
    fs.mkdirSync(restored, { mode: 0o700 });
    for (const entry of manifest.entries) {
      const relative = safeRelative(entry.relativePath);
      const source = path.resolve(extract, "resources", relative);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.size !== entry.size || sha256File(source) !== entry.sha256) throw new Error(`阅读资源成员校验失败: ${relative}`);
      copyFile(source, path.join(restored, relative));
    }

    assertNoSymlinkAncestors(roots.dataRoot, path.dirname(target));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    assertNoSymlinkAncestors(roots.dataRoot, path.dirname(target));
    fs.renameSync(restored, target);
    try {
      row = rowFor(sqlite, versionId, userId)!;
      transition(sqlite, row, ["restoring"], "local", "restore_complete", { status: "ready", local_isolated_path: null, storage_restored_at: new Date().toISOString(), last_error: null });
    } catch (error) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      throw error;
    }
  } catch (error) { const row = rowFor(sqlite, versionId, userId); if (row && ["restoring", "cold"].includes(row.storage_state)) { try { transition(sqlite, row, [row.storage_state], "error", "restore_error", { status: "failed", last_error: error instanceof Error ? error.message.slice(0, 2_000) : "restore_failed" }); } catch {} } throw error; }
  finally { sqlite.close(); if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch {} if (downloadWork) try { fs.rmSync(downloadWork, { recursive: true, force: true }); } catch {} removeColdStorageLock(lock); }
}

export type ReaderPurgeResult = { versionId: string; isolatedPath: string; deleted: boolean; reason?: string };
export function purgeReaderIsolation(input: Partial<ReaderColdRoots> = {}, graceDays = 7): ReaderPurgeResult[] {
  const roots = readerRoots(input); const sqlite = openColdStorageDb(roots.databasePath); const results: ReaderPurgeResult[] = []; const cutoff = Date.now() - Math.max(1, graceDays) * DAY_MS;
  try {
    const rows = sqlite.prepare("SELECT id,storage_generation,storage_revision,local_isolated_path,updated_at FROM reading_source_versions WHERE storage_state='cold' AND local_isolated_path IS NOT NULL").all() as Array<{ id: string; storage_generation: number; storage_revision: number; local_isolated_path: string; updated_at: string }>;
    for (const row of rows) {
      if (!row.updated_at || Date.parse(row.updated_at) > cutoff) continue;
      const lock = acquireColdStorageLock(roots, `reader-${row.id}`);
      try {
        assertReaderId(row.id, "版本");
        if (!Number.isSafeInteger(row.storage_generation) || row.storage_generation < 1) throw new Error("阅读隔离代次无效");
        const isolated = path.resolve(row.local_isolated_path);
        const expected = path.resolve(path.join(roots.readerIsolationRoot, row.id, String(row.storage_generation)));
        if (isolated !== expected) throw new Error("阅读隔离路径不是该版本的专属目录");
        assertNoSymlinkAncestors(path.dirname(roots.readerIsolationRoot), path.dirname(isolated));
        const existing = fs.existsSync(isolated) ? fs.lstatSync(isolated) : null;
        if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error("阅读隔离目标类型不安全");
        const trash = `${isolated}.purged-${crypto.randomUUID()}`; if (existing) fs.renameSync(isolated, trash);
        const updated = sqlite.prepare("UPDATE reading_source_versions SET local_isolated_path=NULL,storage_revision=storage_revision+1,updated_at=? WHERE id=? AND storage_revision=? AND storage_state='cold'").run(new Date().toISOString(), row.id, row.storage_revision); if (!updated.changes) { if (fs.existsSync(trash)) fs.renameSync(trash, isolated); throw new Error("阅读资源清理 CAS 冲突"); }
        try { if (existing) fs.rmSync(trash, { recursive: true, force: true }); results.push({ versionId: row.id, isolatedPath: isolated, deleted: true, reason: existing ? undefined : "already_missing" }); } catch (error) { results.push({ versionId: row.id, isolatedPath: isolated, deleted: false, reason: error instanceof Error ? error.message : "purge_failed" }); }
      } catch (error) { results.push({ versionId: row.id, isolatedPath: row.local_isolated_path, deleted: false, reason: error instanceof Error ? error.message : "purge_failed" }); }
      finally { removeColdStorageLock(lock); }
    }
    return results;
  } finally { sqlite.close(); }
}

export { readerRoots };
