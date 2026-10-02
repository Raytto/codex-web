import { useRef, useState } from "react";
import type { KanbanSummary, ParaProject, ParaStage } from "../server/para-types";
import { para } from "./para-api";
import { PARA_STAGES } from "./para-stage-menu";

export const FLOW = ["idea", "incubating", "active", "review", "done"] as const;
export type LifecycleAction = ParaStage | "pause" | "wait" | "recap";
export const actionTitle = (action: LifecycleAction) => ({ idea: "放回想法池", incubating: "准备项目", active: "开始推进", review: "提交验收", done: "确认完成", stopped: "终止项目", pause: "暂停项目", wait: "记录等待", recap: "回顾项目" })[action];
export const needsWeeklyReview = (p: ParaProject) => Date.now() - new Date(p.reviewed_at || p.created_at).getTime() >= 7 * 86400000;
const date = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
export function projectAttention(p: ParaProject) {
  if (p.stage === "stopped") return "已终止";
  if (p.stage === "done") return "已完成";
  if (p.waiting_for) return `等待：${p.waiting_for}`;
  if (p.paused) return `暂停：${p.hold_reason || "暂不推进"}`;
  if (p.stage === "review") return "待我验收";
  if (p.review_on && p.review_on <= date()) return "到期回顾";
  if (needsWeeklyReview(p)) return "一周未回顾";
  if (p.stage === "incubating" && p.ready) return "已准备好";
  return PARA_STAGES[p.stage];
}

export function LifecycleForm({ project, action, summary, onSaved, onClose, onBusyChange, position }: {
  project: ParaProject; action: LifecycleAction; summary: KanbanSummary | null; position?: number;
  onSaved: (project: ParaProject) => void; onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [brief, setBrief] = useState(project.brief);
  const [reason, setReason] = useState(action === "wait" ? project.waiting_for : action === "pause" ? project.hold_reason : "");
  const [reviewOn, setReviewOn] = useState(action === "recap" && project.review_on && project.review_on <= date() ? "" : project.review_on || "");
  const [acceptance, setAcceptance] = useState(project.acceptance);
  const [outcome, setOutcome] = useState("");
  const [effort, setEffort] = useState(project.effort);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const revision = useRef(project.revision), lock = useRef(false);
  const [latest, setLatest] = useState<ParaProject | null>(null);
  const enterWip = ["active", "review"].includes(action) && !["active", "review"].includes(project.stage);
  const atLimit = enterWip && summary && summary.counts.wip >= summary.preferences.wip_limit;
  return <form onSubmit={async e => {
    e.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError("");
    try {
      const change: Record<string, unknown> = { revision: revision.current, ...(position === undefined ? {} : { position }) };
      if (action === "pause") Object.assign(change, { paused: true, hold_reason: reason, review_on: reviewOn || null });
      else if (action === "wait") Object.assign(change, { waiting_for: reason, review_on: reviewOn || null });
      else if (action === "recap") Object.assign(change, { reviewed: true, brief, review_on: reviewOn || null });
      else {
        change.stage = action;
        if (action === "active") Object.assign(change, { brief, effort, paused: false, waiting_for: "" });
        if (action === "review") Object.assign(change, { acceptance, paused: false, waiting_for: "" });
        if (action === "done" || action === "stopped") change.outcome = outcome;
      }
      onSaved((await para.updateProject(project.id, change)).project);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试。"); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }}>
    <p className="para-hint">{project.title} · 当前{PARA_STAGES[project.stage]}</p>
    {action === "active" && <>
      <p className="kanban-policy">先明确要做成什么，再拉取这一项。{summary && `当前跨看板在制 ${summary.counts.wip} / ${summary.preferences.wip_limit} 项。`}</p>
      {atLimit && <p className="kanban-warning" role="status">已达到在制上限。建议先完成或验收手上的项目；必要时仍可开始本项。</p>}
      {(["goal", "success", "next"] as const).map((key) => <label key={key}>{({goal:"目标",success:"完成标准",next: project.stage === "review" ? "返工下一步" : "下一步"})[key]}
        <textarea aria-label={({goal:"目标",success:"完成标准",next: project.stage === "review" ? "返工下一步" : "下一步"})[key]} rows={2} maxLength={50000} value={brief[key]} onChange={e => setBrief({ ...brief, [key]: e.target.value })} placeholder={key === "next" ? "动作 + 对象 + 预期结果" : "可以现在补充，也可以在项目简报中继续完善"} /></label>)}
      <label>投入边界<input value={effort} maxLength={400} onChange={e => setEffort(e.target.value)} placeholder="例如：先用一个晚上，只完成第一版" /></label>
    </>}
    {action === "review" && <>
      <p className="kanban-policy">完成标准：{project.brief.success || "尚未填写，可在简报中补充"}</p>
      <label>验收说明<textarea aria-label="验收说明" rows={5} value={acceptance} maxLength={10000} onChange={e => setAcceptance(e.target.value)} placeholder="成果在哪里？已经验证了什么？还有哪些未验证项？" /></label>
      <p className="para-hint">成果文件与链接可在项目的「成果」页收录。提交后仍计入在制。</p>
    </>}
    {(action === "done" || action === "stopped") && <>
      <p className="kanban-policy">{action === "done" ? `对照完成标准：${project.brief.success || "请确认原先约定的目标已经达成"}` : "不再推进也是有效结论，保留已有资料与成果，之后可以重新打开。"}</p>
      {project.acceptance && <p className="kanban-evidence">验收说明：{project.acceptance}</p>}
      <label>{action === "done" ? "验收结论" : "终止原因"}<textarea aria-label={action === "done" ? "验收结论" : "终止原因"} required rows={4} value={outcome} maxLength={10000} onChange={e => setOutcome(e.target.value)} placeholder={action === "done" ? "结果是否满足目标？保留结论与遗留事项。" : "为什么不再继续？哪些成果值得保留？"} /></label>
      <p className="para-hint">{action === "done" ? "确认后项目结束，退出在制统计。" : "终止与完成分别记录。"}关联会话及已安排的任务仍独立运行。</p>
    </>}
    {(action === "pause" || action === "wait") && <>
      <label>{action === "pause" ? "暂停原因" : "在等谁 / 等什么"}<textarea aria-label={action === "pause" ? "暂停原因" : "在等谁 / 等什么"} required rows={3} value={reason} maxLength={4000} onChange={e => setReason(e.target.value)} placeholder={action === "wait" ? "例如：等我确认首页风格" : "例如：这周先完成另一件事"} /></label>
      <p className="para-hint">保留当前阶段，已启动的项目继续计入在制。关联会话与自动续跑保持原状态。</p>
    </>}
    {action === "recap" && <>
      <p className="kanban-policy">检查目标是否仍值得做、下一步是否清楚，以及有哪些成果可以验收。</p>
      <label>下一步<textarea aria-label="下一步" rows={3} maxLength={50000} value={brief.next} onChange={e => setBrief({ ...brief, next: e.target.value })} placeholder="写下接下来能执行的一件事" /></label>
    </>}
    {["pause", "wait", "recap"].includes(action) && <label>下次回顾<input aria-label="下次回顾" type="date" value={reviewOn} onChange={e => setReviewOn(e.target.value)} /><span className="para-hint">到期会出现在「待我处理」，不会自动创建任务。</span></label>}
    {error && <div className="para-error" role="alert">{error}</div>}
    {error.includes("其他窗口") && <button type="button" disabled={busy} onClick={async () => {
      try { setLatest((await para.project(project.id)).project); } catch (e) { setError(String(e)); }
    }}>查看服务器最新版本</button>}
    {latest && <div className="para-context-preview"><p>最新阶段：{PARA_STAGES[latest.stage]}</p>
      <p>目标：{latest.brief.goal || "未填写"}</p><p>完成标准：{latest.brief.success || "未填写"}</p><p>下一步：{latest.brief.next || "未填写"}</p>
      <p>约束：{latest.brief.constraints || "未填写"}</p><p>已确认决定：{latest.brief.decisions || "未填写"}</p><p>待解决问题：{latest.brief.questions || "未填写"}</p>
      <p>投入边界：{latest.effort || "未填写"}</p><p>验收说明：{latest.acceptance || "未填写"}</p><p>结论：{latest.outcome || "未填写"}</p><p>等待 / 暂停：{latest.waiting_for || latest.hold_reason || "无"}</p><p>回顾日期：{latest.review_on || "未安排"}</p>
      <p>对照以上最新内容修改上方输入，确认后再保存。</p>
      <button type="button" onClick={() => { revision.current = latest.revision; setLatest(null); setError(""); }}>已核对，保留我的输入继续保存</button></div>}
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="para-primary" disabled={busy}>{busy ? "正在保存…" : action === "recap" ? "完成本次回顾" : actionTitle(action)}</button></footer>
  </form>;
}

export function KanbanLimitSettings({ summary, disabled, onChange, onBusyChange }: {
  summary: KanbanSummary; disabled: boolean; onChange: () => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const [limit, setLimit] = useState(summary.preferences.wip_limit), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  return <form className="kanban-limit" onSubmit={async e => {
    e.preventDefault(); if (lock.current || disabled) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError(""); setSaved(false);
    try { await para.updatePreferences(summary.preferences.revision, limit); await onChange(); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }}>
    <h3 className="dialog-section-heading">推进提醒</h3>
    <label>个人在制上限<input aria-label="个人在制上限" type="number" min={1} max={30} required disabled={busy || disabled} value={limit} onChange={e => { setLimit(Number(e.target.value)); setSaved(false); }} /></label>
    <p className="dialog-description">所有看板共用，仅在开始推进时提醒，不限制会话运行。</p>
    {error && <p role="alert">{error}</p>}
    <div className="para-actions"><button disabled={busy || disabled}>{busy ? "正在保存…" : "保存上限"}</button>{saved && <span role="status">已保存</span>}</div>
  </form>;
}

export function KanbanAttention({ summary, onOpen, filter, setFilter }: { summary: KanbanSummary; onOpen: (boardId: string, projectId: string) => void; filter: string; setFilter: (filter: string) => void }) {
  const projects = summary.attention.filter(p => filter === "all" || (filter === "review" ? p.stage === "review" : filter === "waiting" ? p.waiting_for || p.paused : filter === "recap" ? p.review_on && p.review_on <= date() : p.stage === "review" || p.waiting_for || p.paused || (p.review_on && p.review_on <= date()) || !p.brief.next || needsWeeklyReview(p)));
  return <section className="para-panel"><div className="para-section-title"><h2>待我处理</h2><select aria-label="回顾范围" value={filter} onChange={e => setFilter(e.target.value)}>
    <option value="attention">需要关注</option><option value="review">待验收</option><option value="waiting">等待与暂停</option><option value="recap">到期回顾</option><option value="all">全部未结束项目</option>
  </select></div><p className="para-hint">跨看板查看；先验收、解除等待，再决定下一步。缺少下一步或一周未回顾的项目也会出现在这里。</p>
    {projects.length === 0 && <p className="para-empty">眼下没有待处理事项，可以安心推进手上的项目。</p>}
    <div className="kanban-attention-list">{projects.map(p => <button key={p.id} onClick={() => onOpen(p.board_id, p.id)}>
      <span><small>{p.board_name}{(p.archived_at || p.board_archived_at) && " · 已归档"}</small><strong>{p.title}</strong><span>{p.brief.next || "补充一个具体的下一步"}</span></span>
      <span><b>{projectAttention(p)}</b>{p.review_on && <small>回顾 {p.review_on}</small>}</span>
    </button>)}</div>
  </section>;
}
