import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import type { ReaderAnnotation } from "../api";
import type { ReaderSelection } from "../reader-ask";

export type ReaderAnnotationAnchor = { left: number; top: number };

export function ReaderNoteEditor({ selection, onSave, onClose }: {
  selection: ReaderSelection;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { textarea.current?.focus({ preventScroll: true }); }, []);
  const halfWidth = Math.min(210, Math.max(0, (window.innerWidth - 24) / 2));
  const left = Math.min(window.innerWidth - 12 - halfWidth, Math.max(12 + halfWidth, selection.left));
  const top = Math.min(window.innerHeight - 12, Math.max(12, selection.top + 42));
  const editor = <aside className="reader-note-editor" style={{ left, top }} role="dialog" aria-label="添加阅读备注">
    <blockquote>{selection.text}</blockquote>
    <textarea ref={textarea} value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下你的想法…" rows={5} />
    <div><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={!note.trim()} onClick={() => onSave(note.trim())}>保存备注</button></div>
  </aside>;
  return typeof document === "undefined" ? editor : createPortal(editor, document.body);
}

export function ReaderAnnotationPanel({
  annotations,
  onDelete,
  onSelect,
  onAsk,
  activeAnnotationId,
  anchor,
  onClose,
}: {
  annotations: ReaderAnnotation[];
  onDelete?: (annotation: ReaderAnnotation) => void;
  onSelect?: (annotation: ReaderAnnotation) => void;
  onAsk?: (annotation: ReaderAnnotation) => void;
  activeAnnotationId?: string | null;
  anchor?: ReaderAnnotationAnchor | null;
  onClose?: () => void;
}) {
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (!activeAnnotationId) return;
    const item = itemRefs.current[activeAnnotationId];
    if (item && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  }, [activeAnnotationId]);
  const selected = activeAnnotationId ? annotations.find((annotation) => annotation.id === activeAnnotationId) : undefined;
  // Annotation details are contextual, not a persistent reader overlay. A
  // newly created annotation stays quietly in the text; tapping its highlight
  // opts into this panel and the close action returns to unobstructed reading.
  if (!selected) return null;
  const anchoredStyle = anchor && typeof window !== "undefined" ? {
    left: Math.min(window.innerWidth - 182, Math.max(182, anchor.left)),
    top: Math.min(window.innerHeight - 180, Math.max(12, anchor.top)),
  } : undefined;
  return <aside className={`reader-annotations${anchor ? " anchored" : ""}`} style={anchoredStyle} aria-label="阅读标注">
    <div className="reader-annotations-heading"><strong>标注</strong><span>{annotations.length}</span>{onClose && <button type="button" className="reader-annotations-close" title="关闭标注详情" aria-label="关闭标注详情" onClick={onClose}><X size={13} /></button>}</div>
    {[selected].map((annotation) => <article ref={(element) => { itemRefs.current[annotation.id] = element; }} className="reader-annotation-item active" key={annotation.id}>
      <div className="reader-annotation-meta">
        {onSelect ? <button type="button" className="reader-annotation-jump" onClick={() => onSelect(annotation)} aria-pressed={activeAnnotationId === annotation.id}>
          <i className={`reader-annotation-swatch ${annotation.type}`} aria-hidden="true" />
          <span>{annotation.type === "highlight" ? "标记" : "备注"}</span>
        </button> : <span className="reader-annotation-kind">{annotation.type === "highlight" ? "标记" : "备注"}</span>}
        {onAsk && <button type="button" className="reader-annotation-ask" onClick={() => { onAsk(annotation); onClose?.(); }}>问 Agent</button>}
        {onDelete && <button type="button" title="删除标注" aria-label="删除这条标注" onClick={() => onDelete(annotation)}><Trash2 size={12} /></button>}
      </div>
      {onSelect ? <button type="button" className="reader-annotation-quote" onClick={() => onSelect(annotation)}>{annotation.quote_text}</button> : <p>{annotation.quote_text}</p>}
      {annotation.note_text && <small className="reader-annotation-note">{annotation.note_text}</small>}
    </article>)}
  </aside>;
}
