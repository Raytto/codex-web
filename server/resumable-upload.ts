import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { AppDatabase, StorageQuotaExceededError, type FileRow, type ResumableUploadRow, type SessionRow } from "./db.js";
import { ensureTenantWorkspace, newId, safeUploadName } from "./paths.js";

const TUS_VERSION = "1.0.0";
const ACTIVE_STATES = new Set(["uploading", "finalizing"]);

type ServiceOptions = {
  db: AppDatabase;
  config: AppConfig;
  availableDiskBytes: (forceRefresh?: boolean) => number;
  maximumStoredBytesForUser: (userId: string) => number;
};

function metadataValues(header: string | undefined): Map<string, string> {
  const values = new Map<string, string>();
  if (!header) return values;
  if (header.length > 4_096) throw new Error("UPLOAD_METADATA_INVALID");
  for (const entry of header.split(",")) {
    const [key, encoded = ""] = entry.trim().split(/\s+/, 2);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || values.has(key)) throw new Error("UPLOAD_METADATA_INVALID");
    let decoded = "";
    try {
      if (encoded && (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) throw new Error("invalid base64");
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
    }
    catch { throw new Error("UPLOAD_METADATA_INVALID"); }
    if (Buffer.byteLength(decoded) > 1_024 || decoded.includes("\0")) throw new Error("UPLOAD_METADATA_INVALID");
    values.set(key, decoded);
  }
  return values;
}

function headerInteger(value: string | undefined): number | null {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function metadataHeader(upload: Pick<ResumableUploadRow, "original_name" | "mime_type" | "conversation_id">): string {
  return [
    ["filename", upload.original_name],
    ["filetype", upload.mime_type],
    ["conversationId", upload.conversation_id],
  ].map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`).join(",");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export class ResumableUploadService {
  readonly root: string;
  private readonly legacyRoot: string;
  private readonly db: AppDatabase;
  private readonly config: AppConfig;
  private readonly availableDiskBytes: ServiceOptions["availableDiskBytes"];
  private readonly maximumStoredBytesForUser: ServiceOptions["maximumStoredBytesForUser"];
  private readonly locks = new Set<string>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(options: ServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.availableDiskBytes = options.availableDiskBytes;
    this.maximumStoredBytesForUser = options.maximumStoredBytesForUser;
    // Partials must live on the same mounted filesystem as tenant workspaces so
    // completion can be an atomic rename without temporarily duplicating a
    // multi-gigabyte upload. The former dataRoot location remains readable for
    // in-flight uploads created by releases before 2026-08-08.
    this.root = path.join(this.config.tenantRoot, ".resumable-uploads");
    this.legacyRoot = path.join(this.config.dataRoot, "resumable-uploads");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.root, 0o700); } catch { /* A restrictive umask already protects the directory. */ }
  }

  start(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error) => console.error("Resumable upload cleanup failed", error instanceof Error ? error.message : error));
    }, 15 * 60_000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private partialPath(upload: Pick<ResumableUploadRow, "storage_name">): string {
    const current = path.join(this.root, upload.storage_name);
    const legacy = path.join(this.legacyRoot, upload.storage_name);
    if (fs.existsSync(current) || !fs.existsSync(legacy)) return current;
    return legacy;
  }

  private partialPaths(upload: Pick<ResumableUploadRow, "storage_name">): string[] {
    return [...new Set([path.join(this.root, upload.storage_name), path.join(this.legacyRoot, upload.storage_name)])];
  }

  private async removePartials(upload: Pick<ResumableUploadRow, "storage_name">): Promise<void> {
    await Promise.all(this.partialPaths(upload).map((candidate) => fs.promises.rm(candidate, { force: true })));
  }

  private finalPath(upload: Pick<ResumableUploadRow, "user_id" | "conversation_id" | "final_name">): string {
    return path.join(ensureTenantWorkspace(this.config.tenantRoot, upload.user_id, upload.conversation_id), "uploads", upload.final_name);
  }

  private expiresAt(): string {
    return new Date(Date.now() + this.config.resumableUploadExpiryHours * 3_600_000).toISOString();
  }

  private isLocked(id: string): boolean {
    return this.locks.has(id) || this.locks.has(`${id}:finalize`);
  }

  private applyTusHeaders(res: Response, upload?: ResumableUploadRow): void {
    res.setHeader("Tus-Resumable", TUS_VERSION);
    res.setHeader("Tus-Version", TUS_VERSION);
    res.setHeader("Tus-Extension", "creation,termination,expiration");
    res.setHeader("Tus-Max-Size", String(this.config.maxUploadFileBytes));
    res.setHeader("Cache-Control", "private, no-store");
    if (upload && ACTIVE_STATES.has(upload.state)) res.setHeader("Upload-Expires", new Date(upload.expires_at).toUTCString());
  }

  private versionAccepted(req: Request, res: Response): boolean {
    if (req.get("tus-resumable") === TUS_VERSION) {
      this.applyTusHeaders(res);
      return true;
    }
    this.applyTusHeaders(res);
    res.status(412).end();
    return false;
  }

  options(_req: Request, res: Response): Response {
    this.applyTusHeaders(res);
    return res.status(204).end();
  }

  private reservedRemainingBytes(): number {
    return this.db.listActiveResumableUploads().reduce((total, upload) => total + Math.max(0, upload.size - upload.offset), 0);
  }

  async create(req: Request, res: Response, session: SessionRow): Promise<Response> {
    if (!this.versionAccepted(req, res)) return res;
    const size = headerInteger(req.get("upload-length"));
    if (size === null) return res.status(400).json({ code: "UPLOAD_LENGTH_INVALID", error: "上传长度无效。" });
    if (size > this.config.maxUploadFileBytes) return res.status(413).json({ code: "UPLOAD_TOO_LARGE", error: "单个附件不能超过 2 GiB。" });
    let metadata: Map<string, string>;
    try { metadata = metadataValues(req.get("upload-metadata")); }
    catch { return res.status(400).json({ code: "UPLOAD_METADATA_INVALID", error: "上传元数据无效。" }); }
    const conversationId = metadata.get("conversationId") ?? "";
    const originalName = metadata.get("filename") ?? "file";
    const mimeType = (metadata.get("filetype") ?? "application/octet-stream").slice(0, 255) || "application/octet-stream";
    const conversation = this.db.getConversationForUser(conversationId, session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档，请恢复后再继续发送。" });
    if (this.availableDiskBytes(true) - this.reservedRemainingBytes() - size < this.config.minimumFreeDiskBytes) {
      return res.status(507).json({ code: "DISK_WATERMARK", error: "服务器磁盘可用空间低于上传安全水位。" });
    }
    const id = newId();
    const fileId = newId();
    const safeName = safeUploadName(originalName);
    const now = new Date().toISOString();
    const storageName = `${id}.part`;
    const partialPath = path.join(this.root, storageName);
    let created = false;
    try {
      const descriptor = await fs.promises.open(partialPath, "wx", 0o600);
      await descriptor.close();
      created = true;
      let upload = this.db.createResumableUpload({
        id, user_id: session.user_id, conversation_id: conversationId, file_id: fileId,
        original_name: safeName.displayName, mime_type: mimeType, size, storage_name: storageName,
        final_name: safeName.diskName, created_at: now, updated_at: now, expires_at: this.expiresAt(),
      }, this.maximumStoredBytesForUser(session.user_id));
      if (upload.size === 0) upload = await this.finalize(upload);
      this.applyTusHeaders(res, upload);
      res.setHeader("Location", `${this.config.basePath}/api/uploads/${encodeURIComponent(id)}`);
      return res.status(201).end();
    } catch (error) {
      if (created) await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
      if (error instanceof StorageQuotaExceededError) return res.status(413).json({ code: error.code, error: "该账号的文件存储已达到安全上限，请先删除不再需要的文件。" });
      if (error instanceof Error && error.message === "DRAFT_FILE_LIMIT") return res.status(409).json({ code: "DRAFT_FILE_LIMIT", error: "单个会话草稿最多包含 12 个附件。" });
      console.error("Resumable upload creation failed", error instanceof Error ? error.message : error);
      return res.status(500).json({ error: "断点续传初始化失败。" });
    }
  }

  async head(req: Request, res: Response, session: SessionRow): Promise<Response> {
    if (!this.versionAccepted(req, res)) return res;
    let upload = this.db.getResumableUploadForUser(String(req.params.id), session.user_id);
    if (!upload || upload.state === "cancelled" || upload.state === "expired") return res.status(404).end();
    if (upload.state === "finalizing") upload = await this.finalize(upload);
    this.applyTusHeaders(res, upload);
    res.setHeader("Upload-Length", String(upload.size));
    res.setHeader("Upload-Offset", String(upload.offset));
    res.setHeader("Upload-Metadata", metadataHeader(upload));
    return res.status(200).end();
  }

  async patch(req: Request, res: Response, session: SessionRow): Promise<Response> {
    if (!this.versionAccepted(req, res)) return res;
    const id = String(req.params.id);
    let upload = this.db.getResumableUploadForUser(id, session.user_id);
    if (!upload || upload.state === "cancelled" || upload.state === "expired") return res.status(404).end();
    if (upload.state === "completed") {
      this.applyTusHeaders(res, upload);
      res.setHeader("Upload-Offset", String(upload.size));
      return res.status(204).end();
    }
    if (upload.state === "finalizing") {
      upload = await this.finalize(upload);
      this.applyTusHeaders(res, upload);
      res.setHeader("Upload-Offset", String(upload.offset));
      return res.status(204).end();
    }
    if (req.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/offset+octet-stream") {
      return res.status(415).json({ error: "PATCH 必须使用 application/offset+octet-stream。" });
    }
    const requestedOffset = headerInteger(req.get("upload-offset"));
    const contentLength = headerInteger(req.get("content-length"));
    if (requestedOffset === null || contentLength === null) return res.status(400).json({ error: "上传偏移或分块长度无效。" });
    const stat = await fs.promises.stat(this.partialPath(upload)).catch(() => null);
    const authoritativeOffset = stat?.size ?? upload.offset;
    if (authoritativeOffset !== upload.offset) upload = this.db.reconcileResumableUploadOffset(upload.id, authoritativeOffset, this.expiresAt()) ?? upload;
    if (requestedOffset !== authoritativeOffset) {
      this.applyTusHeaders(res, upload);
      res.setHeader("Upload-Offset", String(authoritativeOffset));
      return res.status(409).end();
    }
    if (contentLength > this.config.resumableUploadChunkBytes || requestedOffset + contentLength > upload.size) {
      return res.status(413).json({ code: "UPLOAD_CHUNK_TOO_LARGE", error: "上传分块超过允许大小。" });
    }
    if (this.locks.has(id)) return res.status(409).json({ code: "UPLOAD_BUSY", error: "同一附件已有上传分块正在处理。" });
    this.locks.add(id);
    let cursor = requestedOffset;
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(this.partialPath(upload), "r+");
      for await (const value of req) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (cursor + chunk.length > requestedOffset + contentLength || cursor + chunk.length > upload.size) throw new Error("UPLOAD_BODY_TOO_LARGE");
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written, cursor + written);
          if (result.bytesWritten <= 0) throw new Error("UPLOAD_WRITE_STALLED");
          written += result.bytesWritten;
        }
        cursor += chunk.length;
      }
      if (cursor !== requestedOffset + contentLength) throw new Error("UPLOAD_BODY_INCOMPLETE");
      await handle.sync();
      await handle.close();
      handle = undefined;
      upload = this.db.updateResumableUploadOffset(id, cursor, this.expiresAt()) ?? upload;
      if (cursor === upload.size) upload = await this.finalize(upload);
      this.applyTusHeaders(res, upload);
      res.setHeader("Upload-Offset", String(cursor));
      return res.status(204).end();
    } catch (error) {
      await handle?.sync().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      const currentSize = (await fs.promises.stat(this.partialPath(upload)).catch(() => null))?.size ?? cursor;
      if (currentSize >= upload.offset && currentSize <= upload.size) this.db.reconcileResumableUploadOffset(id, currentSize, this.expiresAt());
      if (!req.aborted) console.warn(JSON.stringify({ event: "resumable_upload_patch_failed", uploadId: id, offset: currentSize, error: error instanceof Error ? error.message : String(error) }));
      if (!res.headersSent && !req.aborted) {
        if (currentSize === upload.size) return res.status(500).json({ code: "UPLOAD_FINALIZATION_FAILED", error: "文件已完整接收，服务器将在重试时继续完成登记。" });
        return res.status(error instanceof Error && error.message === "UPLOAD_BODY_TOO_LARGE" ? 413 : 400).json({ error: "上传分块未完整接收，可从服务器确认的偏移继续。" });
      }
      return res;
    } finally {
      this.locks.delete(id);
    }
  }

  async terminate(req: Request, res: Response, session: SessionRow): Promise<Response> {
    if (!this.versionAccepted(req, res)) return res;
    const upload = this.db.getResumableUploadForUser(String(req.params.id), session.user_id);
    if (!upload || upload.state === "cancelled" || upload.state === "expired") return res.status(404).end();
    if (upload.state === "completed") return res.status(409).json({ error: "附件已经完成登记，请从草稿中删除。" });
    if (this.isLocked(upload.id)) return res.status(409).json({ code: "UPLOAD_BUSY", error: "上传分块仍在写入，请稍后重试取消。" });
    this.db.markResumableUploadTerminated(upload.id, "cancelled");
    await Promise.all([
      this.removePartials(upload),
      fs.promises.rm(this.finalPath(upload), { force: true }),
    ]).catch(() => undefined);
    this.applyTusHeaders(res);
    return res.status(204).end();
  }

  async result(req: Request, res: Response, session: SessionRow): Promise<Response> {
    let upload = this.db.getResumableUploadForUser(String(req.params.id), session.user_id);
    if (!upload) return res.status(404).json({ error: "上传不存在。" });
    if (upload.state === "finalizing") upload = await this.finalize(upload);
    if (upload.state !== "completed") return res.status(409).json({ code: "UPLOAD_INCOMPLETE", offset: upload.offset, size: upload.size, error: "上传尚未完成。" });
    const file = this.db.getFileForUser(upload.file_id, session.user_id);
    const composerDraft = this.db.getComposerDraft(upload.conversation_id);
    if (!file || !composerDraft || file.composer_draft_id !== upload.conversation_id) return res.status(409).json({ error: "上传已经完成，但草稿登记尚未恢复。" });
    return res.json({ composerDraft, uploadedFiles: [file] });
  }

  private async finalize(upload: ResumableUploadRow): Promise<ResumableUploadRow> {
    if (upload.state === "completed") return upload;
    if (this.locks.has(`${upload.id}:finalize`)) return this.db.getResumableUpload(upload.id) ?? upload;
    this.locks.add(`${upload.id}:finalize`);
    try {
      const partialPath = this.partialPath(upload);
      const finalPath = this.finalPath(upload);
      const finalStat = await fs.promises.stat(finalPath).catch(() => null);
      if (!finalStat) {
        const partialStat = await fs.promises.stat(partialPath);
        if (partialStat.size !== upload.size) throw new Error("Upload is not complete");
        upload = this.db.markResumableUploadFinalizing(upload.id, partialStat.size) ?? upload;
        try {
          await fs.promises.rename(partialPath, finalPath);
        } catch (error) {
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          // Transitional recovery for sessions created in the old dataRoot.
          // New uploads never take this path. Keep the destination invisible
          // until a fully copied and fsynced temporary file is atomically moved.
          if (this.availableDiskBytes(true) - upload.size < this.config.minimumFreeDiskBytes) throw new Error("DISK_WATERMARK_FINALIZE");
          const temporaryPath = `${finalPath}.${upload.id}.tus-finalizing`;
          await fs.promises.rm(temporaryPath, { force: true });
          await fs.promises.copyFile(partialPath, temporaryPath);
          await fs.promises.chmod(temporaryPath, 0o600);
          const temporary = await fs.promises.open(temporaryPath, "r");
          try { await temporary.sync(); } finally { await temporary.close(); }
          await fs.promises.rename(temporaryPath, finalPath);
          await fs.promises.rm(partialPath, { force: true });
        }
      } else if (finalStat.size !== upload.size) {
        throw new Error("Final upload size mismatch");
      } else {
        upload = this.db.markResumableUploadFinalizing(upload.id, upload.size) ?? upload;
      }
      await this.removePartials(upload);
      const sha256 = await sha256File(finalPath);
      const file: FileRow = {
        id: upload.file_id, conversation_id: upload.conversation_id, message_id: null, pending_prompt_id: null,
        composer_draft_id: upload.conversation_id, original_name: upload.original_name,
        relative_path: path.posix.join("uploads", upload.final_name), mime_type: upload.mime_type,
        size: upload.size, sha256, kind: "upload", created_at: upload.created_at,
      };
      const completed = this.db.completeResumableUpload(upload.id, file, this.maximumStoredBytesForUser(upload.user_id));
      console.info(JSON.stringify({ event: "resumable_upload_completed", uploadId: upload.id, userId: upload.user_id, conversationId: upload.conversation_id, size: upload.size, sha256 }));
      return completed;
    } finally {
      this.locks.delete(`${upload.id}:finalize`);
    }
  }

  async cancelConversationUploads(conversationId: string): Promise<void> {
    for (const upload of this.db.listActiveResumableUploads(conversationId)) {
      if (this.isLocked(upload.id)) throw new Error("会话仍有附件分块正在写入");
      this.db.markResumableUploadTerminated(upload.id, "cancelled");
      await Promise.all([
        this.removePartials(upload),
        fs.promises.rm(this.finalPath(upload), { force: true }),
      ]);
    }
  }

  async cleanupExpired(): Promise<{ expired: number; orphans: number }> {
    let expired = 0;
    for (const upload of this.db.listExpiredResumableUploads(new Date().toISOString())) {
      if (this.isLocked(upload.id)) continue;
      if (this.db.markResumableUploadTerminated(upload.id, "expired")) expired += 1;
      await Promise.all([
        this.removePartials(upload),
        fs.promises.rm(this.finalPath(upload), { force: true }),
      ]).catch(() => undefined);
    }
    const known = new Set(this.db.listActiveResumableUploads().map((upload) => upload.storage_name));
    let orphans = 0;
    const cutoff = Date.now() - this.config.resumableUploadExpiryHours * 3_600_000;
    for (const uploadRoot of [...new Set([this.root, this.legacyRoot])]) {
      const entries = await fs.promises.readdir(uploadRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.part$/i.test(entry.name) || known.has(entry.name)) continue;
        const candidate = path.join(uploadRoot, entry.name);
        const stat = await fs.promises.stat(candidate).catch(() => null);
        if (stat && stat.mtimeMs <= cutoff) {
          await fs.promises.rm(candidate, { force: true });
          orphans += 1;
        }
      }
    }
    if (expired || orphans) console.info(JSON.stringify({ event: "resumable_upload_cleanup", expired, orphans }));
    return { expired, orphans };
  }

  async recover(): Promise<{ finalized: number; reconciled: number; cancelled: number }> {
    let finalized = 0;
    let reconciled = 0;
    let cancelled = 0;
    await this.cleanupExpired();
    for (let upload of this.db.listActiveResumableUploads()) {
      if (new Date(upload.expires_at).getTime() <= Date.now()) continue;
      const finalStat = await fs.promises.stat(this.finalPath(upload)).catch(() => null);
      if (finalStat?.size === upload.size) {
        upload = this.db.markResumableUploadFinalizing(upload.id, upload.size) ?? upload;
        await this.finalize(upload);
        finalized += 1;
        continue;
      }
      const partialStat = await fs.promises.stat(this.partialPath(upload)).catch(() => null);
      if (!partialStat || partialStat.size > upload.size) {
        this.db.markResumableUploadTerminated(upload.id, "cancelled");
        await this.removePartials(upload).catch(() => undefined);
        cancelled += 1;
        continue;
      }
      if (partialStat.size !== upload.offset) {
        upload = this.db.reconcileResumableUploadOffset(upload.id, partialStat.size, this.expiresAt()) ?? upload;
        reconciled += 1;
      }
      if (partialStat.size === upload.size) {
        await this.finalize(upload);
        finalized += 1;
      }
    }
    if (finalized || reconciled || cancelled) console.info(JSON.stringify({ event: "resumable_upload_recovery", finalized, reconciled, cancelled }));
    return { finalized, reconciled, cancelled };
  }
}
