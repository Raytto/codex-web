import { Trash2 } from "lucide-react";
import type { ReaderAnnotation } from "../api";

export function ReaderAnnotationPanel({
  annotations,
  onDelete,
}: {
  annotations: ReaderAnnotation[];
  onDelete?: (annotation: ReaderAnnotation) => void;
}) {
  if (annotations.length === 0) return null;
  return <aside className="reader-annotations" aria-label="阅读标注">
    <div className="reader-annotations-heading"><strong>标注</strong><span>{annotations.length}</span></div>
    {annotations.slice(-12).map((annotation) => <div className="reader-annotation-item" key={annotation.id}>
      <div className="reader-annotation-meta">
        <span>{annotation.type === "highlight" ? "标记" : "备注"}</span>
        {onDelete && <button type="button" title="删除标注" aria-label="删除这条标注" onClick={() => onDelete(annotation)}><Trash2 size={12} /></button>}
      </div>
      <p>{annotation.quote_text}</p>
      {annotation.note_text && <small>{annotation.note_text}</small>}
    </div>)}
  </aside>;
}
