import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Archive, GripVertical, Lightbulb, LoaderCircle, MoreHorizontal, Pencil, Plus, RotateCcw } from 'lucide-react';
import { opportunities } from './opportunity-api';
import { OpportunityDialog } from './opportunity-dialog';
import type { OpportunityTopic, OpportunityTopicSummary } from './opportunity-types';

type Placement = 'before' | 'after';
type TopicAction = { topic: OpportunityTopic; mode: 'rename' | 'archive' | 'restore' };
function TopicActionDialog({ action, onClose, onSaved }: { action: TopicAction; onClose: () => void; onSaved: () => void }) {
  const { topic, mode } = action;
  const [name, setName] = useState(topic.name), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const label = mode === 'rename' ? '改名主题' : mode === 'archive' ? '归档主题' : '恢复主题';
  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (mode === 'rename') await opportunities.rename(topic, name.trim());
      else await opportunities.lifecycle(topic, mode);
      onSaved(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <OpportunityDialog title={label} onClose={onClose} closeDisabled={busy}>
    <form className="opportunity-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      {mode === 'rename' ? <label>主题名称<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
        : <><p>确定{label.slice(0, 2)}“{topic.name}”？</p><p className="dialog-description">{mode === 'archive' ? '归档后可随时恢复。关联的自动发现计划会暂停，已创建的会话继续保留。' : '恢复后，主题会重新出现在侧栏。自动发现计划保持暂停，可在主题中重新启用。'}</p></>}
      {error && <p role="alert" className="opportunity-error">{error}</p>}
      <div className="opportunity-actions"><button type="submit" className="opportunity-primary" disabled={busy || (mode === 'rename' && !name.trim())}>{busy ? '正在保存…' : mode === 'rename' ? '保存名称' : label}</button><button type="button" disabled={busy} onClick={onClose}>取消</button></div>
    </form>
  </OpportunityDialog>;
}

export function OpportunitySidebar({ selected, query, onOpen, onCreate }: {
  selected: string | null;
  query: string;
  onOpen: (topicId: string) => void;
  onCreate: () => void;
}) {
  const [topics, setTopics] = useState<OpportunityTopicSummary[]>([]);
  const [loading, setLoading] = useState(true), [moving, setMoving] = useState(false);
  const [error, setError] = useState(''), [actionError, setActionError] = useState('');
  const [archives, setArchives] = useState(false);
  const [action, setAction] = useState<TopicAction | null>(null);
  const [menu, setMenu] = useState<{ id: string; top: number; left: number; anchorTop: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<{ id: string; placement: Placement } | null>(null);
  const generation = useRef(0), busy = useRef(false);
  const drag = useRef<{ source: string; x: number; y: number; pointer: number; target?: string; placement?: Placement } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const search = query.trim().toLocaleLowerCase();
  const shown = topics.filter(t => (archives || !t.archived_at) && t.name.toLocaleLowerCase().includes(search));
  const sortable = !search && !moving;
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await opportunities.topics();
      if (current !== generation.current) return;
      setTopics(result.topics); setError('');
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : '读取主题失败');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const changed = () => { void refresh(); };
    changed();
    const timer = window.setInterval(() => { if (!document.hidden && !busy.current && !drag.current) changed(); }, 30000);
    window.addEventListener('opportunities-updated', changed);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('opportunities-updated', changed); };
  }, [refresh]);
  const cancelDrag = useCallback(() => { drag.current = null; setDragging(null); setDrop(null); }, []);
  useEffect(() => { setMenu(null); cancelDrag(); }, [selected, search, archives, cancelDrag]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelDrag(); };
    window.addEventListener('blur', cancelDrag); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('blur', cancelDrag); window.removeEventListener('keydown', escape); };
  }, [cancelDrag]);
  async function move(source: string, target: string, placement: Placement) {
    if (!sortable || busy.current || source === target) return;
    busy.current = true; setMoving(true); setActionError('');
    try {
      const result = await opportunities.reorder(source, target, placement);
      generation.current++; setTopics(result.topics);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : '调整顺序失败，请重试。'); }
    finally { busy.current = false; setMoving(false); }
  }
  function movePointer(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) { delete current.target; setDrop(null); return; }
    setDragging(current.source);
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-opportunity-topic]');
    if (row?.dataset.sortable === 'true' && row.dataset.opportunityTopic !== current.source) {
      const rect = row.getBoundingClientRect(), placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      current.target = row.dataset.opportunityTopic; current.placement = placement;
      setDrop({ id: current.target!, placement });
    } else { delete current.target; setDrop(null); }
    const scroll = event.currentTarget.closest<HTMLElement>('.sidebar-content');
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 35) scroll.scrollTop -= 14;
      if (event.clientY > rect.bottom - 35) scroll.scrollTop += 14;
    }
  }
  function endPointer(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    cancelDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.target && current.placement) void move(current.source, current.target, current.placement);
  }
  function openMenu(topic: OpportunityTopic, button: HTMLButtonElement) {
    const anchor = button.getBoundingClientRect(); trigger.current = button;
    setMenu(menu?.id === topic.id ? null : { id: topic.id, top: Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - 112)), left: Math.max(8, Math.min(anchor.right - 176, window.innerWidth - 184)), anchorTop: anchor.top });
  }
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenu(null); trigger.current?.focus(); }
      if (event.key === 'Tab') setMenu(null);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    const moved = (event: Event) => { const anchor = trigger.current?.getBoundingClientRect(); if (event.type === 'resize' || !anchor || Math.abs(anchor.top - menu.anchorTop) > 1) setMenu(null); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key); window.addEventListener('resize', moved); window.addEventListener('scroll', moved, true);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('resize', moved); window.removeEventListener('scroll', moved, true); };
  }, [menu]);
  const menuTopic = shown.find(t => t.id === menu?.id);
  function showAction(topic: OpportunityTopic, mode: TopicAction['mode']) { trigger.current?.focus(); setMenu(null); setAction({ topic, mode }); }
  return <section className="para-sidebar opportunity-sidebar" aria-label="机会卡片主题">
    <div className="section-label project-label"><span>机会卡片</span><button type="button" onClick={onCreate} aria-label="新建机会主题" title="新建机会主题"><Plus size={15} /></button></div>
    {loading && <div className="list-loading" role="status"><LoaderCircle size={14} className="spin" /><span>正在读取主题…</span></div>}
    {shown.map(topic => <div key={topic.id} className={`project-row opportunity-topic-row ${selected === topic.id ? 'active' : ''} ${menu?.id === topic.id ? 'menu-open' : ''} ${dragging === topic.id ? 'dragging' : ''} ${drop?.id === topic.id ? `drop-${drop.placement}` : ''}`} data-opportunity-topic={topic.id} data-sortable={sortable && !topic.archived_at}>
      <button type="button" className="touch-drag-handle opportunity-topic-grip" disabled={!sortable || Boolean(topic.archived_at)} aria-label={`拖动主题 ${topic.name}`} title={search ? '清空搜索后可拖动排序' : '拖动排序，也可用上下方向键调整'}
        onPointerDown={event => {
          if (!sortable || topic.archived_at || event.button !== 0 || !event.isPrimary) return;
          event.preventDefault(); event.stopPropagation(); setMenu(null); event.currentTarget.focus();
          drag.current = { source: topic.id, x: event.clientX, y: event.clientY, pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault(); const active = shown.filter(t => !t.archived_at), index = active.findIndex(t => t.id === topic.id);
          const target = active[index + (event.key === 'ArrowUp' ? -1 : 1)];
          if (target) void move(topic.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after');
        }}><GripVertical size={12} /></button>
      <button type="button" className="project-select" aria-current={selected === topic.id ? 'page' : undefined} title={`${topic.name}（${topic.pending_count}）· 待审批卡片`} aria-label={`${topic.name}，${topic.pending_count} 张待审批卡片${topic.archived_at ? '，已归档' : ''}`} onClick={() => onOpen(topic.id)}>
        <Lightbulb size={16} /><span className="opportunity-topic-name">{topic.name}</span><span className="opportunity-topic-count" aria-hidden="true">（{topic.pending_count}）</span>{topic.archived_at && <Archive size={13} aria-label="已归档" />}
      </button>
      <div className="project-actions opportunity-topic-actions"><button type="button" aria-label={`主题 ${topic.name} 操作`} aria-haspopup="menu" aria-expanded={menu?.id === topic.id} title="主题操作" onClick={event => openMenu(topic, event.currentTarget)}><MoreHorizontal size={15} /></button></div>
    </div>)}
    {(error || actionError) && <div className="opportunity-sidebar-error" role="alert"><span>{actionError || error}</span><button type="button" onClick={() => { setActionError(''); void refresh(); }}>重试读取主题</button></div>}
    {!loading && !error && !shown.length && (search ? <div className="project-empty">没有匹配的机会主题</div> : <button className="para-sidebar-empty" onClick={onCreate}>新建第一个主题</button>)}
    <button className="para-sidebar-empty" aria-current={selected === '' ? 'page' : undefined} onClick={() => onOpen('')}>查看全部主题</button>
    {topics.some(t => t.archived_at) && <button className="para-sidebar-empty" aria-pressed={archives} onClick={() => setArchives(!archives)}>{archives ? '隐藏归档主题' : '查看归档主题'}</button>}
    {menu && menuTopic && createPortal(<div ref={menuRef} className="project-menu-panel opportunity-topic-menu" role="menu" aria-label="主题操作" style={{ top: menu.top, left: menu.left }}>
      <button type="button" role="menuitem" onClick={() => showAction(menuTopic, 'rename')}><Pencil size={16} /><span>改名</span></button>
      <button type="button" role="menuitem" className={menuTopic.archived_at ? '' : 'danger'} onClick={() => showAction(menuTopic, menuTopic.archived_at ? 'restore' : 'archive')}>{menuTopic.archived_at ? <RotateCcw size={16} /> : <Archive size={16} />}<span>{menuTopic.archived_at ? '恢复主题' : '归档主题'}</span></button>
    </div>, document.body)}
    {action && <TopicActionDialog action={action} onClose={() => setAction(null)} onSaved={() => void refresh()} />}
  </section>;
}
