import { useEffect, useRef, useState } from "react";
import {FileRestoreStatus} from "./storage-restore-progress";
import { api, BASE_PATH } from "./api";

type Runtime = { title: string; ticket: string; src: string };
export function WebPresentation({ fileId, publicView = false }: { fileId: string; publicView?: boolean }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState("");
  const [exportRequest, setExportRequest] = useState<{ name: string; text: string } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let interval: number | undefined, checking = false;
    let current: Runtime | null = null;
    const verify = async () => {
      if (checking || !current || controller.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch(`${BASE_PATH}/api/web-runtime/${encodeURIComponent(current.ticket)}`, { method: "HEAD", credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("访问已失效，请返回附件卡片检查分享或重新打开。");
      } catch (reason) { if (!controller.signal.aborted) { setRuntime(null); setExportRequest(null); setError(reason instanceof Error ? reason.message : "访问已失效。"); } }
      finally { checking = false; }
    };
    const visible = () => { if (!document.hidden) void verify(); };
    void api.webSession(fileId, publicView, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      current = value; document.title = value.title; setRuntime(value);
      interval = window.setInterval(() => void verify(), 60_000);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "网页打开失败。"); });
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [fileId, publicView]);
  useEffect(() => {
    if (!runtime) return;
    let lastExport = 0;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null" || event.data?.channel !== runtime.ticket || event.data?.type !== "codex-web:export") return;
      const { name, text } = event.data;
      if (typeof name !== "string" || !/^[^/\\\u0000-\u001f]{1,100}\.(?:json|csv|txt)$/.test(name) || typeof text !== "string" || new Blob([text]).size > 1024 * 1024 || Date.now() - lastExport < 1000) return;
      lastExport = Date.now(); setExportRequest({ name, text });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [runtime]);
  function saveExport() {
    if (!exportRequest) return;
    const url = URL.createObjectURL(new Blob(["\uFEFF", exportRequest.text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = exportRequest.name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000); setExportRequest(null);
  }
  return <main className="web-presentation">
    {runtime ? <iframe ref={frame} title={runtime.title} src={runtime.src} sandbox="allow-scripts" referrerPolicy="no-referrer" />
      : <div className="web-presentation-state" role="status">{error || <FileRestoreStatus fileId={fileId} publicView={publicView}/>}</div>}
    {exportRequest && <div className="file-share-backdrop"><section className="file-share-panel ui-dialog" role="dialog" aria-modal="true" aria-label="保存网页导出文件"><h2 className="dialog-title">保存导出文件</h2><p>{exportRequest.name}</p><div className="file-share-actions"><button onClick={saveExport}>下载文件</button><button onClick={() => setExportRequest(null)}>取消</button></div></section></div>}
  </main>;
}
