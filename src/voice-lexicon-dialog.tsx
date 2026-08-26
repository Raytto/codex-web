import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CircleDashed, Gauge, LoaderCircle, Mic, RefreshCw, Search, X } from "lucide-react";
import { api, type VoiceLexiconManagement, type VoiceLexiconTerm } from "./api";

type VoiceLexiconTab = "selected" | "candidates";

function formatDate(value: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function termMatches(term: VoiceLexiconTerm, query: string): boolean {
  if (!query) return true;
  const haystack = [term.canonical_text, term.canonical_key, term.term_kind, term.project_name ?? "", ...term.aliases].join("\n").toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

function VoiceKeywordCard({ term, rank }: { term: VoiceLexiconTerm; rank?: number }) {
  const weight = Math.max(0, Math.min(100, term.rank_index));
  return <article className="voice-keyword-card">
    <header>
      {rank && <strong className="voice-keyword-rank">#{rank}</strong>}
      <div className="voice-keyword-copy">
        <div><h3>{term.canonical_text}</h3>{term.pinned && <span className="pinned">置顶</span>}<span>{term.term_kind || "专业术语"}</span><span>{term.project_name ?? "全局"}</span></div>
        {term.aliases.length > 0 && <p>常见误识别：{term.aliases.join("、")}</p>}
      </div>
      <span className={`voice-keyword-state ${term.status}`}>{term.status === "active" ? "已选" : term.status === "conflicted" ? "有冲突" : "候选"}</span>
    </header>
    <div className="voice-keyword-weight" title="综合权重：可靠误识别率、使用强度和近期误识别共同计算">
      <span><Gauge size={14} /><b>综合权重</b><strong>{formatDecimal(term.rank_index)}</strong></span>
      <div><i style={{ width: `${weight}%` }} /></div>
    </div>
    <dl className="voice-keyword-metrics">
      <div title="按30天半衰期衰减后的有效使用机会"><dt>衰减使用数</dt><dd>{formatDecimal(term.voice_opportunities)}</dd></div>
      <div title="由有效使用次数归一化得到，越高代表使用越稳定"><dt>使用强度</dt><dd>{formatPercent(term.usage_score)}</dd></div>
      <div title="按60天半衰期衰减并按置信度加权"><dt>加权误识别</dt><dd>{formatDecimal(term.weighted_errors)}</dd></div>
      <div title="带先验平滑的可靠误识别率，是综合排名的主要因素"><dt>可靠误识别率</dt><dd>{formatPercent(term.reliable_error_rate)}</dd></div>
      <div title="支持该词的语音证据总数"><dt>证据</dt><dd>{term.evidence_count}</dd></div>
      <div title="证据中被判定为误识别的次数"><dt>误识别证据</dt><dd>{term.error_evidence_count}</dd></div>
    </dl>
    <footer><span>最近使用 {formatDate(term.last_used_at)}</span><span>最近误识别 {formatDate(term.last_error_at)}</span></footer>
  </article>;
}

export function VoiceLexiconDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<VoiceLexiconManagement | null>(null);
  const [tab, setTab] = useState<VoiceLexiconTab>("selected");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await api.voiceLexicon()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "语音关键词加载失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const sourceTerms = tab === "selected" ? data?.selectedTerms ?? [] : data?.candidateTerms ?? [];
  const visibleTerms = useMemo(() => sourceTerms.filter((term) => termMatches(term, query.trim())), [query, sourceTerms]);
  const selectedRanks = useMemo(() => new Map((data?.selectedTerms ?? []).map((term, index) => [term.id, index + 1])), [data?.selectedTerms]);

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-dialog personal-memory-dialog voice-lexicon-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-lexicon-dialog-title">
      <header>
        <div><h2 id="voice-lexicon-dialog-title">语音关键词</h2><p>查看当前账号用于语音识别的高价值词和仍在积累证据的候选词。</p></div>
        <button type="button" onClick={onClose} aria-label="关闭语音关键词"><X size={18} /></button>
      </header>
      <nav className="personal-memory-tabs" aria-label="语音关键词页面">
        <button type="button" className={tab === "selected" ? "active" : ""} onClick={() => { setTab("selected"); setQuery(""); }}><Mic size={15} />已选词{data && <span>{data.selectedTerms.length}</span>}</button>
        <button type="button" className={tab === "candidates" ? "active" : ""} onClick={() => { setTab("candidates"); setQuery(""); }}><Activity size={15} />候选词{data && data.candidateCount > 0 && <span>{data.candidateCount}</span>}</button>
      </nav>
      <div className="project-dialog-body personal-memory-body voice-lexicon-body" aria-busy={loading}>
        {loading && !data && <div className="personal-memory-state"><LoaderCircle className="spin" size={20} />正在加载语音关键词…</div>}
        {!loading && !data && <div className="personal-memory-state"><CircleDashed size={20} />暂时无法读取语音关键词</div>}
        {data && <>
          <section className="voice-lexicon-summary">
            <div className="voice-lexicon-summary-copy"><span>Luna</span><div><strong>每次选取最重要的 {data.maxSelectedTerms} 个词</strong><small>{data.model} · 词库预算约 {data.tokenBudget} token · {data.batchThreshold} 条或最老等待 {Math.round(data.delayMs / 3_600_000)} 小时复核</small><small>{data.lastRun ? `最近复核 ${formatDate(data.lastRun.completed_at)} · ${data.lastRun.status === "succeeded" ? "成功" : "失败"} · 发现 ${data.lastRun.candidate_count} 个候选` : "还没有完成过复核批次"}</small></div></div>
            <div className="voice-lexicon-summary-metrics">
              <div><strong>{data.selectedTerms.length}/{data.maxSelectedTerms}</strong><span>前列已选（激活 {data.activeCount}）</span></div>
              <div><strong>{data.candidateCount}</strong><span>全部候选</span></div>
              <div><strong>{data.submitted_pending}</strong><span>待复核语音</span></div>
              <div><strong>{data.run_count}</strong><span>累计批次</span></div>
            </div>
            <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} />刷新</button>
          </section>
          <details className="voice-lexicon-explainer">
            <summary>指标怎样计算</summary>
            <p>这里展示账号内的综合排名；实际识别会从全局词和当前项目词中选取最重要的 {data.maxSelectedTerms} 个。综合权重以可靠误识别率为主（72%），使用强度（20%）和近期误识别（8%）为辅；使用次数按30天半衰期衰减，误识别按60天半衰期衰减。候选词出现重复证据或一次高置信严重误识别后，才会进入已选词。</p>
          </details>
          <div className="voice-lexicon-toolbar">
            <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "selected" ? "搜索已选关键词" : "搜索全部候选词"} aria-label="搜索语音关键词" /></label>
            <span>显示 {visibleTerms.length} / {sourceTerms.length}</span>
          </div>
          <section className="voice-keyword-list">
            {visibleTerms.map((term) => <VoiceKeywordCard key={term.id} term={term} rank={tab === "selected" ? selectedRanks.get(term.id) : undefined} />)}
            {visibleTerms.length === 0 && <div className="personal-memory-empty"><Mic size={22} /><strong>{query ? "没有匹配的关键词" : tab === "selected" ? "还没有已选关键词" : "还没有候选关键词"}</strong><span>{query ? "换一个关键词、别名或词类试试。" : "新的已提交语音达到批次条件后，系统会自动复核并更新这里。"}</span></div>}
          </section>
        </>}
        {error && <div className="project-dialog-error personal-memory-error">{error}</div>}
      </div>
    </section>
  </div>;
}
