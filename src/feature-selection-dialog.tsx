import { useEffect, useRef } from "react";
import { LayoutDashboard, LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import { useFeatureSelection } from "./feature-selection-context";

export function FeatureSelectionDialog({ onClose }: { onClose: () => void }) {
  const { features, saving, error, changeParaBoard } = useFeatureSelection();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", keydown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [onClose]);
  return <div className="project-dialog-backdrop display-settings-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="project-dialog display-settings-dialog feature-selection-dialog" role="dialog" aria-modal="true" aria-labelledby="feature-selection-title">
      <header>
        <div><SlidersHorizontal size={19} /><div><h2 id="feature-selection-title">功能选择</h2><p>选择要显示的功能，自动同步到同账号的其他设备。</p></div></div>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭功能选择"><X size={18} /></button>
      </header>
      <div className="display-settings-body">
        <label className="feature-selection-option">
          <span className="feature-selection-icon"><LayoutDashboard size={22} /></span>
          <span className="display-settings-card-copy"><strong>项目看板</strong><small id="para-feature-description">从想法、推进到验收，管理项目完整生命周期。隐藏后保留已有内容及会话关联。</small></span>
          <input type="checkbox" aria-label="项目看板" aria-describedby="para-feature-description" checked={features.paraBoard} aria-disabled={saving} aria-busy={saving} onChange={e => { if (!saving) void changeParaBoard(e.target.checked); }} />
        </label>
        <p className="feature-selection-status" role="status">{saving ? <><LoaderCircle size={14} className="spin" />正在保存…</> : "勾选后显示，取消勾选后隐藏。"}</p>
        {error && <p className="feature-selection-error" role="alert">{error}</p>}
      </div>
    </section>
  </div>;
}
