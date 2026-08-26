import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Check, CircleDashed, FileText, LoaderCircle, Pencil, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { api, type PersonalMemoryEntry, type PersonalMemoryManagement, type PersonalMemoryReviewAction } from "./api";

type DialogTab = "overview" | "knowledge" | "files";
type KnowledgeFilter = "all" | "pending" | "active" | "rejected" | "forgotten";

const KIND_LABELS: Record<PersonalMemoryEntry["kind"], string> = {
  identity: "稳定背景",
  preference: "偏好",
  knowledge_level: "知识水平",
  current_focus: "近期关注",
  project_pointer: "项目指针",
};

const FILE_DESCRIPTIONS: Record<string, string> = {
  "PROFILE.md": "稳定背景、长期角色与明确边界",
  "PREFERENCES.md": "沟通、研究、执行和交付偏好",
  "KNOWLEDGE.md": "分领域知识水平与合适的解释深度",
  "NOW.md": "带日期的近期工作与短期关注点",
  "AUTO.md": "系统正式晋升的自动增量，只读",
};

function formatDate(value: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function entryStateLabel(entry: PersonalMemoryEntry): string {
  if (entry.review_state === "rejected") return "已拒绝";
  if (entry.review_state === "corrected") return "已纠正";
  if (entry.review_state === "accepted") return "已接受";
  if (entry.status === "active") return "已采用";
  if (entry.status === "conflicted") return "有冲突";
  if (entry.status === "forgotten") return "已遗忘";
  if (entry.status === "stale") return "已过期";
  return "待审核";
}

function matchesFilter(entry: PersonalMemoryEntry, filter: KnowledgeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return entry.review_state === "unreviewed" && ["candidate", "conflicted"].includes(entry.status);
  if (filter === "active") return entry.status === "active";
  if (filter === "rejected") return entry.review_state === "rejected";
  return entry.status === "forgotten" || entry.review_state === "forgotten";
}

export function PersonalMemoryDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<PersonalMemoryManagement | null>(null);
  const [tab, setTab] = useState<DialogTab>("overview");
  const [filter, setFilter] = useState<KnowledgeFilter>("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [correctedStatement, setCorrectedStatement] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("PROFILE.md");
  const [fileDraft, setFileDraft] = useState("");
  const [fileSavedContent, setFileSavedContent] = useState("");
  const [savingFile, setSavingFile] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await api.personalMemory()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "个人知识加载失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selectedFile = data?.files.find((file) => file.name === selectedFileName) ?? data?.files[0];
  useEffect(() => {
    if (!selectedFile) return;
    setSelectedFileName(selectedFile.name);
    setFileDraft(selectedFile.content);
    setFileSavedContent(selectedFile.content);
  }, [selectedFile?.name, selectedFile?.content]);

  const fileDirty = Boolean(selectedFile?.editable && fileDraft !== fileSavedContent);
  const requestClose = useCallback(() => {
    if (fileDirty && !window.confirm("基础文件还有未保存的修改，确定关闭吗？")) return;
    onClose();
  }, [fileDirty, onClose]);

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !busyId && !savingFile) requestClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busyId, requestClose, savingFile]);

  const filteredEntries = useMemo(() => (data?.entries ?? []).filter((entry) => matchesFilter(entry, filter)), [data?.entries, filter]);
  const pendingReview = data?.entries.filter((entry) => matchesFilter(entry, "pending")).length ?? 0;
  const rejected = data?.entries.filter((entry) => entry.review_state === "rejected").length ?? 0;

  async function review(entry: PersonalMemoryEntry, action: PersonalMemoryReviewAction, statement?: string) {
    if (busyId) return;
    if (action === "reject" && !window.confirm("拒绝后这条内容不会进入运行时画像。确定拒绝吗？")) return;
    if (action === "forget" && !window.confirm("遗忘会移除可读摘要，只保留已遗忘状态。确定继续吗？")) return;
    setBusyId(entry.id); setError("");
    try {
      setData(await api.reviewPersonalMemory(entry.id, action, statement));
      setEditingId(null); setCorrectedStatement("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "个人知识审核失败");
    } finally {
      setBusyId(null);
    }
  }

  async function saveFile() {
    if (!data || !selectedFile?.editable || savingFile || !fileDirty) return;
    setSavingFile(true); setError("");
    try {
      const next = await api.updatePersonalMemoryFile(selectedFile.name, fileDraft, data.revision);
      setData(next);
      const saved = next.files.find((file) => file.name === selectedFile.name)?.content ?? fileDraft;
      setFileDraft(saved); setFileSavedContent(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "基础文件保存失败");
    } finally {
      setSavingFile(false);
    }
  }

  function chooseFile(name: string) {
    if (name === selectedFileName) return;
    if (fileDirty && !window.confirm("当前文件还有未保存的修改，确定切换吗？")) return;
    const file = data?.files.find((item) => item.name === name);
    if (!file) return;
    setSelectedFileName(name); setFileDraft(file.content); setFileSavedContent(file.content);
  }

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyId && !savingFile) requestClose(); }}>
    <section className="project-dialog personal-memory-dialog" role="dialog" aria-modal="true" aria-labelledby="personal-memory-dialog-title">
      <header>
        <div><h2 id="personal-memory-dialog-title">个人知识</h2><p>管理只属于当前账号的长期画像、自动候选和运行时注入版本。</p></div>
        <button type="button" onClick={requestClose} disabled={Boolean(busyId) || savingFile} aria-label="关闭个人知识"><X size={18} /></button>
      </header>
      <nav className="personal-memory-tabs" aria-label="个人知识页面">
        <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><ShieldCheck size={15} />概览</button>
        <button type="button" className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}><BookOpen size={15} />知识审核{pendingReview > 0 && <span>{pendingReview}</span>}</button>
        <button type="button" className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}><FileText size={15} />基础文件</button>
      </nav>
      <div className="project-dialog-body personal-memory-body" aria-busy={loading}>
        {loading && !data && <div className="personal-memory-state"><LoaderCircle className="spin" size={20} />正在加载个人知识…</div>}
        {!loading && !data && <div className="personal-memory-state"><CircleDashed size={20} />暂时无法读取个人知识</div>}
        {data && tab === "overview" && <section className="personal-memory-overview">
          <div className="personal-memory-hero">
            <span className={data.enabled ? "enabled" : "disabled"}>{data.enabled ? "已启用" : "未启用"}</span>
            <div><strong>整体 revision {data.revision}</strong><small>{data.configured ? "自动提炼服务已配置" : "自动提炼服务未配置"} · 最近成功 {formatDate(data.last_successful_run_at)}</small></div>
            <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} />刷新</button>
          </div>
          <div className="personal-memory-metrics">
            <div><strong>{pendingReview}</strong><span>待审核</span></div>
            <div><strong>{data.active}</strong><span>已采用</span></div>
            <div><strong>{rejected}</strong><span>已拒绝</span></div>
            <div><strong>{data.forgotten}</strong><span>已遗忘</span></div>
            <div><strong>{data.pending}</strong><span>队列待处理</span></div>
            <div><strong>{data.processed}</strong><span>消息已提炼</span></div>
          </div>
          <div className="personal-memory-explainer">
            <h3>任务怎样使用这些信息</h3>
            <p>新 Codex thread 会读取一次有界个人画像；旧 thread 只在整体 revision 增加后，于下一次普通任务补充一次。实时调整不会重复注入，原始聊天和来源记录也不会整批塞入模型。</p>
            <div><span>当前账号隔离</span><span>单文件最多 6000 字符</span><span>总注入最多 18000 字符</span><span>敏感信息不自动晋升</span></div>
          </div>
          {data.failedAttempts > 0 && <div className="personal-memory-warning">有 {data.failedAttempts} 条消息正在等待失败重试；服务恢复后会继续处理。</div>}
        </section>}

        {data && tab === "knowledge" && <section className="personal-memory-knowledge">
          <div className="personal-memory-filter" role="group" aria-label="筛选个人知识">
            {(["all", "pending", "active", "rejected", "forgotten"] as KnowledgeFilter[]).map((value) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "pending" ? "待审核" : value === "active" ? "已采用" : value === "rejected" ? "已拒绝" : "已遗忘"}</button>)}
          </div>
          <div className="personal-memory-entry-list">
            {filteredEntries.map((entry) => <article className="personal-memory-entry" key={entry.id}>
              <header><div><span>{KIND_LABELS[entry.kind]}</span><span className={`state ${entryStateLabel(entry)}`}>{entryStateLabel(entry)}</span><span>{entry.confidence === "explicit" ? "明确" : entry.confidence === "high" ? "高置信" : entry.confidence === "medium" ? "中置信" : "低置信"}</span></div><small>{entry.canonical_key}</small></header>
              <p>{entry.statement}</p>
              <dl><div><dt>最近证据</dt><dd>{formatDate(entry.last_seen_at)}</dd></div><div><dt>来源</dt><dd>{entry.evidence_count} 条 · {entry.conversation_count} 个会话 · {entry.evidence_date_count} 个日期</dd></div>{entry.expires_at && <div><dt>有效至</dt><dd>{formatDate(entry.expires_at)}</dd></div>}</dl>
              {entry.evidence.length > 0 && <details className="personal-memory-sources"><summary>查看来源</summary><div>{entry.evidence.map((source) => <section key={`${source.message_id}-${source.evidence_kind}`}><header><strong>{source.conversation_title}</strong><time>{source.evidence_date}</time></header><p>{source.source_excerpt || "原消息没有可显示摘要"}</p></section>)}</div></details>}
              {editingId === entry.id ? <div className="personal-memory-correction"><textarea maxLength={320} value={correctedStatement} onChange={(event) => setCorrectedStatement(event.target.value)} aria-label="纠正后的知识摘要" /><small>{correctedStatement.length}/320</small><div><button type="button" onClick={() => { setEditingId(null); setCorrectedStatement(""); }}>取消</button><button type="button" className="primary" disabled={correctedStatement.trim().length < 2 || busyId === entry.id} onClick={() => void review(entry, "correct", correctedStatement)}>{busyId === entry.id ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存纠正</button></div></div>
                : entry.status !== "forgotten" && <footer>
                  {entry.review_state !== "accepted" && <button type="button" disabled={Boolean(busyId)} onClick={() => void review(entry, "accept")}><Check size={14} />接受</button>}
                  <button type="button" disabled={Boolean(busyId)} onClick={() => { setEditingId(entry.id); setCorrectedStatement(entry.statement); }}><Pencil size={14} />纠正</button>
                  {entry.review_state !== "rejected" && <button type="button" disabled={Boolean(busyId)} onClick={() => void review(entry, "reject")}><X size={14} />拒绝</button>}
                  <button type="button" className="danger" disabled={Boolean(busyId)} onClick={() => void review(entry, "forget")}><Trash2 size={14} />遗忘</button>
                </footer>}
            </article>)}
            {filteredEntries.length === 0 && <div className="personal-memory-empty"><BookOpen size={22} /><strong>这里还没有知识条目</strong><span>{filter === "pending" ? "新的候选通过提炼和置信度门槛后会出现在这里。" : "切换其他筛选条件查看。"}</span></div>}
          </div>
        </section>}

        {data && tab === "files" && <section className="personal-memory-files">
          <aside>{data.files.map((file) => <button type="button" key={file.name} className={selectedFileName === file.name ? "active" : ""} onClick={() => chooseFile(file.name)}><FileText size={15} /><span><strong>{file.name}</strong><small>{FILE_DESCRIPTIONS[file.name] ?? "个人知识文件"}</small></span>{!file.editable && <em>只读</em>}</button>)}</aside>
          <div className="personal-memory-file-editor">
            {selectedFile ? <>
              <header><div><strong>{selectedFile.name}</strong><small>{FILE_DESCRIPTIONS[selectedFile.name]} · 更新于 {formatDate(selectedFile.updatedAt)}</small></div>{selectedFile.editable && <span>{fileDraft.length}/{selectedFile.maxCharacters}</span>}</header>
              {selectedFile.editable
                ? <textarea value={fileDraft} maxLength={selectedFile.maxCharacters} onChange={(event) => setFileDraft(event.target.value)} spellCheck={false} aria-label={`编辑 ${selectedFile.name}`} />
                : <pre>{selectedFile.content || "暂无自动发布内容"}</pre>}
              <footer><p>{selectedFile.editable ? "保存会显式提升整体 revision；已有 thread 会在下一次任务补充新版画像。" : "自动文件由提炼流水线原子发布，不能在这里直接改写。"}</p>{selectedFile.editable && <button type="button" className="primary" disabled={!fileDirty || savingFile} onClick={() => void saveFile()}>{savingFile ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存并提升 revision</button>}</footer>
            </> : <div className="personal-memory-state">没有可显示的基础文件</div>}
          </div>
        </section>}
        {error && <div className="project-dialog-error personal-memory-error">{error}</div>}
      </div>
    </section>
  </div>;
}
