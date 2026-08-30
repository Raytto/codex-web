import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileReaderKind } from "../file-links";
import { useAsyncMarkdownMath } from "../markdown-math";
import { markdownReaderOutline, prepareHtmlReaderDocument, type PreparedHtmlDocument } from "../file-reader-outline";
import { readReaderPosition, restoreReaderScrollTop, writeReaderPosition } from "../reader-position";
import type { ResolvedTheme } from "../theme";
import type { WorkFile } from "../api";

const READER_POSITION_SAVE_DELAY_MS = 2_000;
const READER_POSITION_SAVE_INTERVAL_MS = 5_000;
const READER_POSITION_RESTORE_ATTEMPTS = 10;
const READER_OUTLINE_TOP_EPSILON_PX = 2;
const READER_OUTLINE_ACTIVATION_OFFSET_PX = 96;

function readerNativeSelectionActive(container: HTMLElement): boolean {
  const selection = document.getSelection();
  // A collapsed caret/compatibility range is not a text-selection transaction
  // and must not freeze the outline on a stale item after returning to the top.
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return Boolean(selection.anchorNode && selection.focusNode && container.contains(selection.anchorNode) && container.contains(selection.focusNode));
}

function updateReaderOutline(container: HTMLElement, headings: HTMLElement[], onActiveAnchorChange: (id: string | null) => void): void {
  // Scroll-driven active-anchor changes must not trigger another smooth scroll.
  // Leave the document completely quiet while WebKit owns a native selection
  // transaction; the next ordinary scroll will refresh the outline.
  if (readerNativeSelectionActive(container) || headings.length < 2) return;
  const visibleHeadings = headings.filter((heading) => heading.getClientRects().length > 0);
  const candidates = visibleHeadings.filter((heading) => {
    const rect = heading.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && Number.isFinite(rect.top);
  });
  // A heading can sit well below the report title/lead at scroll origin. The
  // old geometry-only loop could see a transient, not-yet-laid-out heading
  // list and leave a later section active even though the reader was visibly
  // at the beginning. Scroll origin is unambiguous: the first outline item
  // is the only safe active choice.
  const scrollTop = Number.isFinite(container.scrollTop) ? Math.max(0, container.scrollTop) : 0;
  if (scrollTop <= READER_OUTLINE_TOP_EPSILON_PX) {
    // Use the first *rendered* heading so a hidden/removed author heading can
    // never become the active item merely because it appears first in DOM
    // order.
    onActiveAnchorChange(candidates[0]?.id ?? null);
    return;
  }
  // If layout is not measurable yet, do not guess. A later restore/scroll
  // pass will retry and an incorrect active item is worse than no highlight.
  if (candidates.length === 0) {
    onActiveAnchorChange(null);
    return;
  }
  const top = container.getBoundingClientRect().top;
  let current: HTMLElement | null = null;
  for (const heading of candidates) {
    if (heading.getBoundingClientRect().top <= top + READER_OUTLINE_ACTIVATION_OFFSET_PX) current = heading;
    else break;
  }
  // Before the first rendered heading enters the activation line, the reader
  // is still in the first section. If that first heading is not measurable,
  // the null branch above deliberately avoids selecting a later item.
  onActiveAnchorChange((current ?? candidates[0])?.id ?? null);
}

function HtmlFileReader({ file, content, activeAnchor, navigationToken }: { file: Pick<WorkFile, "original_name">; content: string; activeAnchor: string | null; navigationToken: number }) {
  const scrollRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeAnchor || navigationToken === 0 || !scrollRoot.current) return;
    const root = scrollRoot.current;
    const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === activeAnchor);
    if (!target) return;
    const rootRect = root.getBoundingClientRect(); const targetRect = target.getBoundingClientRect();
    root.scrollTo({ top: Math.max(0, root.scrollTop + targetRect.top - rootRect.top - 18), behavior: "smooth" });
  }, [content, navigationToken]);
  return <div ref={scrollRoot} className="file-reader-html file-preview-scroll reader-text-container" role="document" aria-label={file.original_name || "HTML 文件预览"} dangerouslySetInnerHTML={{ __html: content }} />;
}

function FileReaderContent({ file, content, prepared, activeAnchor, navigationToken }: { file: Pick<WorkFile, "original_name" | "mime_type">; content: string; prepared: PreparedHtmlDocument; activeAnchor: string | null; navigationToken: number }) {
  const readerKind = fileReaderKind(file); const math = useAsyncMarkdownMath(content);
  if (readerKind === "markdown") return <div className="file-preview-scroll reader-text-container"><article className="file-reader-markdown markdown">{(() => { let headingCursor = 0; return <ReactMarkdown
    remarkPlugins={math.plugins ? [remarkGfm, math.plugins.remarkMath] : [remarkGfm]}
    rehypePlugins={math.plugins ? [[math.plugins.rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]] : []}
    skipHtml urlTransform={defaultUrlTransform}
    components={{
      h2: ({ children, ...props }) => { const item = prepared.outline[headingCursor++]; return <h2 id={item?.id} {...props}>{children}</h2>; },
      a: ({ href, children }) => href?.startsWith("#") ? <a href={href}>{children}</a> : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      img: ({ node: _node, alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" />,
      table: ({ node: _node, ...props }) => <div className="file-reader-table"><table {...props} /></div>,
    }}
  >{math.content}</ReactMarkdown>; })()}</article></div>;
  if (readerKind === "html") return <HtmlFileReader file={file} content={prepared.content} activeAnchor={activeAnchor} navigationToken={navigationToken} />;
  return null;
}

export const FileReaderLayout = memo(function FileReaderLayout({ file, content, prepared, tocOpen, activeAnchor, onSelect, onActiveAnchorChange, navigationToken }: {
  file: Pick<WorkFile, "id" | "original_name" | "mime_type">; content: string; prepared: PreparedHtmlDocument; tocOpen: boolean; activeAnchor: string | null; onSelect: (id: string) => void; onActiveAnchorChange: (id: string | null) => void; navigationToken: number;
}) {
  const scrollRoot = useRef<HTMLDivElement>(null); const readerKind = fileReaderKind(file); const showOutline = prepared.outline.length >= 2;
  useEffect(() => {
    const documentRoot = scrollRoot.current; if (!documentRoot || !file.id) return;
    const container = documentRoot.querySelector<HTMLElement>(".file-preview-scroll"); if (!container) return;
    let storage: Storage | null = null; try { storage = window.localStorage; } catch {}
    const saved = readReaderPosition(storage, file.id); let restored = false; let restoreAttempts = 0; let restoreTimer: number | null = null; let saveTimer: number | null = null;
    const headings = Array.from(container.querySelectorAll<HTMLElement>("h2[id]")); const syncActiveHeading = () => updateReaderOutline(container, headings, onActiveAnchorChange);
    const restore = () => { restoreTimer = null; if (!saved) { container.scrollTop = 0; restored = true; window.requestAnimationFrame(syncActiveHeading); return; } const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight); if (saved.scrollTop > 0 && maxScrollTop === 0 && restoreAttempts < READER_POSITION_RESTORE_ATTEMPTS) { restoreAttempts += 1; restoreTimer = window.setTimeout(restore, 120); return; } container.scrollTop = restoreReaderScrollTop(saved, container.scrollHeight, container.clientHeight); restored = true; window.requestAnimationFrame(syncActiveHeading); };
    const save = () => { saveTimer = null; if (!restored) return; writeReaderPosition(storage, file.id, { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight, updatedAt: Date.now() }); };
    const scheduleSave = () => { if (!restored) return; if (saveTimer !== null) window.clearTimeout(saveTimer); saveTimer = window.setTimeout(save, READER_POSITION_SAVE_DELAY_MS); };
    const flushSave = () => { if (saveTimer !== null) window.clearTimeout(saveTimer); saveTimer = null; save(); };
    const handleVisibilityChange = () => { if (document.visibilityState === "hidden") flushSave(); };
    container.addEventListener("scroll", scheduleSave, { passive: true }); document.addEventListener("visibilitychange", handleVisibilityChange); window.addEventListener("pagehide", flushSave); restoreTimer = window.setTimeout(restore, 0); const interval = window.setInterval(save, READER_POSITION_SAVE_INTERVAL_MS);
    return () => { if (restoreTimer !== null) window.clearTimeout(restoreTimer); if (saveTimer !== null) window.clearTimeout(saveTimer); window.clearInterval(interval); flushSave(); container.removeEventListener("scroll", scheduleSave); document.removeEventListener("visibilitychange", handleVisibilityChange); window.removeEventListener("pagehide", flushSave); };
  }, [content, file.id, onActiveAnchorChange, prepared.content]);
  useEffect(() => { if (readerKind !== "markdown" || navigationToken === 0 || !activeAnchor || !scrollRoot.current) return; const target = Array.from(scrollRoot.current.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === activeAnchor); const container = target?.closest<HTMLElement>(".file-preview-scroll"); if (target && container) container.scrollTo({ top: Math.max(0, target.offsetTop - 18), behavior: "smooth" }); }, [navigationToken, readerKind]);
  useEffect(() => {
    if (!scrollRoot.current || prepared.outline.length < 2) return;
    const container = scrollRoot.current.querySelector<HTMLElement>(".file-preview-scroll");
    if (!container) return;
    const headings = Array.from(container.querySelectorAll<HTMLElement>("h2[id]"));
    if (headings.length < 2) return;
    let frame: number | null = null;
    const updateCurrentHeading = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateReaderOutline(container, headings, onActiveAnchorChange);
      });
    };
    container.addEventListener("scroll", updateCurrentHeading, { passive: true });
    // Initial synchronization is performed after scroll-position restoration;
    // do not sample a transient layout here.
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      container.removeEventListener("scroll", updateCurrentHeading);
    };
  }, [onActiveAnchorChange, prepared.content]);
  return <div className={`file-reader-layout${showOutline && tocOpen ? " outline-open" : ""}`}>
    {showOutline && tocOpen && <aside id="file-reader-outline" className="file-reader-outline" aria-label="文章目录"><h2>文章目录</h2><ol>{prepared.outline.map((item) => <li key={item.id}><a href={`#${encodeURIComponent(item.id)}`} aria-current={activeAnchor === item.id ? "location" : undefined} onClick={(event) => { event.preventDefault(); onSelect(item.id); }}>{item.label}</a></li>)}</ol></aside>}
    <div ref={scrollRoot} className="file-reader-document"><FileReaderContent file={file} content={content} prepared={prepared} activeAnchor={activeAnchor && readerKind === "html" ? activeAnchor : null} navigationToken={navigationToken} /></div>
  </div>;
});

export function preparedReaderDocument(file: Pick<WorkFile, "mime_type" | "original_name"> | null, content: string | null, resolvedTheme: ResolvedTheme): PreparedHtmlDocument {
  if (!file || content === null) return { content: content ?? "", outline: [] };
  if (fileReaderKind(file) === "html") return prepareHtmlReaderDocument(content, resolvedTheme);
  if (fileReaderKind(file) === "markdown") return { content, outline: markdownReaderOutline(content) };
  return { content, outline: [] };
}

export function useOutlineState(prepared: PreparedHtmlDocument) {
  const hasOutline = prepared.outline.length >= 2; const [open, setOpen] = useState(false); const [activeAnchor, setActiveAnchor] = useState<string | null>(null); const [navigationToken, setNavigationToken] = useState(0);
  useEffect(() => { setActiveAnchor(null); setNavigationToken(0); setOpen(hasOutline && (window.matchMedia?.("(min-width: 721px)").matches ?? true)); }, [hasOutline, prepared.content]);
  const select = useCallback((id: string) => { setActiveAnchor(id); setNavigationToken((value) => value + 1); }, []);
  const updateFromScroll = useCallback((id: string | null) => { setActiveAnchor((current) => current === id ? current : id); }, []);
  return { hasOutline, open, setOpen, activeAnchor, navigationToken, select, updateFromScroll };
}
