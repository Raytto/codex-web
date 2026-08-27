import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import type { ReaderAnnotation } from "../api";

export function ReaderAnnotationPanel({
  annotations,
  onDelete,
  onSelect,
  onAsk,
  activeAnnotationId,
}: {
  annotations: ReaderAnnotation[];
  onDelete?: (annotation: ReaderAnnotation) => void;
  onSelect?: (annotation: ReaderAnnotation) => void;
  onAsk?: (annotation: ReaderAnnotation) => void;
  activeAnnotationId?: string | null;
}) {
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (!activeAnnotationId) return;
    const item = itemRefs.current[activeAnnotationId];
    if (item && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  }, [activeAnnotationId]);
  if (annotations.length === 0) return null;
  const recent = annotations.slice(-12);
  const selected = activeAnnotationId ? annotations.find((annotation) => annotation.id === activeAnnotationId) : undefined;
  const visible = selected && !recent.some((annotation) => annotation.id === selected.id) ? [selected, ...recent] : recent;
  return <aside className="reader-annotations" aria-label="阅读标注">
    <div className="reader-annotations-heading"><strong>标注</strong><span>{annotations.length}</span><small>点击可重新选择</small></div>
    {visible.map((annotation) => <article ref={(element) => { itemRefs.current[annotation.id] = element; }} className={`reader-annotation-item${activeAnnotationId === annotation.id ? " active" : ""}`} key={annotation.id}>
      <div className="reader-annotation-meta">
        {onSelect ? <button type="button" className="reader-annotation-jump" onClick={() => onSelect(annotation)} aria-pressed={activeAnnotationId === annotation.id}>
          <i className={`reader-annotation-swatch ${annotation.type}`} aria-hidden="true" />
          <span>{annotation.type === "highlight" ? "标记" : "备注"}</span>
        </button> : <span className="reader-annotation-kind">{annotation.type === "highlight" ? "标记" : "备注"}</span>}
        {onAsk && <button type="button" className="reader-annotation-ask" onClick={() => onAsk(annotation)}>问 Agent</button>}
        {onDelete && <button type="button" title="删除标注" aria-label="删除这条标注" onClick={() => onDelete(annotation)}><Trash2 size={12} /></button>}
      </div>
      {onSelect ? <button type="button" className="reader-annotation-quote" onClick={() => onSelect(annotation)}>{annotation.quote_text}</button> : <p>{annotation.quote_text}</p>}
      {annotation.note_text && <small className="reader-annotation-note">{annotation.note_text}</small>}
    </article>)}
  </aside>;
}
