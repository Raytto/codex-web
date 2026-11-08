import { instance } from "./instance";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import { api, type FileShareMetadata } from "./api";
import { filePreviewUrl, fileReaderKind } from "./file-links";
import { isPublicShareActive, publicShareRemaining } from "./public-share";
import { useShareClock } from "./use-share-clock";

export function FileShareDialog({ fileId, onClose, onChange, intent = "share" }: { fileId: string; onClose: () => void; onChange?: () => void; intent?: "share" | "open-web" }) {
  const openingWeb = intent === "open-web";
  const [metadata, setMetadata] = useState<FileShareMetadata | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const now = useShareClock();
  const load = useCallback(async () => { const value = await api.fileShare(fileId); if (alive.current) setMetadata(value); return value; }, [fileId]);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    void load().catch(reason => setError(String(reason.message || reason)));
    close.current?.focus();
    return () => { alive.current = false; previous?.focus({ preventScroll: true }); };
  }, [load]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,summary') ?? [])].filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [busy, onClose]);
  const active = metadata && isPublicShareActive(metadata.share.enabled, metadata.share.expiresAt, now);
  const expired = metadata?.share.expired || (metadata?.share.enabled && !active);
  const web = metadata?.file.presentation_mode === "web";
  const cold = metadata && metadata.storageState !== "local";
  async function restore() {
    setNotice("正在从阿里云盘恢复完整版本…");
    const result = await api.restoreSharedFile(metadata?.file.id || fileId);
    if (!result.restoring) { if (alive.current) setMetadata(result); return; }
    for (let attempt = 0; attempt < 180; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, 1000));
      if (!alive.current) throw new Error("已停止等待，服务器会继续恢复。");
      const value = await api.fileShare(metadata?.file.id || fileId); setMetadata(value);
      if (value.storageState === "local") return;
      if (value.storageState === "error") throw new Error("恢复失败，请稍后重试。");
    }
    throw new Error("仍在恢复，请稍后重试；分享权限尚未改变。");
  }
  async function change(action: "enable" | "disable" | "restore" | "redeliver", openVersion = false) {
    if (!metadata || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (action !== "disable" && cold) await restore();
      if (action === "redeliver") {
        const value = await api.redeliverPresentation(metadata.file.id, openingWeb || !web ? "web" : "reader");
        setMetadata(value); setNotice("已生成新的私有版本，原文件与原分享保持原样。");
        if (openingWeb || openVersion) window.location.assign(filePreviewUrl(value.file));
      } else if (action !== "restore") {
        const value = await (action === "enable" ? api.enableFileShare(metadata.file.id) : api.disableFileShare(metadata.file.id));
        setMetadata(current => current ? { ...current, share: value.share } : current); setNotice("");
      } else setNotice("完整版本已恢复。");
      onChange?.();
    } catch (reason) { setNotice(""); setError(reason instanceof Error ? reason.message : "操作失败，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function copyLink() {
    if (!metadata) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(metadata.share.publicUrl);
      else {
        const input = document.createElement("textarea"); input.value = metadata.share.publicUrl;
        panel.current?.appendChild(input); input.select(); const ok = document.execCommand("copy"); input.remove();
        if (!ok) throw new Error("copy failed");
      }
      setCopied(true);
    } catch { setError("复制失败，请选择链接手动复制。"); }
  }
  return createPortal(<div className="file-share-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section id="file-share-dialog" ref={panel} className="file-share-panel ui-dialog" role="dialog" aria-modal="true" aria-labelledby="file-share-dialog-title" aria-busy={busy}>
      <header className="file-share-heading"><div className="file-share-titleline"><strong id="file-share-dialog-title" className="dialog-title">{openingWeb ? "以交互网页打开" : "公开分享"}</strong>{!openingWeb && <span>{active ? "分享中" : expired ? "已到期" : metadata?.share.status === "closed" ? "已关闭" : "仅自己"}</span>}</div><button ref={close} className="file-share-close" aria-label={openingWeb ? "关闭展示设置" : "关闭分享设置"} disabled={busy} onClick={onClose}><X size={18} /></button></header>
      {metadata ? <><h3 className="dialog-section-heading file-share-filename">{metadata.file.original_name}</h3><p>{web ? "交互网页 · 打开后为无顶栏网页" : "阅读文档"}{cold ? " · 已冷存储或正在恢复" : ""}</p>
        {openingWeb ? <>
          <p>阅读模式不运行网页脚本。如果这是需要点击、切换或绘图的交互作品，可校验后打开完整网页。</p>
          <p>将创建新的私有版本，原文件、原分享开关和链接保持原样。新版本的分享由 {instance.productName} 控制。</p>
          <p>支持 5 MiB 以内的自包含 HTML；不支持外部资源或需要联网的功能。</p>
          <div className="file-share-actions">{web ? <a href={filePreviewUrl(metadata.file)}>打开交互网页</a> : <button disabled={busy} onClick={() => void change("redeliver")}>{busy ? "正在校验…" : "校验并打开交互网页"}</button>}</div>
        </> : <>
        <p>{active ? "获得链接的人可以访问，续期从现在重新计算 30 天。" : "默认私有。开启后，获得链接的人可访问，有效期为 30 天。"}</p>
        {active && metadata.share.expiresAt && <p>{publicShareRemaining(metadata.share.expiresAt, now)} · {new Date(metadata.share.expiresAt).toLocaleString("zh-CN", { hour12: false })} 到期</p>}
        {active && <input readOnly value={metadata.share.publicUrl} aria-label="公开链接" onFocus={event => event.currentTarget.select()} />}
        <div className="file-share-actions">{active ? <><button disabled={busy} onClick={() => void copyLink()}><Copy size={16} />{copied ? "已复制" : "复制链接"}</button><a href={metadata.share.publicUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />查看公开页</a><button disabled={busy} onClick={() => void change("enable")}><RefreshCw size={16} />续期 30 天</button><button className="danger" disabled={busy} onClick={() => void change("disable")}>关闭分享</button></>
          : <button disabled={busy} onClick={() => void change("enable")}>{busy ? "正在处理…" : expired || metadata.share.status === "closed" ? "重新开启分享（30 天）" : "开启公开分享（30 天）"}</button>}</div>
        {cold && <button className="file-share-secondary" disabled={busy} onClick={() => void change("restore")}>恢复完整版本</button>}
        {metadata.file.id !== fileId && <a className="file-share-secondary" href={filePreviewUrl(metadata.file)} target="_blank" rel="noreferrer">打开新私有版本</a>}
        {fileReaderKind(metadata.file) === "html" && (web
          ? <details className="file-share-version"><summary>展示类型需要纠正？</summary><p>核验后重新交付新私有版本，旧文件和链接保持原样。</p><button disabled={busy} onClick={() => void change("redeliver")}>按阅读文档重新交付</button></details>
          : <section className="file-share-version" aria-label="交互网页展示"><h4 className="dialog-section-heading">需要运行网页交互？</h4><p>阅读模式不运行脚本。校验后生成新的私有版本，原文件和原分享保持原样。</p><button disabled={busy} onClick={() => void change("redeliver", true)}>{busy ? "正在校验…" : "以交互网页打开"}</button></section>)}
        </>}
      </> : !error && <p>正在读取分享状态…</p>}
      {notice && <p role="status">{notice}</p>}{error && <p className="file-share-error" role="alert">{error}</p>}
    </section>
  </div>, document.body);
}
