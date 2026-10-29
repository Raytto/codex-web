import { useSyncExternalStore } from 'react';
import { opportunities } from './opportunity-api';
import { deleteVoiceDraft, listVoiceDrafts, saveVoiceDraft, type VoiceDraftRecord } from './conversation/voice-draft-store';

type Upload = {
  id: string;
  accountId: string;
  ideaId: string;
  title: string;
  state: 'uploading' | 'processing' | 'failed' | 'completed';
  error: string;
  storageWarning: string;
  draft?: VoiceDraftRecord;
  submissionId?: string;
  generation: number;
};
const prefix = 'opportunity-upload:';
// Page-owned, independent of any particular card/dialog. Each recording has
// its own immutable card identity and idempotency key, including after reload.
const tasks = new Map<string, Upload>();
const listeners = new Set<() => void>();
let snapshot: Upload[] = [];
let activeAccount: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
const emit = () => { snapshot = [...tasks.values()]; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const changed = () => window.dispatchEvent(new Event('opportunities-updated'));

export function useOpportunityUploads(accountId: string) {
  return useSyncExternalStore(subscribe, () => snapshot).filter(task => task.accountId === accountId);
}

function schedulePoll() {
  if (pollTimer || polling || !activeAccount) return;
  if (!snapshot.some(t => t.accountId === activeAccount && t.state === 'processing')) return;
  pollTimer = setTimeout(() => { pollTimer = undefined; void poll(); }, 1500);
}

async function poll() {
  if (polling) return;
  polling = true;
  const account = activeAccount;
  try {
    const track = (t: Upload) => t.accountId === account && (t.state === 'processing' || (t.state === 'failed' && !!t.submissionId));
    const ids = [...new Set(snapshot.filter(track).map(t => t.ideaId))];
    await Promise.all(ids.map(async ideaId => {
      try {
        const generations = new Map(snapshot.filter(t=>t.ideaId===ideaId).map(t=>[t.id,t.generation]));
        const detail = await opportunities.detail(ideaId);
        if (activeAccount !== account) return;
        for (const task of tasks.values()) {
          if (!track(task) || task.ideaId !== ideaId || task.generation !== generations.get(task.id)) continue;
          const result = detail.voiceFeedback.find(v => v.id === task.submissionId);
          if (!result) continue;
          task.title = detail.idea.content.title;
          task.error = result.error || '';
          task.state = result.state === 'completed' || result.state === 'failed' ? result.state : 'processing';
        }
        emit(); changed();
      } catch {
        // A transient status read never turns an accepted upload into a retry
        // of its audio. The durable server queue continues independently.
      }
    }));
  } finally { polling = false; schedulePoll(); }
}

// Also reconcile retries made from the card's durable server feedback panel.
window.addEventListener('opportunities-updated', () => { void poll(); });

async function upload(task: Upload) {
  if (!task.draft) return;
  if (task.accountId !== activeAccount) {
    task.state = 'failed'; task.error = '请回到录音所属账号重试上传。'; emit(); return;
  }
  task.generation++; task.state = 'uploading'; task.error = ''; emit();
  const draft = task.draft;
  try {
    const { submission } = await opportunities.voiceFeedback(task.ideaId, draft.blob, draft.fileName, draft.id, draft.draftText, draft.opportunityBaseRevision);
    task.submissionId = submission.id;
    task.state = submission.state === 'failed' || submission.state === 'completed' ? submission.state : 'processing';
    task.error = submission.error || '';
    // Delete only after durable server acknowledgement. Retrying the same
    // recording after a lost response is idempotent on the server.
    try { await deleteVoiceDraft(task.id); task.storageWarning = ''; }
    catch { task.storageWarning = '本地录音清理失败；重新上传仍会按录音编号去重。'; }
    task.draft = undefined;
  } catch (error) {
    task.state = 'failed'; task.error = error instanceof Error ? error.message : '语音上传失败，请重试。';
    task.draft = { ...draft, status: 'retryable', retryCount: draft.retryCount + 1, lastError: task.error, updatedAt: new Date().toISOString() };
    try { await saveVoiceDraft(task.draft); }
    catch { task.storageWarning = '录音暂存在当前页面，请重试上传后再刷新或关闭网页。'; }
  }
  emit(); changed(); schedulePoll();
}

export async function queueOpportunityRecording(ideaId: string, title: string, record: VoiceDraftRecord) {
  if (record.accountId !== activeAccount) throw new Error('账号已切换，请回到原账号重试录音。');
  if (tasks.has(record.id)) return;
  const draft = { ...record, scope: prefix + ideaId };
  const task: Upload = { id: draft.id, accountId: draft.accountId, ideaId, title, draft, state: 'uploading', error: '', storageWarning: '', generation: 0 };
  try { await saveVoiceDraft(draft); }
  catch { task.storageWarning = '录音暂存在当前页面，请上传完成后再刷新或关闭网页。'; }
  tasks.set(task.id, task); emit();
  void upload(task);
}

export async function retryOpportunityUpload(id: string) {
  const task = tasks.get(id);
  if (!task || task.accountId !== activeAccount || task.state !== 'failed') return;
  if (!task.submissionId) { await upload(task); return; }
  task.generation++; task.state = 'processing'; task.error = ''; emit();
  try { await opportunities.retryVoice(task.ideaId, task.submissionId); }
  catch (error) { task.state = 'failed'; task.error = error instanceof Error ? error.message : '重试失败，请稍后再试。'; }
  emit(); schedulePoll();
}

export function dismissCompletedUploads(accountId: string) {
  for (const task of tasks.values()) if (task.accountId === accountId && task.state === 'completed') tasks.delete(task.id);
  emit();
}

export function activateOpportunityUploads(accountId: string) {
  activeAccount = accountId;
  let cancelled = false;
  void listVoiceDrafts(accountId).then(drafts => {
    if (cancelled || activeAccount !== accountId) return;
    for (const draft of drafts) {
      if (!draft.scope.startsWith(prefix) || tasks.has(draft.id)) continue;
      const task: Upload = { id: draft.id, accountId, ideaId: draft.scope.slice(prefix.length), title: '待恢复的卡片语音', draft, state: 'failed', error: draft.lastError, storageWarning: '', generation: 0 };
      tasks.set(task.id, task);
      // Restored uploads wait for an explicit retry, including after logout.
    }
    emit(); schedulePoll();
  }).catch(() => { /* Recorder shows storage failures when used. */ });
  schedulePoll();
  return () => { cancelled = true; if (activeAccount === accountId) activeAccount = null; };
}
