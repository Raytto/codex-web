import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { AppDatabase, FileRow } from "./db.js";
import { newId, resolveInside } from "./paths.js";
import { assertNoSymlinkPath, hashReaderFileAsync, ingestEpubFile, readerResourcePath, READER_PARSER_VERSION, ReaderIngestError } from "./reader-ingest.js";
import type { ReadingSourceVersionRow, ReadingUnitRow, ReaderCapability, ReaderFormat, ReaderManifest } from "./reader-types.js";
import { ReaderReadLimiter } from "./reader-range.js";
import { readerRoots, removeReaderResourcesForConversation, restoreReaderVersion } from "./reader-cold-storage.js";

export const NATIVE_READER_PARSER_VERSION = "native-reader-v1";

export type ReaderFileAvailability = "local" | "restoring" | "error" | "missing";

/** Returned when a cold conversation/reader artifact is being restored.  A
 * 202 response is more useful to the client than pretending that a valid
 * source simply does not exist. */
export class ReaderUnavailableError extends Error {
  readonly code = "READER_RESTORE_IN_PROGRESS";
  constructor(message = "阅读资源正在恢复，请稍后重试。") {
    super(message);
    this.name = "ReaderUnavailableError";
  }
}

export function detectReaderFormat(file: Pick<FileRow, "original_name" | "mime_type">): ReaderFormat | null {
  const mime = file.mime_type.split(";", 1)[0].trim().toLowerCase();
  const extension = path.extname(file.original_name).toLowerCase();
  if (mime === "text/markdown" || mime === "text/x-markdown" || extension === ".md" || extension === ".markdown") return "markdown";
  if (mime === "text/html" || extension === ".html" || extension === ".htm") return "html";
  if (mime === "application/pdf" || extension === ".pdf") return "pdf";
  if (mime === "application/epub+zip" || extension === ".epub") return "epub";
  return null;
}

export function readerCapabilities(format: ReaderFormat): ReaderCapability[] {
  if (format === "html" || format === "markdown") return ["vertical-flow", "text-selection", "highlight", "note", "agent-ask"];
  return ["pagination", "text-selection", "highlight", "note", "agent-ask", "range-fetch", "nearby-prefetch"];
}

export type ReaderServiceOptions = {
  db: AppDatabase;
  config: AppConfig;
  resolveFilePath: (file: FileRow, userId: string) => string;
  /** Must not create a workspace or otherwise mutate state while probing a
   * source.  The fallback keeps the service usable in small unit tests. */
  resolveExistingFilePath?: (file: FileRow, userId: string) => string;
  /** Lets the reader reuse the conversation cold-storage state machine when
   * the original PDF/EPUB has been evicted with its conversation. */
  ensureFileAvailable?: (file: FileRow, userId: string) => ReaderFileAvailability;
  /** Optional boundary for operations that require elevated storage credentials.
   * The local fallback is retained for isolated tests and non-container use. */
  restoreReaderVersion?: (versionId: string, userId: string) => Promise<void>;
  /** Host-side RPC for deleting reader trees together with a conversation. */
  removeReaderResources?: (conversationId: string, userId: string) => Promise<void>;
};

export class ReaderService {
  readonly reads: ReaderReadLimiter;
  private readonly ingesting = new Map<string, Promise<void>>();
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly opening = new Map<string, Promise<ReaderManifest>>();
  private stopped = false;

  constructor(private readonly options: ReaderServiceOptions) {
    this.reads = new ReaderReadLimiter(options.config.readerMaxConcurrentReads);
  }

  format(file: Pick<FileRow, "original_name" | "mime_type">): ReaderFormat | null { return detectReaderFormat(file); }

  ensureOriginalFileAvailable(file: FileRow, userId: string): ReaderFileAvailability {
    return this.options.ensureFileAvailable?.(file, userId) ?? "missing";
  }

  async openFile(file: FileRow, userId: string): Promise<ReaderManifest> {
    const key = `${userId}:${file.id}`;
    const inFlight = this.opening.get(key);
    if (inFlight) return inFlight;
    const task = this.openFileInternal(file, userId);
    this.opening.set(key, task);
    try { return await task; }
    finally { if (this.opening.get(key) === task) this.opening.delete(key); }
  }

  private async openFileInternal(file: FileRow, userId: string): Promise<ReaderManifest> {
    if (this.stopped) throw new ReaderUnavailableError("阅读器正在关闭，请稍后重试。");
    const format = detectReaderFormat(file);
    if (!format) throw new ReaderIngestError("这个文件格式暂不支持站内阅读。");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.options.config.readerMaxFileBytes) {
      throw new ReaderIngestError(`文件超过在线阅读大小上限（${this.options.config.readerMaxFileBytes} 字节）。`);
    }
    let source = this.options.db.getReadingSourceForFile(file.id, userId);
    if (!source) {
      source = this.options.db.createReadingSource({
        id: newId(), user_id: userId, file_id: file.id, format,
        title: file.original_name || "未命名文件", author: null,
      });
    } else if (source.format !== format) {
      // A legacy row can outlive a corrected MIME/name.  Keep the stable
      // source identity while making the adapter selection truthful.
      source = this.options.db.updateReadingSourceMetadata(source.id, userId, source.title, source.author, format) ?? source;
    }
    const derivedKind = format === "epub" ? "normalized" : "original";
    let version = this.options.db.getReadingVersionForSource(source.id, userId, derivedKind);
    if (version?.storage_state === "evicting") {
      this.options.db.touchReadingVersion(version.id, userId);
      throw new ReaderUnavailableError("阅读资源正在转入冷存储，请稍后重试。");
    }

    // A normalized EPUB is an independent derived source.  Its original ZIP
    // may already have been evicted by the conversation cold-storage job, so
    // never wake the whole conversation merely to discover that the reader
    // version itself needs restoring.
    if (format === "epub" && version && this.readerVersionNeedsRestore(version)) {
      if (!hasRemoteReaderArchive(version)) {
        throw new ReaderIngestError("阅读版本的冷存储元数据不完整，暂不能恢复。");
      }
      this.options.db.touchReadingVersion(version.id, userId);
      if (version.normalized_root) {
        this.startRestore(version, userId);
        const refreshed = this.options.db.updateReadingVersion(version.id, userId, { status: "restoring" });
        if (refreshed) version = refreshed;
      }
      return this.manifestFor(source, version, format, userId);
    }

    const absolute = this.existingFilePath(file, userId);
    let stat = absolute ? await fsp.lstat(absolute).catch(() => null) : null;
    if (absolute && stat) {
      try { assertNoSymlinkPath(absolute); }
      catch (error) { throw error instanceof ReaderIngestError ? error : new ReaderIngestError("文件路径类型不安全。"); }
    }
    if ((!stat || !stat.isFile()) && version && format === "epub" && this.normalizedResourceExists(version)) {
      // EPUB units are immutable derived resources.  They remain readable
      // while the original conversation file is in its own cold archive.
      stat = null;
    } else if (!stat || !stat.isFile()) {
      const availability = this.options.ensureFileAvailable?.(file, userId) ?? "missing";
      if (availability === "restoring") throw new ReaderUnavailableError();
      if (availability === "error") throw new ReaderUnavailableError("原文件恢复失败，请稍后重试。");
      if (availability === "local") {
        stat = absolute ? await fsp.lstat(absolute).catch(() => null) : null;
        if (absolute && stat) {
          try { assertNoSymlinkPath(absolute); }
          catch (error) { throw error instanceof ReaderIngestError ? error : new ReaderIngestError("文件路径类型不安全。"); }
        }
      }
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new ReaderIngestError("文件不存在或不是普通文件。");
    }
    if (stat?.isSymbolicLink()) throw new ReaderIngestError("文件不是普通文件。");
    if (stat && stat.size !== file.size) throw new ReaderIngestError("文件不存在或大小已变化。");

    // File hashes are normally persisted by upload/finalization.  Legacy
    // rows may not have one; calculate it once so a same-size replacement can
    // never silently reuse an old normalized version.
    const sourceSha256 = file.sha256 ?? (stat && absolute ? await hashReaderFileAsync(absolute) : version?.source_sha256 ?? null);
    const derivedMissing = format === "epub" && version !== undefined && version.status === "ready" && !this.normalizedResourceExists(version);
    const stale = !version
      || derivedMissing
      || version.source_bytes !== file.size
      || version.file_id !== file.id
      || (sourceSha256 !== null && sourceSha256 !== version.source_sha256)
      || version.parser_version !== (format === "epub" ? READER_PARSER_VERSION : NATIVE_READER_PARSER_VERSION);
    if (stale && (!stat || !absolute)) {
      // A normalized EPUB can be served without its original ZIP only while
      // its immutable source metadata still matches.  If the hash, size, or
      // parser version says it is stale, restore the original before making a
      // new version; never silently serve an older representation.
      throw new ReaderUnavailableError("原文件正在恢复，暂不能建立新的阅读版本。");
    }
    if (stale) {
      const now = new Date().toISOString();
      const versionId = newId();
      const isEpub = format === "epub";
      version = this.options.db.createReadingVersion({
        id: versionId, source_id: source.id, user_id: userId, file_id: file.id,
        version_no: this.options.db.nextReadingVersionNo(source.id), derived_kind: derivedKind,
        source_sha256: sourceSha256, source_bytes: file.size, parser_version: isEpub ? READER_PARSER_VERSION : NATIVE_READER_PARSER_VERSION,
        status: isEpub ? "processing" : "ready", normalized_root: isEpub ? path.posix.join("reader-resources", userId, versionId) : null,
        manifest_json: isEpub ? null : JSON.stringify({ format }), last_accessed_at: now, storage_state: "local",
        storage_generation: 0, storage_revision: 0,
        storage_manifest_json: null, storage_manifest_sha256: null, storage_archive_sha256: null, storage_archive_bytes: null,
        storage_plaintext_bytes: null, storage_uploaded_at: null, storage_verified_at: null, storage_restored_at: null,
        remote_drive_id: null, remote_path: null, local_isolated_path: null, last_error: null,
      });
    }
    if (!version) throw new ReaderIngestError("无法建立阅读版本。");
    this.options.db.touchReadingVersion(version.id, userId);
    if (this.readerVersionNeedsRestore(version)) {
      if (!version.normalized_root) throw new ReaderIngestError("阅读版本存储状态无效。");
      this.startRestore(version, userId);
      const refreshed = this.options.db.updateReadingVersion(version.id, userId, { status: "restoring" });
      if (refreshed) version = refreshed;
    }
    if (format === "epub" && version.status === "processing" && stat?.isFile() && absolute) this.startEpubIngest(version, userId, absolute);
    return this.manifestFor(source, version, format, userId);
  }

  private existingFilePath(file: FileRow, userId: string): string | null {
    try { return (this.options.resolveExistingFilePath ?? this.options.resolveFilePath)(file, userId); }
    catch { return null; }
  }

  private normalizedResourceExists(version: ReadingSourceVersionRow): boolean {
    const root = readerResourcePath(this.options.config, version);
    if (!root || version.status !== "ready") return false;
    try {
      const rootStat = fs.lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
      const units = this.options.db.listReadingUnits(version.id, version.user_id);
      return units.length > 0 && units.every((unit) => {
        if (!unit.content_path) return false;
        const absolute = resolveInside(root, unit.content_path);
        assertNoSymlinkPath(absolute);
        const stat = fs.lstatSync(absolute);
        return !stat.isSymbolicLink() && stat.isFile() && stat.size === unit.byte_size;
      });
    } catch { return false; }
  }

  /** An archive can fail after the remote object has been verified but before
   * the local rename completes. In that state the row is `error` and still
   * carries restore metadata, while the complete normalized tree is already
   * usable locally. Do not unnecessarily start a restore (which would reject
   * an existing target and turn a recoverable local copy into a failed read).
   */
  private readerVersionNeedsRestore(version: ReadingSourceVersionRow): boolean {
    return shouldRestoreReaderVersion(version)
      && !(version.normalized_root && this.normalizedResourceExists(version));
  }

  private coldRoots() {
    const stateRoot = path.dirname(path.resolve(this.options.config.dataRoot));
    return {
      dataRoot: this.options.config.dataRoot,
      tenantRoot: this.options.config.tenantRoot,
      databasePath: path.join(this.options.config.dataRoot, "codex-web.sqlite"),
      isolationRoot: path.join(stateRoot, "cold-storage", "isolated"),
    };
  }

  private startRestore(version: ReadingSourceVersionRow, userId: string): void {
    if (this.stopped) return;
    if (this.restoring.has(version.id)) return;
    const restore = this.options.restoreReaderVersion
      ? () => this.options.restoreReaderVersion!(version.id, userId)
      : () => Promise.resolve().then(() => restoreReaderVersion(this.coldRoots(), version.id, userId));
    const task = Promise.resolve().then(restore).then(() => {
      this.options.db.updateReadingVersion(version.id, userId, { status: "ready", storage_state: "local", last_error: null });
    }).catch((error) => {
      this.options.db.updateReadingVersion(version.id, userId, { status: "failed", storage_state: "error", last_error: error instanceof Error ? error.message.slice(0, 500) : "阅读资源恢复失败" });
    }).finally(() => { this.restoring.delete(version.id); });
    this.restoring.set(version.id, task);
  }

  private startEpubIngest(version: ReadingSourceVersionRow, userId: string, absolutePath: string): void {
    if (this.stopped) return;
    if (this.ingesting.has(version.id)) return;
    const task = (async () => {
      try {
        const result = await ingestEpubFile({ userId, versionId: version.id, absolutePath, config: this.options.config });
        const current = this.options.db.getReadingVersion(version.id, userId);
        if (!current) return;
        this.options.db.replaceReadingUnits(version.id, userId, result.units);
        this.options.db.updateReadingVersion(version.id, userId, {
          status: "ready", last_error: null,
          manifest_json: JSON.stringify(result.manifest),
        });
        // Metadata is intentionally best-effort; a malformed optional OPF
        // field must not invalidate an otherwise readable publication.
        this.options.db.updateReadingSourceMetadata(current.source_id, userId, result.title, result.author);
      } catch (error) {
        this.options.db.updateReadingVersion(version.id, userId, {
          status: "failed", last_error: error instanceof Error ? error.message.slice(0, 500) : "EPUB 解析失败",
        });
      } finally {
        this.ingesting.delete(version.id);
      }
    })();
    this.ingesting.set(version.id, task);
  }

  async waitForIngest(versionId: string): Promise<void> { await this.ingesting.get(versionId); }

  /** Remove reader-owned local derivatives before a conversation tombstone is
   * completed.  Database foreign-key cascades remove the metadata, but they
   * cannot remove files from the normalized/isolated roots.  Keeping this
   * operation here gives GC one ownership boundary and prevents a stale EPUB
   * tree from surviving a deleted conversation. */
  async removeConversationResources(conversationId: string, userId: string): Promise<void> {
    await this.waitForBackgroundTasks();
    // Avoid an unnecessary host RPC (and lock-directory access) for the
    // overwhelmingly common case where a conversation was never opened in
    // the rich reader.
    if (this.options.db.listReadingVersionsForConversation(conversationId, userId).length === 0) return;
    if (this.options.removeReaderResources) {
      await this.options.removeReaderResources(conversationId, userId);
      return;
    }
    removeReaderResourcesForConversation(this.coldRoots(), conversationId, userId);
  }

  stop(): void { this.stopped = true; }

  async waitForBackgroundTasks(): Promise<void> {
    while (this.ingesting.size > 0 || this.restoring.size > 0) {
      await Promise.allSettled([...this.ingesting.values(), ...this.restoring.values()]);
    }
  }

  manifestFor(source: Awaited<ReturnType<AppDatabase["getReadingSourceForFile"]>> & {}, version: ReadingSourceVersionRow, format: ReaderFormat, userId: string): ReaderManifest {
    const units = version.status === "ready" ? this.options.db.listReadingUnits(version.id, userId) : [];
    let extra: { spineCount?: number; opfPath?: string; navPath?: string | null } = {};
    try { extra = version.manifest_json ? JSON.parse(version.manifest_json) as typeof extra : {}; } catch { /* corrupted optional metadata is ignored */ }
    return {
      source: { id: source.id, fileId: source.file_id, title: source.title, author: source.author, format },
      version: {
        id: version.id, versionNo: version.version_no, derivedKind: version.derived_kind, status: version.status,
        parserVersion: version.parser_version, sourceBytes: version.source_bytes, lastAccessedAt: version.last_accessed_at, error: version.last_error,
      },
      capabilities: readerCapabilities(format),
      units: units.map((unit) => ({ id: unit.id, ordinal: unit.ordinal, kind: unit.kind, href: unit.href, title: unit.title, media_type: unit.media_type, byte_size: unit.byte_size })),
      endpoints: {
        bytes: `${this.options.config.basePath.replace(/\/$/, "")}/api/reader/versions/${encodeURIComponent(version.id)}/bytes`,
        manifest: `${this.options.config.basePath.replace(/\/$/, "")}/api/reader/versions/${encodeURIComponent(version.id)}/manifest`,
      },
    };
  }

  async getManifest(versionId: string, userId: string): Promise<ReaderManifest | null> {
    let version = this.options.db.getReadingVersion(versionId, userId);
    if (!version) return null;
    const source = this.options.db.getReadingSource(sourceId(version), userId);
    if (!source) return null;
    if (source.file_id !== version.file_id || !this.options.db.getFileForUser(version.file_id, userId)) return null;
    this.options.db.touchReadingVersion(version.id, userId);
    if (version.storage_state === "evicting") throw new ReaderUnavailableError("阅读资源正在转入冷存储，请稍后重试。");
    if (this.readerVersionNeedsRestore(version)) {
      if (!version.normalized_root) throw new ReaderIngestError("阅读版本缺少可恢复的规范化目录。");
      if (!hasRemoteReaderArchive(version)) throw new ReaderIngestError("阅读版本的冷存储元数据不完整，暂不能恢复。");
      this.startRestore(version, userId);
      const refreshed = this.options.db.updateReadingVersion(version.id, userId, { status: "restoring" });
      if (refreshed) version = refreshed;
    }

    // A direct version-manifest request can arrive after the conversation
    // cold-storage worker has moved the original file.  PDF versions have no
    // independent normalized tree, so returning a seemingly-ready manifest
    // here would make the client start PDF.js and then receive a misleading
    // 404 from the bytes endpoint.  Reuse the conversation activation gate
    // before exposing such a manifest; EPUBs only need the original while
    // their asynchronous normalized representation is missing/processing.
    const normalizedMissing = source.format === "epub"
      && version.status === "ready"
      && !this.normalizedResourceExists(version);
    const needsOriginal = source.format !== "epub"
      || version.status === "processing"
      || normalizedMissing;
    let originalFile: FileRow | undefined;
    let originalAbsolute: string | null = null;
    let originalPresent = false;
    if (needsOriginal) {
      originalFile = this.options.db.getFileForUser(version.file_id, userId);
      const probe = async () => {
        originalAbsolute = originalFile ? this.existingFilePath(originalFile, userId) : null;
        if (!originalAbsolute || !originalFile) return false;
        const stat = await fsp.lstat(originalAbsolute).catch(() => null);
        if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size !== originalFile.size) return false;
        try { assertNoSymlinkPath(originalAbsolute); }
        catch { return false; }
        return true;
      };
      originalPresent = await probe();
      if (!originalPresent) {
        const availability = originalFile ? (this.options.ensureFileAvailable?.(originalFile, userId) ?? "missing") : "missing";
        if (availability === "restoring") throw new ReaderUnavailableError();
        if (availability === "error") throw new ReaderUnavailableError("原文件恢复失败，请稍后重试。");
        // Some local/test cold-storage adapters complete the restore
        // synchronously and report `local`. Re-probe instead of returning a
        // false 404/422 after that successful activation.
        originalPresent = availability === "local" ? await probe() : false;
        if (!originalPresent) throw new ReaderIngestError("原文件不存在或正在恢复。");
      }
    }
    // A process restart can leave an EPUB version in `processing` after the
    // original request has gone away.  Direct version-manifest polling must
    // resume that idempotent ingest instead of waiting forever for a task that
    // only the original open request knew how to start.
    if (source.format === "epub" && (version.status === "processing" || normalizedMissing) && originalPresent && originalFile && originalAbsolute) {
      if (normalizedMissing) {
        const processing = this.options.db.updateReadingVersion(version.id, userId, { status: "processing", last_error: null });
        if (processing) version = processing;
      }
      this.startEpubIngest(version, userId, originalAbsolute);
    }
    return this.manifestFor(source, version, source.format, userId);
  }

  async readUnit(versionId: string, unitId: string, userId: string): Promise<{ unit: ReadingUnitRow; content: string } | null> {
    const version = this.options.db.getReadingVersion(versionId, userId);
    if (!version) return null;
    // Version IDs are private capabilities, but they can outlive a
    // conversation tombstone while GC is finishing. Re-check the live file
    // ownership at the read boundary instead of relying only on the version
    // row's user_id.
    const file = this.options.db.getFileForUser(version.file_id, userId);
    const source = this.options.db.getReadingSource(version.source_id, userId);
    if (!file || !source || source.file_id !== version.file_id) return null;
    if (version.storage_state === "evicting") throw new ReaderUnavailableError("阅读资源正在转入冷存储，请稍后重试。");
    if (this.readerVersionNeedsRestore(version)) {
      if (version.normalized_root) this.startRestore(version, userId);
      throw new ReaderUnavailableError();
    }
    if (version.status === "processing" || version.status === "restoring") throw new ReaderUnavailableError("EPUB 正在解析或恢复，请稍后重试。");
    if (version.status !== "ready") {
      if (version.status === "failed") throw new ReaderIngestError(version.last_error || "EPUB 解析失败。");
      return null;
    }
    const unit = this.options.db.getReadingUnit(versionId, unitId, userId);
    if (!unit?.content_path) return null;
    const root = readerResourcePath(this.options.config, version);
    if (!root) return null;
    let absolute: string;
    try { absolute = resolveInside(root, unit.content_path); } catch { return null; }
    try { assertNoSymlinkPath(absolute); } catch { return null; }
    this.options.db.touchReadingVersion(versionId, userId);
    const stat = await fsp.lstat(absolute).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || !Number.isSafeInteger(unit.byte_size) || stat.size !== unit.byte_size || stat.size > MAX_ASSET_RESPONSE_BYTES) {
      const latest = this.options.db.getReadingVersion(versionId, userId);
      if (latest && ["evicting", "cold", "restoring"].includes(latest.storage_state)) throw new ReaderUnavailableError();
      return null;
    }
    const content = await fsp.readFile(absolute, "utf8");
    return { unit, content };
  }

  async readAsset(versionId: string, assetPath: string, userId: string): Promise<{ absolute: string; contentType: string; size: number } | null> {
    const version = this.options.db.getReadingVersion(versionId, userId);
    if (!version) return null;
    const file = this.options.db.getFileForUser(version.file_id, userId);
    const source = this.options.db.getReadingSource(version.source_id, userId);
    if (!file || !source || source.file_id !== version.file_id) return null;
    if (version.storage_state === "evicting") throw new ReaderUnavailableError("阅读资源正在转入冷存储，请稍后重试。");
    if (this.readerVersionNeedsRestore(version)) {
      if (version.normalized_root) this.startRestore(version, userId);
      throw new ReaderUnavailableError();
    }
    if (version.status === "processing" || version.status === "restoring") throw new ReaderUnavailableError("EPUB 正在解析或恢复，请稍后重试。");
    if (version.status !== "ready") {
      if (version.status === "failed") throw new ReaderIngestError(version.last_error || "EPUB 解析失败。");
      return null;
    }
    const root = readerResourcePath(this.options.config, version);
    if (!root) return null;
    let relative: string;
    try {
      const normalizedAsset = assetPath.replace(/\\/g, "/");
      if (!normalizedAsset || normalizedAsset.includes("\0") || normalizedAsset.startsWith("/")
        || normalizedAsset.split("/").some((part) => !part || part === "." || part === "..")) return null;
      relative = path.posix.join("assets", normalizedAsset);
    } catch { return null; }
    let absolute: string;
    try { absolute = resolveInside(root, relative); } catch { return null; }
    try { assertNoSymlinkPath(absolute); } catch { return null; }
    const stat = await fsp.lstat(absolute).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      const latest = this.options.db.getReadingVersion(versionId, userId);
      if (latest && ["evicting", "cold", "restoring"].includes(latest.storage_state)) throw new ReaderUnavailableError();
      return null;
    }
    if (stat.size > MAX_ASSET_RESPONSE_BYTES) return null;
    this.options.db.touchReadingVersion(versionId, userId);
    return { absolute, contentType: assetContentType(absolute), size: stat.size };
  }

  sourceFile(versionId: string, userId: string): { version: ReadingSourceVersionRow; file: FileRow; absolute: string } | null {
    const version = this.options.db.getReadingVersion(versionId, userId);
    if (!version) return null;
    const file = this.options.db.getFileForUser(version.file_id, userId);
    if (!file) return null;
    let absolute = this.existingFilePath(file, userId);
    if (!absolute) return null;
    const probe = (): boolean => {
      try {
        assertNoSymlinkPath(absolute!);
        const stat = fs.lstatSync(absolute!);
        return stat.isFile() && !stat.isSymbolicLink();
      } catch { return false; }
    };
    if (!probe()) {
      // A direct PDF.js request can race the conversation cold-storage
      // activation that was started by the manifest call. Reuse the same
      // activation gate here so a bytes request receives 202 instead of a
      // misleading 404. Test/local adapters may restore synchronously.
      const availability = this.options.ensureFileAvailable?.(file, userId) ?? "missing";
      if (availability === "restoring") throw new ReaderUnavailableError();
      if (availability === "error") throw new ReaderUnavailableError("原文件恢复失败，请稍后重试。");
      if (availability === "local") {
        absolute = this.existingFilePath(file, userId);
        if (!absolute || !probe()) return null;
      } else return null;
    }
    return { version, file, absolute };
  }
}

const MAX_ASSET_RESPONSE_BYTES = 64 * 1024 * 1024;

function hasRemoteReaderArchive(version: ReadingSourceVersionRow): boolean {
  return Boolean(version.remote_path && version.storage_archive_sha256 && version.storage_archive_bytes && version.storage_manifest_json);
}

function shouldRestoreReaderVersion(version: ReadingSourceVersionRow): boolean {
  // An archive error can be recoverable only after a verified remote object
  // and manifest have been recorded.  In particular, do not reinterpret an
  // ingest/eviction error with no remote metadata as a restore request.
  return version.storage_state === "cold"
    || version.storage_state === "restoring"
    || (version.storage_state === "error" && hasRemoteReaderArchive(version));
}

function sourceId(version: ReadingSourceVersionRow): string { return version.source_id; }

function assetContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
    : extension === ".png" ? "image/png"
      : extension === ".gif" ? "image/gif"
        : extension === ".webp" ? "image/webp"
          : extension === ".avif" ? "image/avif"
            : extension === ".css" ? "text/css; charset=utf-8"
              : extension === ".mp3" ? "audio/mpeg"
                : extension === ".ogg" ? "audio/ogg"
                  : extension === ".mp4" ? "video/mp4"
                    : "application/octet-stream";
}

export { ReaderIngestError };
