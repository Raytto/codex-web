import { LoaderCircle, CheckCircle2 } from 'lucide-react';
import { dismissCompletedUploads, retryOpportunityUpload, useOpportunityUploads } from './opportunity-voice-uploads';

export function OpportunityUploadStatus({ accountId, ideaId, onOpen }: { accountId: string; ideaId?: string; onOpen?: (id: string) => void }) {
  const all = useOpportunityUploads(accountId);
  const uploads = all.filter(t => !ideaId || t.ideaId === ideaId);
  if (!uploads.length) return null;
  return <section className="opportunity-upload-status" aria-label="语音上传队列">
    <h3>语音反馈</h3>
    <p className="dialog-description">可收起详情、保留或淘汰卡片，也可继续录音；语音会分别保存到原卡片。</p>
    <ul>{uploads.map(task => <li key={task.id} data-upload-id={task.id}>
      <div role="status">
        {['uploading', 'processing'].includes(task.state) ? <LoaderCircle size={17} className="spin" /> : task.state === 'completed' ? <CheckCircle2 size={17} /> : null}
        <span>{task.title} · {{ uploading: '正在上传', processing: '正在识别并保存', failed: task.submissionId ? '识别或保存失败' : '上传失败，录音已保留', completed: '反馈已保存' }[task.state]}</span>
      </div>
      {task.error && <p role="alert">{task.error}</p>}
      {task.storageWarning && <p role="alert">{task.storageWarning}</p>}
      <div className="opportunity-actions">
        {task.state === 'failed' && <button onClick={() => void retryOpportunityUpload(task.id)}>{task.submissionId ? '重试识别或保存' : '重试上传'}</button>}
        {onOpen && <button onClick={() => onOpen(task.ideaId)}>查看卡片</button>}
      </div>
    </li>)}</ul>
    {uploads.some(t => t.state === 'completed') && <button onClick={() => dismissCompletedUploads(accountId)}>收起已完成的语音</button>}
  </section>;
}
