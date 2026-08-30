import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Bot, Clock, Highlighter, LoaderCircle, Minus, StickyNote, X, Zap } from "lucide-react";
import { api, BASE_PATH, type AgentOptions, type AgentSelection, type ConversationActivity, type ConversationDetail, type ConversationMessagesPage, type Job } from "./api";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection, visibleSelectionBounds, type SelectionRect } from "./ask-agent-selection";
import { ConversationMessageList } from "./conversation/ConversationMessageList";
import { ConversationComposer } from "./conversation/ConversationComposer";
import { formatConversationFullDateTime, formatConversationMessageDateTime } from "./conversation/conversation-format";
import { captureReaderTextAnchor, readerRangeBelongsTo, readerTextAnchorsEqual, restoreReaderTextAnchor, type ReaderTextAnchor } from "./reader/selection-anchor";

export type ReaderSelection = {
  text: string;
  left: number;
  top: number;
  below: boolean;
  /** Stable reader coordinates used by highlights/notes; quote text remains
   * the fallback when a publisher changes its markup. */
  unitId?: string;
  page?: number;
  rects?: Array<{ left: number; top: number; width: number; height: number }>;
  range?: Range;
  /** Stable document position used when a text layer or CSS column is rebuilt. */
  anchor?: ReaderTextAnchor;
};

// Safari owns the native selection and the Cut/Copy/Paste menu. The reader
// observes it, but never treats a DOM Range or a cached rectangle as the
// selection's identity. The durable identity is a text offset anchor; a fresh
// Range is made from that anchor whenever pagination, annotation replay, or a
// text-layer remount changes the view. An ordinary click in the reader is a
// deliberate dismissal boundary; the page/control drag path remains deferred
// so it can still distinguish navigation from a new text selection.
const READER_SELECTION_MOUSE_DELAY_MS = 320;
const READER_SELECTION_TOUCH_DELAY_MS = 350;
const READER_SELECTION_HANDLE_IDLE_DELAY_MS = 450;
const READER_SELECTION_REFRESH_FRAMES = 4;
const READER_SELECTION_CLICK_SEQUENCE_MAX_MS = 2_000;

export function useReaderSelection(rootRef: RefObject<HTMLElement | null>, scopeKey = ""): ReaderSelection | null {
  const [selection, setSelection] = useState<ReaderSelection | null>(null);

  useEffect(() => {
    type SelectionSession = { anchor: ReaderTextAnchor };
    let settleTimer: number | null = null;
    let refreshFrame: number | null = null;
    let refreshAttempt = 0;
    let lastTouchEndAt = 0;
    let restoringNative = false;
    // `click` is the reliable boundary for an ordinary tap/click in a
    // paginated viewport. Keep the selection that existed at pointerdown so
    // a drag which creates a *new* selection is not mistaken for a dismissal
    // when Chromium emits a compatibility click after the drag.
    let pointerDownAt = 0;
    let pointerDownHadReaderSelection = false;
    let pointerDownAnchor: ReaderTextAnchor | null = null;
    let pointerDownTouchInsideSelection = false;
    const sessionRef = { current: null as SelectionSession | null };

    const clearPublished = () => setSelection((current) => current === null ? current : null);
    const cancelSettle = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
    };
    const cancelRefresh = () => {
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      refreshFrame = null;
      refreshAttempt = 0;
    };
    const currentReaderRange = (root: HTMLElement | null): Range | null => {
      if (!root) return null;
      const native = window.getSelection();
      if (!native || native.isCollapsed || native.rangeCount === 0) return null;
      try {
        const range = native.getRangeAt(0);
        return readerRangeBelongsTo(root, range) ? range : null;
      } catch {
        return null;
      }
    };
    const nativeReaderSelection = (root: HTMLElement | null): Selection | null => {
      if (!root) return null;
      const native = window.getSelection();
      if (!native || native.rangeCount === 0) return null;
      const isReaderTextBoundary = (node: Node): boolean => {
        const element = node instanceof Element ? node : node.parentElement;
        if (!element || !root.contains(node)) return false;
        // The outer reader shell also contains the annotation/ask panels. A
        // caret or a selection inside one of those controls is not the native
        // document selection this hook owns and must never be removed while
        // the user is trying to type or interact with the panel.
        if (element.closest(".reader-ask-bubble, .reader-note-editor, .reader-annotations, .reader-reader-controls, input, textarea, select, [contenteditable]")) return false;
        return Boolean(element.closest(".reader-text-container, .file-reader-document"));
      };
      try {
        const range = native.getRangeAt(0);
        // `readerRangeBelongsTo` deliberately requires one text container so
        // the durable anchor cannot span a virtualized page/unit.  Dismissal
        // and effect cleanup are broader: a selection whose two boundaries
        // are in reader text containers (including a cross-page drag that the
        // anchor model cannot persist) is safe to clear, while a chat/browser
        // or reader-panel selection must remain untouched.
        return isReaderTextBoundary(range.startContainer) && isReaderTextBoundary(range.endContainer) ? native : null;
      } catch {
        return null;
      }
    };
    const cloneRange = (range: Range): Range | null => {
      try { return range.cloneRange(); } catch { return null; }
    };
    const clearSession = (clearNative: boolean) => {
      const root = rootRef.current;
      const native = nativeReaderSelection(root);
      sessionRef.current = null;
      cancelSettle();
      cancelRefresh();
      clearPublished();
      if (clearNative && native) native.removeAllRanges();
    };
    const viewportFor = (root: HTMLElement, range?: Range): SelectionRect => {
      // The body shell also contains headers/annotation panels. Clip against
      // the actual scrolling viewport so an off-screen EPUB column or PDF
      // page cannot make the action chip look visible merely because it is
      // still inside the outer shell's rectangle.
      const source = range
        ? range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
        : null;
      const scroller = source?.closest<HTMLElement>(".reader-epub-page-viewport, .reader-pdf-track, .file-preview-scroll") ?? root;
      const bounds = scroller.getBoundingClientRect();
      return {
        left: Math.max(0, bounds.left),
        top: Math.max(0, bounds.top),
        right: Math.min(window.innerWidth, bounds.right),
        bottom: Math.min(window.innerHeight, bounds.bottom),
      };
    };
    const publish = (mode: "current" | "refresh") => {
      const root = rootRef.current;
      if (!root) { clearPublished(); return; }
      let session = sessionRef.current;
      const current = currentReaderRange(root);
      if (!current) {
        // selectionchange is asynchronous in some engines. If a refresh wins
        // the race while the user has already focused another document/input,
        // retire this reader session before it can paint an obsolete chip.
        try {
          const native = window.getSelection();
          if (native?.rangeCount && !readerRangeBelongsTo(root, native.getRangeAt(0))) {
            clearSession(false);
            return;
          }
        } catch {
          clearSession(false);
          return;
        }
      }
      let range: Range | null = null;
      let restored = false;

      // A live reader selection is authoritative whenever it differs from the
      // session.  Normally selectionchange handles this first, but accepting
      // it here too closes the race where a scroll/mutation callback runs in
      // the same turn as a new handle position.
      if (current) {
        const captured = captureReaderTextAnchor(root, current);
        if (captured) {
          if (!session || !readerTextAnchorsEqual(session.anchor, captured)) {
            session = { anchor: captured };
            sessionRef.current = session;
            clearPublished();
          }
          if (mode === "current") range = current;
        } else if (mode === "current") {
          // A newly reported reader range that cannot be represented by the
          // durable model (for example a cross-page selection) must retire the
          // previous session. Otherwise a later scroll could resurrect an
          // obsolete chip over unrelated text. During a refresh we keep the
          // old anchor: renderer commits can transiently detach a boundary,
          // and the next bounded frame can still rebind it.
          clearSession(false);
          return;
        } else {
          clearPublished();
          return;
        }
      }

      if (session) {
        // Always rebuild on a viewport/layout refresh. A connected Range can
        // still have stale/empty geometry after a CSS column compositor turn.
        const rebound = mode === "refresh" || !range
          ? restoreReaderTextAnchor(root, session.anchor)
          : range;
        if (rebound) {
          range = rebound;
          restored = mode === "refresh" || !current;
        }
      }
      if (!session || !range || !readerRangeBelongsTo(root, range)) {
        clearPublished();
        return;
      }

      let rangeRects: DOMRect[];
      try { rangeRects = Array.from(range.getClientRects()); } catch { clearPublished(); return; }
      const visible = visibleSelectionBounds(rangeRects, viewportFor(root, range));
      if (!visible) {
        // The session remains, but the portal is explicitly a viewport view;
        // it must not remain painted at the old coordinates while paging.
        clearPublished();
        return;
      }

      if (restored && !restoringNative && settleTimer === null) {
        try {
          const native = window.getSelection();
          const nativeRange = native && native.rangeCount > 0 ? native.getRangeAt(0) : null;
          const nativeRangeIsReader = nativeRange ? readerRangeBelongsTo(root, nativeRange) : false;
          const nativeAnchor = nativeRange && nativeRangeIsReader && !nativeRange.collapsed
            ? captureReaderTextAnchor(root, nativeRange)
            : null;
          const nativeMatches = Boolean(nativeAnchor && readerTextAnchorsEqual(nativeAnchor, session.anchor));
          // During the short release/handle settle window, leave the browser's
          // native selection entirely alone. Once that window has ended, a
          // missing/collapsed range is the expected off-screen transaction;
          // on a refresh, even a connected reader Range is rebuilt when its
          // durable anchor matches, because CSS multi-column geometry can be
          // stale while the boundary nodes remain connected. A non-reader
          // range (chat/browser chrome) is never clobbered.
          const shouldRestore = !nativeRange
            || (nativeRangeIsReader && (nativeRange.collapsed || !nativeMatches || mode === "refresh"));
          if (shouldRestore) {
            restoringNative = true;
            native?.removeAllRanges();
            native?.addRange(range);
            const releaseGuard = () => { restoringNative = false; };
            if (typeof queueMicrotask === "function") queueMicrotask(releaseGuard);
            else window.setTimeout(releaseGuard, 0);
          }
        } catch {
          // The renderer may replace the text node between the layout read and
          // addRange; the next bounded refresh will retry with a fresh anchor.
          restoringNative = false;
        }
      }

      const viewport = viewportFor(root, range);
      const horizontalInset = Math.min(56, (viewport.right - viewport.left) / 2);
      const left = Math.min(viewport.right - horizontalInset, Math.max(viewport.left + horizontalInset, visible.left + (visible.right - visible.left) / 2));
      const below = viewport.bottom - visible.bottom >= 54;
      const top = below
        ? Math.min(visible.bottom + 8, viewport.bottom - 44)
        : Math.max(visible.top - 8, viewport.top + 44);
      const rects = rangeRects.slice(0, 32).map((item) => ({ left: item.left, top: item.top, width: item.width, height: item.height }));
      let text: string;
      try { text = normalizeAskAgentSelection(range.toString()); } catch {
        // The text layer can be replaced between geometry and text reads.
        // Leave the durable session intact and let the next mutation/frame
        // retry with a range rooted in the new DOM.
        clearPublished();
        return;
      }
      if (!text) { clearPublished(); return; }
      setSelection({
        text: text.slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1), left, top, below,
        unitId: session.anchor.unitId,
        page: session.anchor.page,
        rects,
        range: cloneRange(range) ?? undefined,
        anchor: session.anchor,
      });
    };
    const queueRefresh = () => {
      if (!sessionRef.current || refreshFrame !== null) return;
      refreshAttempt = 0;
      const run = () => {
        refreshFrame = null;
        if (!sessionRef.current) return;
        publish("refresh");
        // A chapter/page can settle over a few layout turns after React or
        // PDF.js commits text. Retry only this bounded burst; scroll/mutation
        // events start a new burst when the user actually returns.
        if (sessionRef.current && refreshAttempt < READER_SELECTION_REFRESH_FRAMES - 1) {
          refreshAttempt += 1;
          refreshFrame = window.requestAnimationFrame(run);
        } else refreshAttempt = 0;
      };
      refreshFrame = window.requestAnimationFrame(run);
    };
    const scheduleSettle = (delay: number) => {
      cancelSettle();
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        if (sessionRef.current) publish("current");
      }, delay);
    };
    const resetPointerDown = () => {
      pointerDownAt = 0;
      pointerDownHadReaderSelection = false;
      pointerDownAnchor = null;
      pointerDownTouchInsideSelection = false;
    };
    const pointerInsideNativeSelection = (event: Event, root: HTMLElement | null): boolean => {
      const pointerType = "pointerType" in event ? String((event as PointerEvent).pointerType || "") : "";
      // Native handle/loupe interaction is browser-owned on touch devices.
      // A DOM click near the selected glyphs must not dismiss that transaction.
      if (pointerType !== "touch" && pointerType !== "pen") return false;
      if (!root || !("clientX" in event) || !("clientY" in event)) return false;
      const native = nativeReaderSelection(root);
      if (!native || native.rangeCount === 0) return false;
      const x = Number((event as PointerEvent).clientX);
      const y = Number((event as PointerEvent).clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      try {
        return Array.from(native.getRangeAt(0).getClientRects()).some((rect) =>
          x >= rect.left - 8 && x <= rect.right + 8
            && y >= rect.top - 8 && y <= rect.bottom + 8,
        );
      } catch {
        return false;
      }
    };
    const isActionTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      const element = target instanceof Element ? target : target.parentElement;
      return Boolean(element?.closest(".reader-selection-actions, .reader-reader-controls"));
    };
    const isReaderNavigationTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      const element = target instanceof Element ? target : target.parentElement;
      return Boolean(element?.closest(".reader-epub-page-viewport, .reader-pdf-track, .reader-text-container, .file-reader-document"));
    };
    const handlePointerDown = (event: Event) => {
      const root = rootRef.current;
      const current = currentReaderRange(root);
      const existing = sessionRef.current;
      const captured = !existing && root && current ? captureReaderTextAnchor(root, current) : null;
      pointerDownAt = Date.now();
      pointerDownHadReaderSelection = Boolean(sessionRef.current || nativeReaderSelection(root));
      pointerDownAnchor = existing?.anchor ?? captured;
      pointerDownTouchInsideSelection = pointerInsideNativeSelection(event, root);
      if (isActionTarget(event.target)) return;
      // On iOS/Android the native handle can dispatch its compatibility
      // pointer event against the document body rather than the text layer.
      // Keep that browser-owned gesture intact; the later click guard uses
      // the same coordinate check, while a tap farther away still dismisses.
      if (pointerDownTouchInsideSelection) return;
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      if (!root || !target || !root.contains(target)) {
        if (sessionRef.current || nativeReaderSelection(root)) clearSession(true);
        resetPointerDown();
        return;
      }
      // Text selection and horizontal paging both begin inside the reader.
      // Let the following click decide whether this was an ordinary tap or a
      // drag/swipe. Other reader chrome (for example an annotation panel) is a
      // real dismissal boundary and can clear immediately.
      if (!isReaderNavigationTarget(target)) clearSession(true);
    };
    const handleReaderClick = (event: Event) => {
      if (isActionTarget(event.target)) {
        resetPointerDown();
        return;
      }
      const root = rootRef.current;
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      if (!root || !target || !root.contains(target)) {
        if (sessionRef.current || nativeReaderSelection(root)) clearSession(true);
        resetPointerDown();
        return;
      }

      const hasRecentPointerDown = pointerDownAt > 0 && Date.now() - pointerDownAt <= READER_SELECTION_CLICK_SEQUENCE_MAX_MS;
      const hadReaderSelection = hasRecentPointerDown ? pointerDownHadReaderSelection : true;
      const previousAnchor = hasRecentPointerDown ? pointerDownAnchor : null;
      const touchInsideSelection = hasRecentPointerDown && pointerDownTouchInsideSelection;
      const current = sessionRef.current;
      const liveRange = previousAnchor ? currentReaderRange(root) : null;
      const liveAnchor = previousAnchor && liveRange ? captureReaderTextAnchor(root, liveRange) : null;
      resetPointerDown();

      // A pointer sequence that started without a reader selection may have
      // just created one by dragging. Leave that new selection alone; the
      // next ordinary click will dismiss it normally.
      if (!hadReaderSelection) return;
      // Likewise, if the anchor changed during the sequence, this is a new
      // selection rather than a click-away from the old one.
      if (previousAnchor && current && !readerTextAnchorsEqual(previousAnchor, current.anchor)) return;
      if (previousAnchor && liveAnchor && !readerTextAnchorsEqual(previousAnchor, liveAnchor)) return;
      // Keep Safari/Chrome touch handles usable when a compatibility click is
      // emitted over the selected glyphs. A tap anywhere else still reaches
      // the dismissal below.
      if (touchInsideSelection) return;

      if (current || nativeReaderSelection(root)) clearSession(true);
    };
    const handleSelectionChange = () => {
      const root = rootRef.current;
      const current = currentReaderRange(root);
      if (current) {
        const captured = root ? captureReaderTextAnchor(root, current) : null;
        if (!captured) { clearSession(false); return; }
        const previous = sessionRef.current;
        if (!previous || !readerTextAnchorsEqual(previous.anchor, captured)) {
          sessionRef.current = { anchor: captured };
          clearPublished();
        }
        scheduleSettle(READER_SELECTION_HANDLE_IDLE_DELAY_MS);
        return;
      }

      // Empty native selections are expected while a paginated source page is
      // detached or while a browser handle transaction is settling. Keep the
      // durable session, hide only the viewport portal, and wait for a refresh
      // event instead of expiring it on a wall-clock grace timer.
      clearPublished();
      const native = window.getSelection();
      if (native && native.rangeCount > 0 && root) {
        try {
          if (!readerRangeBelongsTo(root, native.getRangeAt(0))) clearSession(false);
          else if (sessionRef.current) queueRefresh();
        } catch { clearSession(false); }
      } else if (sessionRef.current) queueRefresh();
    };
    const handleSelectionEnd = (event: Event) => {
      const pointerType = "pointerType" in event ? String((event as PointerEvent).pointerType || "") : "";
      const touch = event.type === "touchend" || event.type === "touchcancel" || pointerType === "touch";
      if (!touch && Date.now() - lastTouchEndAt < READER_SELECTION_TOUCH_DELAY_MS + 120) return;
      if (!sessionRef.current) return;
      if (touch) lastTouchEndAt = Date.now();
      scheduleSettle(touch ? READER_SELECTION_TOUCH_DELAY_MS : READER_SELECTION_MOUSE_DELAY_MS);
    };
    const handleViewportChange = () => queueRefresh();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && sessionRef.current) clearSession(true);
    };
    const root = rootRef.current;
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", handleReaderClick, true);
    window.addEventListener("pointerup", handleSelectionEnd, { passive: true });
    window.addEventListener("touchend", handleSelectionEnd, { passive: true });
    window.addEventListener("mouseup", handleSelectionEnd, { passive: true });
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, { passive: true });
    document.addEventListener("visibilitychange", handleViewportChange);
    document.addEventListener("keydown", handleKeyDown);
    root?.addEventListener("scroll", handleViewportChange, { capture: true, passive: true });
    const mutationObserver = root && typeof MutationObserver !== "undefined" ? new MutationObserver(queueRefresh) : null;
    if (mutationObserver && root) mutationObserver.observe(root, { childList: true, subtree: true });
    const resizeObserver = root && typeof ResizeObserver !== "undefined" ? new ResizeObserver(queueRefresh) : null;
    if (resizeObserver && root) resizeObserver.observe(root);
    if (root) root.querySelectorAll<HTMLElement>(".reader-text-container, .file-reader-document").forEach((container) => resizeObserver?.observe(container));
    return () => {
      // A file/version switch can leave the browser selection pointing at the
      // old document while React reuses the reader shell.  Remove only a
      // selection owned by this reader; an external chat/browser selection is
      // deliberately left untouched.
      const native = nativeReaderSelection(root);
      native?.removeAllRanges();
      sessionRef.current = null;
      cancelSettle();
      cancelRefresh();
      resetPointerDown();
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", handleReaderClick, true);
      window.removeEventListener("pointerup", handleSelectionEnd);
      window.removeEventListener("touchend", handleSelectionEnd);
      window.removeEventListener("mouseup", handleSelectionEnd);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange);
      document.removeEventListener("visibilitychange", handleViewportChange);
      document.removeEventListener("keydown", handleKeyDown);
      root?.removeEventListener("scroll", handleViewportChange, true);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      setSelection(null);
    };
  }, [rootRef, scopeKey]);

  return selection;
}

export function ReaderSelectionAction({ selection, onAsk, onHighlight, onNote, highlighted = false }: { selection: ReaderSelection; onAsk: (text: string) => void; onHighlight?: (selection: ReaderSelection) => void; onNote?: (selection: ReaderSelection) => void; highlighted?: boolean }) {
  const [usedKey, setUsedKey] = useState<string | null>(null);
  const handledKeyRef = useRef<string | null>(null);
  const selectionKey = `${selection.anchor?.unitId ?? ""}:${selection.anchor?.page ?? ""}:${selection.anchor?.startOffset ?? ""}:${selection.anchor?.endOffset ?? ""}:${selection.text}`;
  useEffect(() => setUsedKey(null), [selectionKey]);
  useEffect(() => { handledKeyRef.current = null; }, [selectionKey]);
  const consumeSelection = (action: () => void) => {
    if (handledKeyRef.current === selectionKey) return;
    handledKeyRef.current = selectionKey;
    setUsedKey(selectionKey);
    action();
  };
  if (usedKey === selectionKey) return null;
  const action = <div className={`reader-selection-actions ${selection.below ? "below" : "above"}`} style={{ left: selection.left, top: selection.top }}>
    <button type="button" className="reader-selection-tool reader-selection-action reader-selection-ask" title="询问 Agent" aria-label="询问 Agent" onClick={() => consumeSelection(() => onAsk(selection.text))}><Bot size={14} /></button>
    {onHighlight && <button type="button" className={`reader-selection-tool${highlighted ? " active" : ""}`} title={highlighted ? "取消标记" : "标记"} aria-label={highlighted ? "取消标记选中文字" : "标记选中文字"} onClick={() => consumeSelection(() => onHighlight(selection))}>{highlighted ? <X size={14} /> : <Highlighter size={14} />}</button>}
    {onNote && <button type="button" className="reader-selection-tool" title="添加备注" aria-label="给选中文字添加备注" onClick={() => consumeSelection(() => onNote(selection))}><StickyNote size={14} /></button>}
  </div>;
  // The native Range belongs to Safari. Moving focus to this portal can make
  // WebKit temporarily hide its blue selection, even though the cloned range
  // is still valid for Agent/highlight actions. Paint a non-interactive
  // viewport snapshot until the action is consumed so the selected text never
  // appears to vanish when the chip mounts.
  const previewRects = (selection.rects ?? []).filter((rect) => Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0);
  const preview = previewRects.length > 0 && <div className="reader-selection-preview" aria-hidden="true">
    {previewRects.map((rect, index) => <i key={`${rect.left}:${rect.top}:${index}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}
  </div>;
  // Keep the floating control outside the reader's scrolling/selection DOM.
  // This prevents mounting the chip from becoming a WebKit selection boundary.
  if (typeof document === "undefined") return <>{preview}{action}</>;
  return <>{preview && createPortal(preview, document.body)}{createPortal(action, document.body)}</>;
}

function readerDefaultSelection(options: AgentOptions): AgentSelection {
  const model = options.models.find((candidate) => candidate.id === options.defaults.model) ?? options.models[0];
  return { model: model?.id ?? options.defaults.model, reasoningEffort: model?.reasoningEfforts[0] ?? options.defaults.reasoningEffort };
}

type ReaderPanelGeometry = { left: number; top: number; width: number; height: number };
type ReaderPanelDrag = ReaderPanelGeometry & { pointerId: number; startX: number; startY: number };
type ReaderPanelResize = ReaderPanelGeometry & { pointerId: number; startX: number; startY: number; direction: "top-left" | "bottom-right" };

export function ReaderAskBubble({ conversationId, conversationTitle, quoteExcerpt, quoteLabel, userInitials, open, closing, onClose }: {
  conversationId: string;
  conversationTitle: string;
  quoteExcerpt: string;
  quoteLabel?: string;
  userInitials: string;
  open: boolean;
  closing?: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState("请解读这段文字");
  const [quote, setQuote] = useState(quoteExcerpt);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [pendingQuote, setPendingQuote] = useState("");
  const [voiceIds, setVoiceIds] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [readerVoiceState, setReaderVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [streamingContent, setStreamingContent] = useState("");
  const [activities, setActivities] = useState<Array<{ label?: string; kind?: string; detail?: string; status?: string }>>([]);
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [selection, setSelection] = useState<AgentSelection | null>(null);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [panelGeometry, setPanelGeometry] = useState<ReaderPanelGeometry | null>(null);
  const [flyOffset, setFlyOffset] = useState({ x: 0, y: 0 });
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastJobIdRef = useRef<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelDragRef = useRef<ReaderPanelDrag | null>(null);
  const panelResizeRef = useRef<ReaderPanelResize | null>(null);
  const initialLoadRef = useRef(false);
  const historyInitialisedRef = useRef(false);

  useEffect(() => {
    setQuote(normalizeAskAgentSelection(quoteExcerpt).slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1));
    if (quoteExcerpt.trim()) setComposerCollapsed(false);
  }, [quoteExcerpt]);

  const syncActivity = useCallback((activity: ConversationActivity) => {
    setActivities(activity.jobEvents);
    setDetail((current) => current ? { ...current, ...activity } : current);
  }, []);

  const refreshConversation = useCallback(async () => {
    const value = await api.conversation(conversationId, 20);
    if ("restoring" in value) { setError("历史正在恢复，请稍后再试。"); return null; }
    setDetail(value); syncActivity(value);
    return value;
  }, [conversationId, syncActivity]);

  const connectJob = useCallback((job: Job) => {
    if (lastJobIdRef.current === job.id && eventSourceRef.current?.readyState !== EventSource.CLOSED) return;
    eventSourceRef.current?.close();
    lastJobIdRef.current = job.id;
    const source = new EventSource(`${BASE_PATH}/api/jobs/${job.id}/events`);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      if (eventSourceRef.current !== source) return;
      let data: { type?: string; kind?: string; detail?: string; label?: string; status?: string };
      try { data = JSON.parse(event.data) as typeof data; } catch { return; }
      if (data.type === "replay_complete") return;
      if (data.type === "progress") {
        setActivities((current) => [...current.slice(-29), data]);
        if (data.kind === "assistant_stream" && data.detail) setStreamingContent(data.detail);
      }
      if (data.type === "done" || data.type === "failed") {
        source.close(); eventSourceRef.current = null;
        setStreamingContent("");
        void refreshConversation().then(() => { setPendingQuestion(""); setSubmitting(false); });
      }
    };
    source.onerror = () => { if (eventSourceRef.current === source) void refreshConversation().catch(() => undefined); };
  }, [refreshConversation]);

  const load = useCallback(async () => {
    if (loading) return;
    setLoading(true); setError("");
    try {
      const [conversationValue, options] = await Promise.all([api.conversation(conversationId, 20), api.agentOptions({ conversationId })]);
      if ("restoring" in conversationValue) { setError("历史正在恢复，请稍后再试。"); return; }
      setDetail(conversationValue); syncActivity(conversationValue);
      setAgentOptions(options);
      setSelection(readerDefaultSelection(options));
      if (conversationValue.activeJob) connectJob(conversationValue.activeJob);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法打开当前会话。"); }
    finally { setLoading(false); }
  }, [conversationId, connectJob, loading, syncActivity]);

  useEffect(() => {
    if (!open || initialLoadRef.current) return;
    initialLoadRef.current = true;
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open || loading || !detail || historyInitialisedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = historyRef.current;
      if (container) container.scrollTop = container.scrollHeight;
      historyInitialisedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail, loading, open]);

  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      void api.conversationActivity(conversationId).then((activity) => {
        syncActivity(activity);
        if (activity.activeJob) connectJob(activity.activeJob);
        if (!activity.activeJob && pendingQuestion) void refreshConversation().then(() => { setPendingQuestion(""); setPendingQuote(""); setSubmitting(false); });
      }).catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [connectJob, conversationId, open, pendingQuestion, refreshConversation, syncActivity]);

  async function loadOlder() {
    const page = detail?.messagePage;
    const first = detail?.messages[0];
    if (!page?.hasMore || !page.nextCursor || !first || historyLoading) return;
    const container = historyRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    setHistoryLoading(true);
    try {
      const older = await api.conversationMessages(conversationId, page.nextCursor, 20);
      setDetail((current) => current ? mergeOlderMessages(current, older) : current);
      window.requestAnimationFrame(() => { if (container) container.scrollTop = previousTop + container.scrollHeight - previousHeight; });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更早消息加载失败。"); }
    finally { setHistoryLoading(false); }
  }

  async function send() {
    const message = input.trim();
    if (!message || submitting || !selection) return;
    const submittedQuote = quote;
    setSubmitting(true); setError(""); setPendingQuestion(message); setPendingQuote(submittedQuote); setInput(""); setStreamingContent("");
    window.requestAnimationFrame(() => { const container = historyRef.current; if (container) container.scrollTop = container.scrollHeight; });
    try {
      const result = await api.sendMessage(conversationId, message, files, quote, false, voiceIds, selection);
      // The quoted passage is a one-shot context for this request. Clear it
      // only after the server accepts the message so a failed send can still
      // be retried without losing the user's reference.
      setQuote("");
      setComposerCollapsed(true);
      setFiles([]);
      setVoiceIds([]);
      if (result.job) connectJob(result.job);
      else if (result.activeJob) connectJob(result.activeJob);
      else void api.conversationActivity(conversationId).then((activity) => { syncActivity(activity); if (activity.activeJob) connectJob(activity.activeJob); }).catch(() => undefined);
    } catch (reason) {
      setPendingQuestion(""); setPendingQuote(""); setSubmitting(false); setError(reason instanceof Error ? reason.message : "发送失败，请重试。");
    }
  }

  async function stop() {
    if (!submitting) return;
    try {
      await api.cancelConversation(conversationId);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setPendingQuestion(""); setPendingQuote("");
      setStreamingContent("");
      setSubmitting(false);
      await refreshConversation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止任务失败，请稍后重试。");
    }
  }

  function beginPanelDrag(event: ReactPointerEvent<HTMLElement>) {
    if (closing || event.button !== 0 || window.matchMedia?.("(max-width: 720px)").matches) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button,select,input,textarea,a")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const geometry = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    panelDragRef.current = { ...geometry, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    setPanelGeometry(geometry);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function movePanelDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - drag.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - drag.height - margin);
    setPanelGeometry({
      ...drag,
      left: Math.min(maxLeft, Math.max(margin, drag.left + event.clientX - drag.startX)),
      top: Math.min(maxTop, Math.max(margin, drag.top + event.clientY - drag.startY)),
    });
  }

  function endPanelDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    panelDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function beginPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (closing || event.button !== 0 || window.matchMedia?.("(max-width: 720px)").matches) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const direction = event.currentTarget.dataset.direction === "bottom-right" ? "bottom-right" : "top-left";
    panelResizeRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, direction };
    setPanelGeometry({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function movePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = panelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const minWidth = 360;
    const minHeight = 360;
    const maxWidth = Math.min(760, window.innerWidth - 16);
    const maxHeight = Math.max(minHeight, window.innerHeight - 16);
    if (resize.direction === "bottom-right") {
      const width = Math.min(maxWidth, Math.max(minWidth, resize.width + event.clientX - resize.startX));
      const height = Math.min(maxHeight, Math.max(minHeight, resize.height + event.clientY - resize.startY));
      setPanelGeometry({ left: resize.left, top: resize.top, width, height });
    } else {
      const right = resize.left + resize.width;
      const bottom = resize.top + resize.height;
      const width = Math.min(maxWidth, Math.max(minWidth, resize.width + resize.startX - event.clientX));
      const height = Math.min(maxHeight, Math.max(minHeight, resize.height + resize.startY - event.clientY));
      setPanelGeometry({ left: Math.max(8, right - width), top: Math.max(8, bottom - height), width, height });
    }
    event.preventDefault();
  }

  function endPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = panelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    panelResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function requestClose() {
    const panel = panelRef.current;
    if (!window.matchMedia?.("(max-width: 720px)").matches && panel) {
      const rect = panel.getBoundingClientRect();
      const launcher = document.querySelector<HTMLElement>(".file-reader-ask-launcher");
      const target = launcher?.getBoundingClientRect();
      setFlyOffset({ x: (target?.left ?? 28) - rect.left, y: (target?.top ?? 68) - rect.top });
    }
    onClose();
  }

  const active = Boolean(detail?.activeJob || detail?.externalStatus === "running" || detail?.conversationStatus === "running");
  const visibleMessages = detail?.messages ?? [];

  if (!open) return null;
  const panelStyle = {
    ...(panelGeometry ? { left: `${panelGeometry.left}px`, top: `${panelGeometry.top}px`, width: `${panelGeometry.width}px`, height: `${panelGeometry.height}px`, right: "auto", bottom: "auto" } : {}),
    "--reader-ask-fly-x": `${flyOffset.x}px`,
    "--reader-ask-fly-y": `${flyOffset.y}px`,
  } as CSSProperties;
  return <aside ref={panelRef} className={`reader-ask-bubble${closing ? " closing" : ""}`} style={panelStyle} role="dialog" aria-label={`在会话“${conversationTitle}”中询问 Agent`}>
    <div className="reader-ask-resize-handle reader-ask-resize-handle-top-left" data-direction="top-left" role="separator" aria-label="从左上角调整窗口大小" onPointerDown={beginPanelResize} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize} />
    <div className="reader-ask-resize-handle reader-ask-resize-handle-bottom-right" data-direction="bottom-right" role="separator" aria-label="从右下角调整窗口大小" onPointerDown={beginPanelResize} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize} />
    <header className="reader-ask-header" onPointerDown={beginPanelDrag} onPointerMove={movePanelDrag} onPointerUp={endPanelDrag} onPointerCancel={endPanelDrag}><div className="reader-ask-heading"><Bot size={17} /><div><strong>在当前会话中咨询</strong><small>{conversationTitle}</small></div></div><button type="button" onClick={requestClose} aria-label="返回阅读" title="收起到机器人入口"><ArrowLeft className="reader-ask-mobile-back" size={18} /><Minus className="reader-ask-desktop-close" size={18} /></button></header>
    <div ref={historyRef} className="reader-ask-history" onScroll={(event) => { if (event.currentTarget.scrollTop < 42) void loadOlder(); }}>
      <ConversationMessageList messages={visibleMessages} variant="reader" loading={loading} loadingLabel="正在加载会话上下文…" emptyLabel={<div className="reader-ask-empty">这是当前会话的第一次咨询。<br />你可以直接问这段内容。</div>} userAvatar={userInitials} assistantAvatar={<Zap size={15} />} messageProps={(message) => {
        const scheduled = message.role === "user" && Boolean(message.is_scheduled);
        return {
          avatar: scheduled ? <Clock size={15} /> : message.role === "assistant" ? <Zap size={15} /> : userInitials,
          avatarClassName: scheduled ? "scheduled" : undefined,
          name: scheduled ? "定时任务" : message.role === "assistant" ? "Codex Web" : "你",
          timeLabel: formatConversationMessageDateTime(message.created_at),
          timeTitle: formatConversationFullDateTime(message.created_at),
        };
      }} pendingQuestion={pendingQuestion} pendingQuote={pendingQuote} pendingLabel="正在发送…" streamingContent={streamingContent} progressLabel={active && !streamingContent ? activities.findLast((activity) => activity.label)?.label || "正在处理…" : undefined} beforeMessages={historyLoading ? <div className="reader-ask-history-loading"><LoaderCircle className="spin" size={14} />正在加载更早消息…</div> : null} />
    </div>
    {error && <div className="reader-ask-error-banner" role="alert">{error}</div>}
    <ConversationComposer
      conversationId={conversationId}
      value={input}
      quote={quote.trim() ? quote : undefined}
      reference={quote.trim() ? {
        excerpt: quote,
        kind: "file",
        label: "文件引用",
        title: quoteLabel ? `${quoteLabel}：${quote}` : quote,
      } : undefined}
      files={files}
      model={selection?.model ?? ""}
      reasoningEffort={selection?.reasoningEffort ?? ""}
      agentOptions={agentOptions}
      disabled={loading}
      submitting={submitting}
      collapsed={composerCollapsed}
      canSend={Boolean(input.trim() && selection)}
      className="reader-ask-composer"
      controlsClassName={`reader-ask-bottom-row${readerVoiceState !== "idle" ? " is-voice-active" : ""}`}
      attachmentClassName="reader-ask-attach"
      sendClassName="reader-ask-send"
      voicePanelClassName="reader-ask-voice-panel"
      voiceControlClassName="reader-ask-voice-wrap"
      voiceMicClassName="reader-ask-mic"
      onFocus={() => setComposerCollapsed(false)}
      onChange={(value) => { setComposerCollapsed(false); setInput(value); }}
      onQuoteRemove={() => setQuote("")}
      onFilesChange={setFiles}
      onModelChange={(model) => { const nextModel = agentOptions?.models.find((candidate) => candidate.id === model); if (nextModel) setSelection({ model: nextModel.id, reasoningEffort: nextModel.reasoningEfforts[0] ?? "low" }); }}
      onReasoningChange={(effort) => setSelection((current) => current ? { ...current, reasoningEffort: effort } : current)}
      onSend={() => void send()}
      onStop={() => void stop()}
      onTranscript={(text, id) => { setInput((current) => current ? `${current}${/\s$/.test(current) ? "" : "\n"}${text}` : text); setVoiceIds((current) => [...current, id].slice(-20)); }}
      onVoiceStateChange={setReaderVoiceState}
    />
  </aside>;
}

function mergeOlderMessages(detail: ConversationDetail, page: ConversationMessagesPage): ConversationDetail {
  const known = new Set(detail.messages.map((message) => message.id));
  return { ...detail, messages: [...page.messages.filter((message) => !known.has(message.id)), ...detail.messages], messagePage: page.messagePage };
}
