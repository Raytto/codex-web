import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExtensionGroup } from './extensions-sidebar';
import { BookOpen, Sparkles, X } from 'lucide-react';
import { request } from './api';
import {conversationLocation} from './conversation-location';
import './dot.css';
type Task = {
    id: string;
    title: string;
    state: string;
    revision: number;
    conversation_id: string;
    project_id: string;
    executor_id: string;
    result: string;
    review_state: string;
    review_summary: string;
};
type Memory = {
    id: string;
    content: string;
    source_id: string;
    state: string;
    revision: number;
};
type State = {
    projection?: {
        ok: boolean;
        message?: string;
    };
    session?: {
        conversation_id: string;
    };
    tasks: Task[];
    memories: Memory[];
    projects: {
        id: string;
        name: string;
        executorId: string;
    }[];
};
const post = <T,>(url: string, body: unknown = {}) => request<T>(url, { method: 'POST', body: JSON.stringify(body) });
export function DotEntry({ onOpen, onError }: {
    onOpen: (project: string, id: string) => void;
    onError: (s: string) => void;
}) { return <ExtensionGroup id="dot" label="PP Dot" icon={<Sparkles size={17}/>} onOpen={() => { void post<{conversation:{id:string;project_id:string}}>('/dot/open').then(r => onOpen(r.conversation.project_id, r.conversation.id)).catch(e => onError(e.message)); }} />; }

type DotControls = { openLedger: () => void };
const DotContext = createContext<DotControls | null>(null);
export function DotLedgerMenuItem({onSelect}:{onSelect:()=>void}) {
    const dot=useContext(DotContext);if(!dot)return null;
    return <button role="menuitem" onClick={e=>{const summary=e.currentTarget.closest('details')?.querySelector('summary');onSelect();summary?.focus();dot.openLedger();}}><BookOpen size={17}/><span>任务与记忆</span></button>;
}
function DotDialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
    const ref=useRef<HTMLDialogElement>(null);
    useEffect(()=>{const dialog=ref.current!,opener=document.activeElement as HTMLElement|null;dialog.showModal();return()=>{dialog.close();opener?.focus();};},[]);
    return createPortal(<dialog ref={ref} className="dot-dialog ui-dialog" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget){const b=e.currentTarget.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)onClose();}}}><header><h2 className="dialog-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label={`关闭${title}`} autoFocus><X size={20}/></button></header><div className="dot-dialog-body">{children}</div></dialog>,document.body);
}
export function DotProvider({ conversationId, enabled, children }: {
    conversationId: string | null;
    enabled: boolean;
    children: ReactNode;
}) {
    const [data,setData]=useState<State|null>(null),[error,setError]=useState(''),[expanded,setExpanded]=useState(false),[busy,setBusy]=useState(false),[memorySources,setMemorySources]=useState<Record<string,string>>({});
    const refresh=()=>request<State>('/dot').then(setData).catch(e=>setError(e.message));
    useEffect(()=>{setExpanded(false);setData(null);if(!enabled||!conversationId)return;let disposed=false;const update=()=>request<State>('/dot').then(r=>{if(!disposed)setData(r);}).catch(()=>{});void update();const timer=setInterval(()=>void update(),5000);return()=>{disposed=true;clearInterval(timer);};},[enabled,conversationId]);
    async function cancel(task: Task) { setBusy(true); try {
        await post('/dot/action', { action: 'task_cancel', id: task.id, data: { requestKey: crypto.randomUUID(), revision: task.revision } });
        await refresh();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    const isDot=enabled && Boolean(conversationId) && data?.session?.conversation_id===conversationId;
    return <DotContext.Provider value={isDot?{openLedger:()=>setExpanded(true)}:null}>
      {children}
      {isDot && expanded && data && <DotDialog title="任务与记忆" onClose={()=>setExpanded(false)}><div className="dot-ledger">{error&&<p role="alert">{error}</p>}<h3>任务台账</h3>{data.projection && !data.projection.ok && <p role="alert">文件投影需处理：{data.projection.message}</p>}{!data.tasks.length && <p>还没有派发任务。直接告诉 PP Dot 要做什么、在哪个项目或节点执行。</p>}{data.tasks.map(t => <article key={t.id}><a className="dot-task-link" href={conversationLocation(location.href,t.conversation_id)} target="_blank" rel="noopener noreferrer" title="在新标签页查看任务，保持当前通话">{t.title}</a><span>{(t.state==='completed' ? ({completed:'已核对完成',waiting_user:'等待补充',failed:'核对未通过'} as Record<string,string>)[t.review_state]??'回合结束 · 待核对' : ({ queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancel_requested: '正在停止', cancelled: '已取消', interrupted: '已中断' } as Record<string, string>)[t.state] ?? t.state)} · {data.projects.find(p => p.id === t.project_id)?.name ?? t.project_id} · {t.executor_id}</span>{!['completed', 'failed', 'cancelled'].includes(t.state) && <button disabled={busy} onClick={() => void cancel(t)}>停止任务</button>}</article>)}<h3>记忆</h3><p>说“记住……”“把这条改为……”或“忘记……”，总管会带来源更新。忘记记忆不删除原始聊天。</p>{data.memories.map(m => <article key={m.id}><p>{m.content}</p><small>{m.state === 'confirmed' ? '已确认' : '待确认'} · 第 {m.revision} 版 · 来源 {m.source_id}</small><button onClick={()=>void post<{events:{content:string}[]}>('/dot/action',{action:'search',data:{sourceId:m.source_id}}).then(r=>setMemorySources(old=>({...old,[m.id]:r.events.map(e=>e.content).join('\n')||'原始来源尚未同步，请稍后重试。'}))).catch(e=>setError(e.message))}>查看来源</button>{memorySources[m.id]&&<p>{memorySources[m.id]}</p>}</article>)}</div></DotDialog>}
    </DotContext.Provider>;
}
