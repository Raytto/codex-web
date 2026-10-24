import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase, FileRow } from "./db.js";
import { cleanupFinalizationDirectory, prepareFinalizationFiles, type FinalizationFileSource, type PresentationWarning } from "./job-finalization.js";
import { cleanupOwnedStagingDirectory } from "./owned-staging.js";
import { resolveInside } from "./paths.js";
import { RemoteFileFetchError, type RemoteWorkerGateway, type StoredFetchedArtifact } from "./remote-worker-gateway.js";
import { sha256File } from "./voice-recording.js";
import { PRESENTATION_SUFFIX, WEB_MAX_BYTES } from "./web-presentation.js";

type FetchRequest = { conversationId: string; messageId: string; userId: string; sourcePath: string; executorId: string; projectRoot: string; maximumStoredBytes: number };
export type RemoteFileDeliveryResult = { file: FileRow; alreadyFetched: boolean; warnings: PresentationWarning[] };

/** The manual remote-file entry uses the same verified publication boundary as job outputs. */
export class RemoteFileDelivery {
  private readonly pending = new Map<string, Promise<RemoteFileDeliveryResult>>();
  constructor(private readonly db: AppDatabase, private readonly dataRoot: string, private readonly workers: Pick<RemoteWorkerGateway, "fetchFile">) {}

  async fetch(input: FetchRequest): Promise<RemoteFileDeliveryResult> {
    const key = JSON.stringify([input.messageId, input.sourcePath]);
    const pending = this.pending.get(key);
    if (pending) return { ...await pending, alreadyFetched: true };
    const operation = this.prepare(input);
    this.pending.set(key, operation);
    try { return await operation; }
    finally { this.pending.delete(key); }
  }

  private async prepare(input: FetchRequest): Promise<RemoteFileDeliveryResult> {
    const existing = this.db.getFileForMessageSource(input.messageId, input.sourcePath);
    const isHtml = /\.html?$/i.test(existing?.original_name ?? input.sourcePath);
    if (existing && (!isHtml || existing.presentation_mode === "web")) return { file: existing, alreadyFetched: true, warnings: [] };
    const staged: StoredFetchedArtifact[] = [], sources: FinalizationFileSource[] = [];
    const finalizationId = crypto.randomUUID();
    let registered = false;
    let declarationUnavailable = false;
    const fetch = async (sourcePath: string) => {
      const artifact = await this.workers.fetchFile(input.executorId, input.projectRoot, sourcePath);
      staged.push(artifact);
      return artifact;
    };
    const fetchDeclaration = async () => {
      try { return await fetch(input.sourcePath + PRESENTATION_SUFFIX); }
      catch (error) {
        // Older workers collapse filesystem absence and access errors into this
        // exact message. Neither grants execution; transport failures still fail.
        if (!(error instanceof RemoteFileFetchError) || (error.errorCode !== "NOT_FOUND" && error.message !== "文件不存在或无法访问")) throw error;
        declarationUnavailable = true;
        return undefined;
      }
    };
    const unavailableWarnings = (file: Pick<FileRow, "original_name" | "size">, absolute: string): PresentationWarning[] => {
      if (!declarationUnavailable || file.size > WEB_MAX_BYTES) return [];
      const text = fs.readFileSync(absolute, "utf8");
      // A hint only helps explain why scripts did not run; it never enables them.
      if (!/<script\b|\bon[a-z]+\s*=|pp-agent-view/i.test(text)) return [];
      return [{ fileName: file.original_name, reason: "未能读取同名展示声明，已保留为阅读文档，脚本不会运行。可在文件设置中选择“以交互网页打开”，校验后生成新的私有版本。" }];
    };
    try {
      // A cached reader remains usable if an older worker has no declaration.
      let declaration = existing && isHtml ? await fetchDeclaration() : undefined;
      if (existing && isHtml && !declaration) {
        return { file: existing, alreadyFetched: true, warnings: unavailableWarnings(existing, resolveInside(this.dataRoot, existing.relative_path)) };
      }
      const artifact = await fetch(input.sourcePath);
      if (!existing && /\.html?$/i.test(artifact.name)) declaration = await fetchDeclaration();
      const row = (item: StoredFetchedArtifact): FileRow => {
        const id = crypto.randomUUID();
        return { id, conversation_id: input.conversationId, message_id: input.messageId, original_name: item.name,
          relative_path: path.posix.join("deliverables", id, item.name), source_path: input.sourcePath,
          mime_type: /\.html?$/i.test(item.name) ? "text/html" : item.mimeType, size: item.size, kind: "output", created_at: new Date().toISOString(),
          previous_file_id: existing?.id ?? null };
      };
      sources.push({ row: row(artifact), sourcePath: artifact.tempPath, expectedSha256: artifact.sha256 });
      if (declaration) {
        if (declaration.name !== artifact.name + PRESENTATION_SUFFIX) throw new Error("远程展示声明文件名与成品不一致，请重新交付。");
        sources.push({ row: row(declaration), sourcePath: declaration.tempPath, expectedSha256: declaration.sha256 });
      }
      const { files, warnings } = await prepareFinalizationFiles(this.dataRoot, finalizationId, sources);
      const file = files[0];
      if (!file || files.length !== 1) throw new Error("远程文件登记结果无效。");
      warnings.push(...unavailableWarnings(file, resolveInside(this.dataRoot, file.relative_path)));
      const current = this.db.getConversationForUser(input.conversationId, input.userId);
      if (!current || current.cold_storage_state !== "local") throw new Error("来源会话状态已变化，请恢复会话后重新获取文件。");
      // Include explicitly corrected versions, and hash legacy cached readers
      // whose old registration did not persist sha256. Never mutate their type.
      const duplicate = this.db.listFilesForMessage(input.messageId).find(candidate => candidate.source_path === input.sourcePath
        && candidate.size === file.size && (candidate.presentation_mode ?? "reader") === file.presentation_mode
        && (candidate.sha256 ?? sha256File(resolveInside(this.dataRoot, candidate.relative_path))) === file.sha256);
      if (duplicate) return { file: duplicate, alreadyFetched: true, warnings };
      this.db.addFiles(files, input.userId, input.maximumStoredBytes);
      registered = true;
      return { file, alreadyFetched: false, warnings };
    } finally {
      if (!registered) for (const source of sources) {
        await fs.promises.rm(path.dirname(resolveInside(this.dataRoot, source.row.relative_path)), { recursive: true, force: true }).catch(() => undefined);
      }
      await cleanupFinalizationDirectory(this.dataRoot, finalizationId).catch(() => undefined);
      for (const artifact of staged) {
        try { cleanupOwnedStagingDirectory(this.dataRoot, "remote-worker-fetch-staging", path.basename(path.dirname(artifact.tempPath))); }
        catch { /* Cleanup must not hide a successful, immutable publication. */ }
      }
    }
  }
}
