import { useCallback, useEffect, useId, useState } from "react";
import { CalendarClock, ChevronDown, Menu, Pause, Play, Plus, RefreshCw, Repeat2, Trash2 } from "lucide-react";
import { api, type AgentOptions, type Project } from "./api";
import type { Recurrence, RecurringInput, RecurringRun, RecurringTask } from "./recurring-types";
import { SettingMenu, type SettingMenuOption } from "./conversation/SettingMenu";
import "./recurring-tasks.css";
import { recurrenceLabel } from "./recurring-labels";

export const recurringState = (s: RecurringTask["state"]) => ({ active: "已启用", paused: "已暂停", completed: "已完成" })[s];
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
const dateText = (value: string | null, zone?: string) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: zone, dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date(value)) : "—";

export function RecurringSidebar({ tasks, selected, onOpen }: { tasks: RecurringTask[]; selected: string | null; onOpen: (id: string | null) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!tasks.length) return null;
  return <div className="recurring-sidebar"><button className="recurring-group" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Repeat2 size={15} /><span>周期任务（{tasks.length}）</span><ChevronDown size={14} style={{ transform: expanded ? undefined : "rotate(-90deg)" }} /></button>{expanded && <div className="recurring-children">{tasks.map(t => <button key={t.id} className={selected === t.id ? "selected" : ""} onClick={() => onOpen(t.id)} title={`${t.name} · ${recurringState(t.state)}`}><CalendarClock size={14} /><span>{t.name}</span>{t.state !== "active" && <Pause size={12} aria-label={recurringState(t.state)} />}</button>)}<button className="recurring-manage" onClick={() => onOpen(null)}>管理定时任务</button></div>}</div>;
}

export function RecurringWorkspace({ project, tasks, taskId, loading, loadError, onOpen, onChanged, onMenu, onConversation, onDirty, onReturnOpportunity, onOpportunity }: { onReturnOpportunity?: () => void; onOpportunity?: (id: string) => void; project: Project; tasks: RecurringTask[]; taskId: string | null; loading: boolean; loadError: string; onOpen: (id: string | null) => void; onChanged: () => Promise<void>; onMenu: () => void; onConversation: (id: string) => void; onDirty: (dirty: boolean) => void }) {
  const [error, setError] = useState("");
  const [waits, setWaits] = useState<Array<{ id: string; label: string; deadline_at: string; conversation_id: string }>>([]);
  useEffect(() => { let disposed = false; api.projectScheduledWaits(project.id).then(r => { if (!disposed) setWaits(r.waits); }).catch(e => { if (!disposed) setError(e.message); }); return () => { disposed = true; }; }, [project.id, taskId]);
  return <main className="workspace recurring-workspace ui-dialog">
    <header className="workspace-header"><div className="recurring-heading"><button className="icon-button mobile-only" onClick={onMenu} aria-label="打开侧栏"><Menu size={20} /></button><CalendarClock size={22} /><div><h1>定时任务</h1><p>{project.display_name || project.name}</p></div></div><button type="button" onClick={() => onOpen("new")}><Plus size={17} />新建周期任务</button></header>
    <div className="recurring-content">{onReturnOpportunity && <button onClick={onReturnOpportunity}>返回机会卡片</button>}{taskId ? <RecurringEditor onOpportunity={onOpportunity} key={`${project.id}:${taskId}`} project={project} taskId={taskId} onSaved={async id => { await onChanged(); onOpen(id); }} onBack={() => onOpen(null)} onConversation={onConversation} onDirty={onDirty} /> : <>
      <div className="recurring-section-title"><div><h2>周期任务</h2><p>到点在此项目中新建会话，按保存的指令独立执行。</p></div><button onClick={() => void onChanged().catch(e => setError(e.message))} aria-label="刷新定时任务"><RefreshCw size={17} /></button></div>
      {loading && <p role="status">正在加载定时任务…</p>}{loadError && <p role="alert" className="recurring-error">{loadError}，请点击刷新重试。</p>}
      {!loading && !loadError && !tasks.length && <div className="recurring-empty"><Repeat2 size={32} /><h3>让重复的工作按时开始</h3><p>设置指令、模型和日程，后续执行由服务器安排。</p><button className="primary-button" onClick={() => onOpen("new")}><Plus size={17} />创建第一个周期任务</button></div>}
      <div className="recurring-list">{tasks.map(t => <button className="recurring-card" key={t.id} onClick={() => onOpen(t.id)}><span className="recurring-card-title"><Repeat2 size={18} /><strong>{t.name}</strong><span className={`recurring-status ${t.state}`}>{recurringState(t.state)}</span></span><span>{recurrenceLabel(t.schedule)} · {t.schedule.timeZone}</span><small>下次：{dateText(t.nextRunAt, t.schedule.timeZone)} · 已执行 {t.runCount}{t.maxRuns === null ? " 次" : ` / ${t.maxRuns} 次`}</small></button>)}</div>
      <section className="recurring-waits"><h2>会话内的延时任务</h2><p>在会话菜单的“安排自动续跑”中创建，可继续当前会话或新建会话。</p>{waits.length ? waits.map(w => <button key={w.id} onClick={() => onConversation(w.conversation_id)}><CalendarClock size={16} /><span>{w.label}</span><time>{dateText(w.deadline_at)}</time></button>) : <p>此项目暂无等待中的延时任务。</p>}</section>
      {error && <p role="alert" className="recurring-error">{error}</p>}
    </>}</div>
  </main>;
}

function RecurringSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: SettingMenuOption[]; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <div className="recurring-field"><span>{label}</span><SettingMenu menuId={id} className="recurring-select" panelClassName="recurring-select-panel ui-dialog"
    label="" ariaLabel={label} value={value} options={options} placeholder="请选择" title={label} floating
    disabled={disabled} open={open} onOpenChange={setOpen} onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onChange={onChange} /></div>;
}

function RecurringEditor({ project, taskId, onSaved, onBack, onConversation, onDirty, onOpportunity }: { onOpportunity?: (id: string) => void; project: Project; taskId: string; onSaved: (id: string | null) => Promise<void>; onBack: () => void; onConversation: (id: string) => void; onDirty: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<RecurringTask | null>(null);
  const [runs, setRuns] = useState<RecurringRun[]>([]);
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [form, setForm] = useState<RecurringInput>({ name: "", prompt: "", model: "", reasoningEffort: "", maxRuns: null, schedule: { kind: "daily", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai", time: "09:00", intervalMinutes: 60, weekdays: [1,2,3,4,5], monthDay: 1 } });
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const dirty = baseline !== "" && JSON.stringify(form) !== baseline;
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { if (!dirty) return; const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler); }, [dirty]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [catalog, detail] = await Promise.all([api.agentOptions({ projectId: project.id }), taskId === "new" ? Promise.resolve(null) : api.recurringTask(taskId)]);
      setOptions(catalog); setSaved(detail?.task ?? null); setRuns(detail?.runs ?? []);
      setForm(previous => { const next = detail ? { name: detail.task.name, prompt: detail.task.prompt, model: detail.task.model, reasoningEffort: detail.task.reasoningEffort, maxRuns: detail.task.maxRuns, schedule: detail.task.schedule } : { ...previous, ...catalog.selection }; setBaseline(JSON.stringify(next)); return next; });
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); } finally { setLoading(false); }
  }, [project.id, taskId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (taskId === "new" || dirty || busy || loading) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void api.recurringTask(taskId).then(detail => {
        if (disposed) return;
        setRuns(detail.runs);
        if (detail.task.revision !== saved?.revision) {
          const t = detail.task, next = { name: t.name, prompt: t.prompt, model: t.model, reasoningEffort: t.reasoningEffort, maxRuns: t.maxRuns, schedule: t.schedule };
          setSaved(t); setForm(next); setBaseline(JSON.stringify(next));
        }
      }).catch(e => { if (!disposed) setError(e.message); });
    }, 10000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [taskId, dirty, busy, loading, saved?.revision]);
  const field = <K extends keyof RecurringInput>(key: K, value: RecurringInput[K]) => setForm(f => ({ ...f, [key]: value }));
  const scheduleField = <K extends keyof Recurrence>(key: K, value: Recurrence[K]) => setForm(f => ({ ...f, schedule: { ...f.schedule, [key]: value } }));
  async function save(state?: "active" | "paused") {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = saved ? await api.updateRecurringTask(saved.id, { ...form, revision: saved.revision, state: state ?? (saved.state === "paused" ? "paused" : "active") }) : await api.createRecurringTask(project.id, form);
      setSaved(result.task); setBaseline(JSON.stringify(form)); onDirty(false); setNotice("已保存"); await onSaved(result.task.id);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  async function toggleState() {
    if (!saved || (dirty && !window.confirm("任务设置尚未保存。继续切换启用状态，并放弃这些修改？"))) return;
    setBusy(true); setError("");
    try { const result = await api.setRecurringState(saved.id, saved.revision, saved.state === "active" ? "paused" : "active"); setSaved(result.task); onDirty(false); await load(); await onSaved(result.task.id); }
    catch (e) { setError(e instanceof Error ? e.message : "更新状态失败"); } finally { setBusy(false); }
  }
  async function remove() {
    if (!saved || !window.confirm(`删除“${saved.name}”？未来的执行会停止，已创建的会话会保留。`)) return;
    setBusy(true); setError("");
    try { await api.deleteRecurringTask(saved.id, saved.revision); onDirty(false); await onSaved(null); } catch (e) { setError(e instanceof Error ? e.message : "删除失败"); } finally { setBusy(false); }
  }
  const efforts = options?.models.find(m => m.id === form.model)?.reasoningEfforts ?? [];
  const disabled = busy || !options;
  const models = options?.models.map(m => ({ id: m.id, label: m.label, description: m.description })) ?? [];
  if (form.model && !models.some(m => m.id === form.model)) models.unshift({ id: form.model, label: `${form.model}（当前不可用）`, description: "请选择可用模型" });
  const effortOptions = efforts.map(e => ({ id: e, label: options?.reasoningEfforts.find(v => v.id === e)?.label ?? e }));
  if (!efforts.includes(form.reasoningEffort)) effortOptions.unshift({ id: form.reasoningEffort, label: `${form.reasoningEffort || "未选择"}（当前不可用）` });
  function retry() {
    if (!dirty || window.confirm("放弃尚未保存的修改并读取最新设置？")) void load();
  }
  return <div className="recurring-editor">
    <button className="recurring-back" onClick={onBack}>← 全部定时任务</button>
    {saved?.opportunityTopic && (onOpportunity ? <button onClick={() => onOpportunity(saved.opportunityTopic!.id)}>关联主题：{saved.opportunityTopic.name}</button> : <p>关联机会主题：{saved.opportunityTopic.name}。可在个人设置的功能选择中开启机会卡片入口；计划启停仍由本页管理。</p>)}
    <div className="recurring-section-title recurring-editor-title"><div><h2>{saved ? saved.name : "新建周期任务"}</h2><p>设置好任务内容和日程，让重复的工作按时开始。</p></div>{saved && <span className={`recurring-status ${saved.state}`}>{recurringState(saved.state)}</span>}</div>
    {loading ? <p role="status">正在加载任务设置…</p> : <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset disabled={disabled}>
        <section className="recurring-form-section" aria-labelledby="recurring-content-title">
          <div className="recurring-section-copy"><h3 id="recurring-content-title">任务内容</h3><p>每次执行都会使用这里保存的指令、模型和思考深度。</p></div>
          <label>任务名称<input aria-label="任务名称" required maxLength={120} value={form.name} onChange={e => field("name", e.target.value)} placeholder="例如：每日项目进展" /></label>
          <label>任务指令<textarea aria-label="任务指令" required maxLength={20000} rows={8} value={form.prompt} onChange={e => field("prompt", e.target.value)} placeholder="每次执行需要完成什么？写清目标、资料位置和交付方式。" /></label>
          <div className="recurring-grid">
            <RecurringSelect label="模型" value={form.model} options={models} disabled={disabled} onChange={value => { const m = options?.models.find(m => m.id === value); setForm(f => ({ ...f, model: value, reasoningEffort: m?.reasoningEfforts.includes(f.reasoningEffort) ? f.reasoningEffort : m?.reasoningEfforts[0] ?? "" })); }} />
            <RecurringSelect label="思考深度" value={form.reasoningEffort} options={effortOptions} disabled={disabled} onChange={value => field("reasoningEffort", value)} />
          </div>
        </section>
        <section className="recurring-form-section" aria-labelledby="recurring-schedule-title">
          <div className="recurring-section-copy"><h3 id="recurring-schedule-title">重复安排</h3><p>按所选时区执行，每次到点都会新建会话。</p></div>
          <div className="recurring-grid">
            <RecurringSelect label="重复方式" value={form.schedule.kind} options={[{ id: "daily", label: "每天" }, { id: "weekly", label: "每周" }, { id: "monthly", label: "每月" }, { id: "interval", label: "固定间隔" }]} disabled={disabled} onChange={value => scheduleField("kind", value as Recurrence["kind"])} />
            <label>时区<input aria-label="时区" value={form.schedule.timeZone} onChange={e => scheduleField("timeZone", e.target.value)} placeholder="Asia/Shanghai" required /></label>
            {form.schedule.kind === "interval" ? <label>间隔（分钟）<input aria-label="间隔（分钟）" type="number" min={1} max={525600} required value={form.schedule.intervalMinutes} onChange={e => scheduleField("intervalMinutes", Number(e.target.value))} /></label> : <label>执行时间<input aria-label="执行时间" type="time" required value={form.schedule.time} onChange={e => scheduleField("time", e.target.value)} /></label>}
            {form.schedule.kind === "monthly" && <label>每月几号<input aria-label="每月几号" type="number" min={1} max={31} required value={form.schedule.monthDay} onChange={e => scheduleField("monthDay", Number(e.target.value))} /><small>没有该日期的月份会跳过。</small></label>}
            <div className="recurring-field"><RecurringSelect label="重复次数" value={form.maxRuns === null ? "unlimited" : "limited"} options={[{ id: "unlimited", label: "不限次数" }, { id: "limited", label: "指定总次数" }]} disabled={disabled} onChange={value => field("maxRuns", value === "unlimited" ? null : Math.max(1, (saved?.runCount ?? 0) + 10))} />{form.maxRuns !== null && <input aria-label="总执行次数" type="number" min={1} max={100000} required value={form.maxRuns} onChange={e => field("maxRuns", Number(e.target.value))} />}</div>
          </div>
          {form.schedule.kind === "weekly" && <div className="recurring-weekdays" role="group" aria-label="每周执行日期">{[1,2,3,4,5,6,0].map(d => <label key={d}><input type="checkbox" checked={form.schedule.weekdays.includes(d)} onChange={e => scheduleField("weekdays", e.target.checked ? [...form.schedule.weekdays,d].sort() : form.schedule.weekdays.filter(v => v !== d))} />周{weekdays[d]}</label>)}</div>}
          <details className="recurring-policy"><summary>执行规则</summary><p>上一轮仍在运行或等待时跳过本次；服务恢复后只补一次，不堆积历史轮次。停止某次会话不影响以后的日程。暂停或删除周期任务只停止未来触发。</p></details>
        </section>
        <div className="recurring-form-footer">
        {saved && <div className="recurring-summary"><span>下次执行<strong>{dateText(saved.nextRunAt, saved.schedule.timeZone)}</strong></span><span>已执行<strong>{saved.runCount}{saved.maxRuns === null ? " 次" : ` / ${saved.maxRuns} 次`}</strong></span></div>}
        <div className="recurring-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? "保存中…" : saved ? "保存更改" : "创建周期任务"}</button>{saved && <><button type="button" onClick={() => void toggleState()}>{saved.state === "active" ? <Pause size={16} /> : <Play size={16} />}{saved.state === "active" ? "暂停任务" : "启用任务"}</button><button type="button" className="danger" onClick={() => void remove()}><Trash2 size={16} />删除</button></>}{dirty && <span className="recurring-save-status">有未保存的更改</span>}</div>
        </div>
      </fieldset>
    </form>}
    {error && <div role="alert" className="recurring-error"><span>{error}</span><button type="button" disabled={busy || loading} onClick={retry}>读取最新设置</button></div>}{notice && <p role="status">{notice}</p>}
    {saved && <section className="recurring-history"><div className="recurring-section-copy"><h3>最近执行记录</h3><p>查看每一轮的执行状态和会话。</p></div>{!runs.length ? <p className="recurring-history-empty">还没有执行记录。到达日程时间后，记录会显示在这里。</p> : runs.map(r => <div className="recurring-history-row" key={r.id}><time>{dateText(r.scheduled_at, saved.schedule.timeZone)}</time><span>{({ skipped: "已跳过", queued: "排队中", running: "执行中", completed: "已完成", succeeded: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断", deleted: "会话已删除" } as Record<string,string>)[r.status] ?? r.status}</span>{r.conversation_id && r.status !== "deleted" ? <button onClick={() => onConversation(r.conversation_id!)}>查看会话</button> : <small>{r.reason}</small>}</div>)}</section>}
  </div>;
}
