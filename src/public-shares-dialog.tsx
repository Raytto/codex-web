import { useCallback, useEffect, useState } from "react";
import { Check, Clipboard, ExternalLink, FileText, Globe2, LoaderCircle, RefreshCw, Share2, X } from "lucide-react";
import { api, type ManagedPublicShare } from "./api";
import { filePreviewUrl } from "./file-links";

function formatDate(value: string | null): string {
  if (!value) return "暂无时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "大小未知";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const input = document.createElement("textarea");
  input.value = value; input.style.position = "fixed"; input.style.opacity = "0";
  document.body.appendChild(input); input.select();
  if (!document.execCommand("copy")) throw new Error("copy failed");
  input.remove();
}

export function PublicSharesDialog({ onClose }: { onClose: () => void }) {
  const [shares, setShares] = useState<ManagedPublicShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setShares((await api.publicShares()).shares); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "公开分享列表加载失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !closingId) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [closingId, onClose]);

  async function copyLink(share: ManagedPublicShare) {
    setError("");
    try {
      await copyText(share.publicUrl);
      setCopiedId(share.id);
      window.setTimeout(() => setCopiedId((current) => current === share.id ? null : current), 1_500);
    } catch { setError("复制失败，请手动打开公开链接后复制。"); }
  }

  async function closeShare(share: ManagedPublicShare) {
    if (closingId || !window.confirm(`关闭“${share.fileName}”的公开分享？关闭后公开链接会立即失效。`)) return;
    const previous = shares;
    setClosingId(share.id); setError("");
    setShares((current) => current.filter((item) => item.id !== share.id));
    try { await api.disableFileShare(share.fileId); }
    catch (reason) {
      setShares(previous);
      setError(reason instanceof Error ? reason.message : "关闭公开分享失败");
    } finally { setClosingId(null); }
  }

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !closingId) onClose(); }}>
    <section className="project-dialog public-shares-dialog" role="dialog" aria-modal="true" aria-labelledby="public-shares-dialog-title">
      <header>
        <div><h2 id="public-shares-dialog-title">公开分享管理</h2><p>查看和管理当前账号正在公开的 Markdown、HTML 内容。</p></div>
        <button type="button" onClick={onClose} disabled={Boolean(closingId)} aria-label="关闭公开分享管理"><X size={18} /></button>
      </header>
      <div className="project-dialog-body public-shares-body" aria-busy={loading}>
        <div className="public-shares-toolbar"><span><Share2 size={15} />正在公开 {shares.length} 项</span><button type="button" onClick={() => void load()} disabled={loading || Boolean(closingId)}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新</button></div>
        {loading && shares.length === 0 && <div className="public-shares-state"><LoaderCircle className="spin" size={20} />正在加载公开分享…</div>}
        {!loading && shares.length === 0 && <div className="public-shares-state"><Globe2 size={25} /><strong>还没有正在公开的内容</strong><span>在 Markdown 或 HTML 文件的阅读页中开启公开分享后，会显示在这里。</span></div>}
        <div className="public-shares-list">
          {shares.map((share) => <article className="public-share-row" key={share.id}>
            <div className="public-share-icon"><FileText size={18} /></div>
            <div className="public-share-copy">
              <a href={filePreviewUrl({ id: share.fileId })} target="_blank" rel="noreferrer" className="public-share-title">{share.fileName}</a>
              <span>{share.documentKind === "html" ? "HTML" : "Markdown"} · {formatSize(share.size)} · {share.conversationTitle || "未命名任务"}</span>
              <time dateTime={share.enabledAt ?? undefined}>开启于 {formatDate(share.enabledAt)}</time>
            </div>
            <div className="public-share-actions">
              <a href={share.publicUrl} target="_blank" rel="noreferrer" title="查看公开链接"><ExternalLink size={14} /><span>公开页</span></a>
              <button type="button" onClick={() => void copyLink(share)} disabled={Boolean(closingId)} title="复制公开链接">{copiedId === share.id ? <Check size={14} /> : <Clipboard size={14} />}<span>{copiedId === share.id ? "已复制" : "复制"}</span></button>
              <button type="button" className="danger" onClick={() => void closeShare(share)} disabled={Boolean(closingId)} title="关闭公开分享"><X size={14} /><span>{closingId === share.id ? "关闭中…" : "关闭"}</span></button>
            </div>
          </article>)}
        </div>
        {error && <div className="project-dialog-error public-shares-error">{error}</div>}
      </div>
    </section>
  </div>;
}
