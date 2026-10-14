import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { AppDatabase, type ConversationRow, type PendingPromptWithFiles, type StoredAgentSelection } from "./db.js";
import { formatVoiceLexiconTerms } from "./voice-lexicon.js";
import { persistVoiceRecording, removePersistedVoiceRecording, resolveVoiceRecordingPath, sha256File, type PersistedVoiceRecording } from "./voice-recording.js";
import { TRANSCRIPTION_PROMPT_VERSION, type TranscriptionService } from "./transcription.js";
import { resolveInside } from "./paths.js";

type Submission = {
  id: string; user_id: string; conversation_id: string; pending_prompt_id: string | null;
  client_recording_id: string; payload_hash: string; audio_json: string; created_at: string;
  state: "queued" | "processing" | "failed" | "completed" | "cancelled"; error: string | null;
};
export class VoiceSubmissionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** The HTTP acknowledgement owns no transcription promise. SQLite and the
 * persisted recording are the source of truth after navigation or restart. */
export class VoiceSubmissionService {
  private stopped = false;
  private running: Promise<void> | null = null;
  constructor(private config: AppConfig, private db: AppDatabase, private transcription: Pick<TranscriptionService, "audioRoot" | "transcribe">,
    private changed: (conversationId: string) => void, private ready: () => void) {
    db.sqlite.prepare("UPDATE voice_submissions SET state='queued' WHERE state='processing'").run();
  }
  get(userId: string, recordingId: string): Submission | undefined {
    return this.db.sqlite.prepare("SELECT * FROM voice_submissions WHERE user_id=? AND client_recording_id=?").get(userId, recordingId) as Submission | undefined;
  }
  accept(input: { conversation: ConversationRow; recordingId: string; filePath: string; mimeType: string;
    content: string; quote: string | null; selection: StoredAgentSelection; voiceIds: string[]; maximumBytes: number }): PendingPromptWithFiles | null {
    const { conversation, recordingId } = input;
    const audioHash = sha256File(input.filePath);
    // Prior transcription IDs are in-memory browser metadata; a reload after a
    // lost acknowledgement may omit them. The original receipt owns those links.
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify([conversation.id, input.content, input.quote, audioHash])).digest("hex");
    const existing = this.get(conversation.user_id, recordingId);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new VoiceSubmissionError("同一录音 ID 对应了不同发送内容。");
      // A pagehide save after a lost response can recreate the text we already
      // accepted. Clear only that exact text-only draft, never newer work/files.
      const draft = this.db.getComposerDraft(conversation.id);
      if (draft && draft.content.trim() === input.content && (draft.quote_excerpt ?? "") === (input.quote ?? "")
        && draft.files.length === 0 && this.db.listActiveResumableUploads(conversation.id).length === 0) {
        this.db.deleteComposerDraft(conversation.id); this.changed(conversation.id);
      }
      return existing.pending_prompt_id ? this.db.getPendingPrompt(existing.pending_prompt_id) ?? null : null;
    }
    if (this.db.getVoiceTranscriptionByClientRecordingId(conversation.user_id, recordingId)) throw new VoiceSubmissionError("该录音已转写，请发送已有文字。");
    if (!this.db.validateVoiceTranscriptions(input.voiceIds, conversation.user_id)) throw new VoiceSubmissionError("语音转写记录无效或已经发送。", 400);
    if (this.db.listPendingPrompts(conversation.id, "editing").length) throw new VoiceSubmissionError("请先完成或取消正在编辑的待发送任务。");
    if (this.db.listActiveResumableUploads(conversation.id).length) throw new VoiceSubmissionError("附件尚未上传完成，请完成后再发送。");
    const bytes = fs.statSync(input.filePath).size;
    const reserved = this.db.sqlite.prepare("SELECT COALESCE(SUM(json_extract(audio_json,'$.bytes')),0) AS bytes FROM voice_submissions WHERE user_id=? AND state IN ('queued','processing','failed')").get(conversation.user_id) as { bytes: number };
    if (this.db.sumStoredFileBytesForUser(conversation.user_id) + reserved.bytes + bytes > input.maximumBytes) throw new VoiceSubmissionError("文件存储已达到安全上限。", 413);
    const id = crypto.randomUUID(), pendingId = crypto.randomUUID(), now = new Date().toISOString();
    const audio = persistVoiceRecording({ dataRoot: this.config.dataRoot, sourcePath: input.filePath, userId: conversation.user_id, transcriptionId: id, mimeType: input.mimeType });
    let transactionStarted = false;
    try {
      this.db.sqlite.exec("BEGIN IMMEDIATE"); transactionStarted = true;
      this.db.createPendingPrompt(pendingId, conversation.id, input.content, input.selection, input.quote);
      // Older releases treat editing prompts as non-dispatchable too. A rollback
      // must never execute typed context before its audio has been recognized.
      this.db.sqlite.prepare("UPDATE pending_prompts SET status='editing' WHERE id=?").run(pendingId);
      this.db.sqlite.prepare("UPDATE files SET pending_prompt_id=?,composer_draft_id=NULL WHERE conversation_id=? AND composer_draft_id=?").run(pendingId, conversation.id, conversation.id);
      this.db.deleteComposerDraft(conversation.id);
      this.db.sqlite.prepare("INSERT INTO voice_submissions(id,user_id,conversation_id,pending_prompt_id,client_recording_id,payload_hash,audio_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)")
        .run(id, conversation.user_id, conversation.id, pendingId, recordingId, payloadHash, JSON.stringify(audio), now, now);
      for (const voiceId of input.voiceIds) this.db.sqlite.prepare("UPDATE voice_transcriptions SET conversation_id=?,project_id=?,pending_prompt_id=?,submitted_at=? WHERE id=? AND user_id=? AND submitted_at IS NULL")
        .run(conversation.id, conversation.project_id, pendingId, now, voiceId, conversation.user_id);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      try { if (transactionStarted) this.db.sqlite.exec("ROLLBACK"); }
      finally { removePersistedVoiceRecording(this.config.dataRoot, audio.relativePath); }
      throw error;
    }
    console.info("[voice-timing]", JSON.stringify({ at: new Date().toISOString(), stage: "submission_accepted", submissionId: id, audioId: path.basename(input.filePath).split(".")[0] }));
    this.changed(conversation.id);
    return this.db.getPendingPrompt(pendingId)!;
  }
  retry(userId: string, pendingId: string): boolean {
    const row = this.db.sqlite.prepare("SELECT * FROM voice_submissions WHERE user_id=? AND pending_prompt_id=?").get(userId, pendingId) as Submission | undefined;
    if (!row || row.state !== "failed") return false;
    this.db.sqlite.prepare("UPDATE voice_submissions SET state='queued',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    this.changed(row.conversation_id); return true;
  }
  cancel(pendingId: string): void {
    const row = this.db.sqlite.prepare("SELECT * FROM voice_submissions WHERE pending_prompt_id=?").get(pendingId) as Submission | undefined;
    if (!row || row.state === "completed" || row.state === "cancelled") return;
    this.db.sqlite.prepare("UPDATE voice_submissions SET state='cancelled',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    removePersistedVoiceRecording(this.config.dataRoot, (JSON.parse(row.audio_json) as PersistedVoiceRecording).relativePath);
  }
  stop(): void { this.stopped = true; }
  async wait(): Promise<void> { await this.running; }
  pump(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const row = this.db.sqlite.prepare(`SELECT voice.* FROM voice_submissions voice JOIN conversations c ON c.id=voice.conversation_id
        WHERE voice.state='queued' AND c.deleted_at IS NULL AND c.archived_at IS NULL ORDER BY voice.created_at,voice.id LIMIT 1`).get() as Submission | undefined;
      if (!row) return;
      const pending = row.pending_prompt_id ? this.db.getPendingPrompt(row.pending_prompt_id) : undefined;
      if (!pending) { this.db.sqlite.prepare("UPDATE voice_submissions SET state='cancelled' WHERE id=?").run(row.id); removePersistedVoiceRecording(this.config.dataRoot, (JSON.parse(row.audio_json) as PersistedVoiceRecording).relativePath); continue; }
      const audio = JSON.parse(row.audio_json) as PersistedVoiceRecording;
      const temporary = path.join(this.transcription.audioRoot, crypto.randomUUID() + path.extname(audio.relativePath));
      this.db.sqlite.prepare("UPDATE voice_submissions SET state='processing',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
      console.info("[voice-timing]", JSON.stringify({ at: new Date().toISOString(), stage: "recognition_started", submissionId: row.id, audioId: path.basename(temporary).split(".")[0], acceptedAgeMs: Math.max(0, Date.now() - Date.parse(row.created_at)) }));
      this.changed(row.conversation_id);
      try {
        fs.copyFileSync(resolveVoiceRecordingPath(this.config.dataRoot, audio.relativePath), temporary);
        const conversation = this.db.getConversationForUser(row.conversation_id, row.user_id)!;
        const lexicon = formatVoiceLexiconTerms(this.db.listVoiceLexiconTerms(row.user_id, conversation.project_id, this.config.voiceLexiconMaxTerms));
        const workspace = path.join(this.config.tenantRoot, row.user_id, "conversations", row.conversation_id);
        const text = await this.transcription.transcribe(path.basename(temporary), {
          purpose: "composer", draftText: pending.content, attachmentNames: pending.files.map(f => f.original_name),
          attachments: pending.files.map(f => ({ name: f.original_name, filePath: resolveInside(workspace, f.relative_path), mimeType: f.mime_type, size: f.size })),
          recentMessages: this.db.listMessages(row.conversation_id).slice(-4).map(m => ({ role: m.role, content: m.content })),
          personalizedTerms: ["Codex Web", ...lexicon.lines],
        });
        if (!text.trim()) throw new Error("没有识别到清晰语音，请重试。");
        const current = this.get(row.user_id, row.client_recording_id);
        if (current?.state !== "processing" || !this.db.getPendingPrompt(pending.id) || !this.db.getConversationForUser(row.conversation_id, row.user_id)) continue;
        const combined = pending.content ? `${pending.content}\n${text}` : text;
        const acceptedContext = this.db.sqlite.prepare("SELECT snapshot FROM para_pending_context WHERE pending_id=?").get(pending.id) as { snapshot: string } | undefined;
        this.db.sqlite.exec("BEGIN IMMEDIATE");
        try {
          this.db.createVoiceTranscription({ id: row.id, userId: row.user_id, clientRecordingId: row.client_recording_id, conversationId: row.conversation_id,
            projectId: conversation.project_id, rawText: text, model: this.config.dashscopeModel, promptVersion: TRANSCRIPTION_PROMPT_VERSION, selectedTermIds: lexicon.ids, audio });
          this.db.sqlite.prepare("UPDATE voice_transcriptions SET pending_prompt_id=?,submitted_at=? WHERE id=?").run(pending.id, new Date().toISOString(), row.id);
          this.db.sqlite.prepare("UPDATE pending_prompts SET content=?,status='queued',updated_at=? WHERE id=?").run(combined, new Date().toISOString(), pending.id);
          // Adding recognition text is not a new user edit of project context.
          this.db.sqlite.prepare("DELETE FROM para_pending_context WHERE pending_id=?").run(pending.id);
          if (acceptedContext) this.db.sqlite.prepare("INSERT INTO para_pending_context(pending_id,snapshot) VALUES(?,?)").run(pending.id, acceptedContext.snapshot);
          this.db.sqlite.prepare("UPDATE voice_submissions SET state='completed',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
          this.db.sqlite.exec("COMMIT");
        } catch (error) { this.db.sqlite.exec("ROLLBACK"); throw error; }
        this.changed(row.conversation_id); this.ready();
      } catch (error) {
        this.db.sqlite.prepare("UPDATE voice_submissions SET state='failed',error=?,updated_at=? WHERE id=? AND state='processing'")
          .run(error instanceof Error ? error.message.slice(0, 500) : "语音识别失败", new Date().toISOString(), row.id);
        this.changed(row.conversation_id);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
}
