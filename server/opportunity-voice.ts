import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './db.js';
import { OpportunityStore, OpportunityError } from './opportunity-store.js';
import { formatVoiceLexiconTerms } from './voice-lexicon.js';
import { persistVoiceRecording, removePersistedVoiceRecording, resolveVoiceRecordingPath, sha256File, type PersistedVoiceRecording } from './voice-recording.js';
import type { TranscriptionService } from './transcription.js';
import type { OpportunityVoiceFeedback } from '../src/opportunity-types.js';

type Submission = OpportunityVoiceFeedback & { user_id: string; idea_id: string; client_recording_id: string; audio_json: string; payload_hash: string; draft_text: string; base_note: string; base_revision: number | null };
export const appendVoiceFeedback = (note: string, text: string) => note ? `${note}${/\s$/.test(note) ? '' : '\n'}${text}` : text;

/** Acknowledgement means both audio and its card identity are durable. */
export class OpportunityVoiceService {
  private stopped = false;
  private running: Promise<void> | null = null;
  private store: OpportunityStore;
  constructor(private config: AppConfig, private db: AppDatabase, private transcription: Pick<TranscriptionService, 'audioRoot' | 'transcribe'>) {
    this.store = new OpportunityStore(db);
    db.sqlite.prepare("UPDATE opportunity_voice_feedback SET state='queued' WHERE state='processing'").run();
  }
  accept(input: { user: string; ideaId: string; recordingId: string; filePath: string; mimeType: string; draftText: string; baseRevision?: number; maximumBytes: number }) {
    const idea = this.store.idea(input.user, input.ideaId);
    const payload: (string | number)[] = [idea.id, input.draftText, sha256File(input.filePath)];
    if (input.baseRevision !== undefined) payload.push(input.baseRevision);
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const existing = this.db.sqlite.prepare('SELECT * FROM opportunity_voice_feedback WHERE user_id=? AND client_recording_id=?').get(input.user, input.recordingId) as Submission | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) throw new OpportunityError(409, '同一录音 ID 对应了不同内容。');
      return this.store.voiceFeedback(input.user, idea.id).find(v => v.id === existing.id)!;
    }
    if (input.baseRevision !== undefined && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1 || input.baseRevision > idea.revision)) throw new OpportunityError(409, '录音关联的卡片版本无效，请重新读取卡片。');
    const reserved = this.db.sqlite.prepare(`SELECT COALESCE(SUM(json_extract(audio_json,'$.bytes')),0) AS bytes FROM (
      SELECT audio_json FROM opportunity_voice_feedback WHERE user_id=? AND state<>'completed'
      UNION ALL SELECT audio_json FROM voice_submissions WHERE user_id=? AND state IN ('queued','processing','failed'))`).get(input.user, input.user) as { bytes: number };
    if (this.db.sumStoredFileBytesForUser(input.user) + reserved.bytes + fs.statSync(input.filePath).size > input.maximumBytes) throw new OpportunityError(413, '文件存储已达到安全上限。');
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const audio = persistVoiceRecording({ dataRoot: this.config.dataRoot, sourcePath: input.filePath, userId: input.user, transcriptionId: id, mimeType: input.mimeType });
    try {
      this.db.sqlite.prepare(`INSERT INTO opportunity_voice_feedback(id,user_id,idea_id,client_recording_id,payload_hash,audio_json,draft_text,base_note,base_revision,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, input.user, idea.id, input.recordingId, hash, JSON.stringify(audio), input.draftText, idea.note, input.baseRevision ?? null, now, now);
    } catch (error) { removePersistedVoiceRecording(this.config.dataRoot, audio.relativePath); throw error; }
    return this.store.voiceFeedback(input.user, idea.id).find(v => v.id === id)!;
  }
  retry(user: string, ideaId: string, id: string) {
    this.store.idea(user, ideaId);
    const result = this.db.sqlite.prepare("UPDATE opportunity_voice_feedback SET state='queued',error=NULL,updated_at=? WHERE user_id=? AND idea_id=? AND id=? AND state='failed'").run(new Date().toISOString(), user, ideaId, id);
    if (!result.changes) throw new OpportunityError(409, '语音状态已变化，请刷新后重试。');
  }
  stop() { this.stopped = true; }
  async wait() { await this.running; }
  pump(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain() {
    while (!this.stopped) {
      const row = this.db.sqlite.prepare("SELECT * FROM opportunity_voice_feedback WHERE state='queued' ORDER BY created_at,rowid LIMIT 1").get() as Submission | undefined;
      if (!row) return;
      const audio = JSON.parse(row.audio_json) as PersistedVoiceRecording;
      const temporary = path.join(this.transcription.audioRoot, crypto.randomUUID() + path.extname(audio.relativePath));
      this.db.sqlite.prepare("UPDATE opportunity_voice_feedback SET state='processing',error=NULL WHERE id=?").run(row.id);
      try {
        const idea = this.store.idea(row.user_id, row.idea_id);
        let text = row.transcript;
        if (!text) {
          fs.copyFileSync(resolveVoiceRecordingPath(this.config.dataRoot, audio.relativePath), temporary);
          const lexicon = formatVoiceLexiconTerms(this.db.listVoiceLexiconTerms(row.user_id, idea.project_id, this.config.voiceLexiconMaxTerms));
          text = (await this.transcription.transcribe(path.basename(temporary), { purpose: 'composer', draftText: row.draft_text, personalizedTerms: ['Codex Web', ...lexicon.lines] })).trim();
          if (!text) throw new Error('没有识别到清晰语音，请重试。');
          // Retain recognized text even if saving fails (e.g. a long note).
          this.db.sqlite.prepare('UPDATE opportunity_voice_feedback SET transcript=? WHERE id=?').run(text, row.id);
        }
        this.store.transaction(() => {
          const current = this.store.idea(row.user_id, row.idea_id);
          let base = current.note;
          if (row.base_revision !== null) {
            // Uploads can arrive out of order or after an earlier recording has
            // completed. Rebase only automatic appends since recording ended;
            // preserve intervening manual decisions/edits as the current note.
            const additions = this.store.voiceFeedback(row.user_id, row.idea_id)
              .filter(v => v.state === 'completed' && v.applied_revision! > row.base_revision!)
              .sort((a, b) => a.applied_revision! - b.applied_revision!);
            const manualChange = this.db.sqlite.prepare(`SELECT 1 FROM opportunity_feedback
              WHERE user_id=? AND idea_id=? AND actor<>'user-voice'
              AND json_extract(previous_json,'$.revision')>=? LIMIT 1`).get(row.user_id, row.idea_id, row.base_revision);
            if (!manualChange) base = additions.reduce((note, v) => appendVoiceFeedback(note, v.transcript), row.draft_text);
          } else if (current.note === row.base_note) base = row.draft_text;
          const note = appendVoiceFeedback(base, text);
          if (note.length > 6000) throw new Error('识别文字已保留，反馈超过 6000 字；请精简并保存反馈后重试保存语音。');
          const now = new Date().toISOString();
          const previous = { state: current.state, rating: current.rating, note: current.note, manual_processed: current.manual_processed, state_reason: current.state_reason, revision: current.revision };
          this.db.sqlite.prepare('INSERT INTO opportunity_feedback VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), row.user_id, row.idea_id, row.id, 'voice', '', current.rating, text, 'user-voice', JSON.stringify(previous), now);
          this.db.sqlite.prepare('UPDATE opportunity_ideas SET note=?,manual_processed=1,revision=revision+1,updated_at=? WHERE id=?').run(note, now, row.idea_id);
          this.db.sqlite.prepare("UPDATE opportunity_voice_feedback SET state='completed',applied_revision=?,error=NULL,updated_at=? WHERE id=?").run(current.revision + 1, now, row.id);
        });
        removePersistedVoiceRecording(this.config.dataRoot, audio.relativePath);
      } catch (error) {
        this.db.sqlite.prepare("UPDATE opportunity_voice_feedback SET state='failed',error=?,updated_at=? WHERE id=? AND state='processing'").run(error instanceof Error ? error.message.slice(0, 500) : '语音识别失败', new Date().toISOString(), row.id);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
}
