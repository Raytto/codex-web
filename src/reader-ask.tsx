import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Bot, Clock, Highlighter, LoaderCircle, Minus, StickyNote, Zap } from "lucide-react";
import { api, BASE_PATH, type AgentOptions, type AgentSelection, type ConversationActivity, type ConversationDetail, type ConversationMessagesPage, type Job } from "./api";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection, visibleSelectionBounds, type SelectionRect } from "./ask-agent-selection";
import { ConversationMessageList } from "./conversation/ConversationMessageList";
import { ConversationComposer } from "./conversation/ConversationComposer";
import { formatConversationFullDateTime, formatConversationMessageDateTime } from "./conversation/conversation-format";

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
};

// Safari owns the native selection and the Cut/Copy/Paste menu.  The reader
// only observes selection changes and passive release boundaries, then samples
// a clone of the current Range for the optional Agent action. It must not
// capture touch/pointer starts, call preventDefault on a selection gesture, or
// write a Range back to the browser.
// Those small-looking interventions race WebKit's loupe and selection handles
// on iOS (and the mouse compatibility events on Windows).
const READER_SELECTION_MOUSE_DELAY_MS = 180;
// Give WebKit enough time to finish the native loupe/edit-menu transaction
// before React mounts the optional Agent button.
const READER_SELECTION_TOUCH_DELAY_MS = 1_000;
const READER_SELECTION_HANDLE_IDLE_DELAY_MS = 2_000;
const READER_SELECTION_GRACE_MS = 2_000;

export function useReaderSelection(rootRef: RefObject<HTMLElement | null>): ReaderSelection | null {
  const [selection, setSelection] = useState<ReaderSelection | null>(null);

  useEffect(() => {
    let frame = 0;
    let publishTimer: number | null = null;
    let clearTimer: number | null = null;
    let publishToken = 0;
    let selectionSessionActive = false;
    let lastTouchEndAt = 0;
    let lastSelectionEndAt = 0;
    let lastSelectionEndDelay = 0;
    const stableRangeRef = { current: null as Range | null };
    let stableRangeAt = 0;
    const elementFor = (node: Node | null): Element | null => node instanceof Element ? node : node?.parentElement ?? null;
    const clear = () => setSelection((current) => current === null ? current : null);
    const rangeIsReaderText = (root: HTMLElement, range: Range) => {
      const start = elementFor(range.startContainer)?.closest(".file-reader-document");
      const end = elementFor(range.endContainer)?.closest(".file-reader-document");
      return Boolean(start && start === end && root.contains(start));
    };
    const currentReaderRange = (root: HTMLElement | null): Range | null => {
      if (!root) return null;
      const current = window.getSelection();
      if (!current || current.isCollapsed || current.rangeCount === 0) return null;
      try {
        const range = current.getRangeAt(0);
        return rangeIsReaderText(root, range) ? range : null;
      } catch {
        return null;
      }
    };
    const rememberRange = (range: Range | null) => {
      if (!range) return;
      try {
        stableRangeRef.current = range.cloneRange();
        stableRangeAt = Date.now();
      } catch {
        // The document can be replaced while a file is loading.
      }
    };
    const publish = (fallbackRange: Range | null = null) => {
      const root = rootRef.current;
      const currentRange = currentReaderRange(root);
      const recentFallback = Date.now() - stableRangeAt <= READER_SELECTION_GRACE_MS ? stableRangeRef.current : null;
      const range = currentRange ?? fallbackRange ?? recentFallback;
      if (!root || !range || !rangeIsReaderText(root, range)) {
        selectionSessionActive = false;
        stableRangeRef.current = null;
        stableRangeAt = 0;
        return clear();
      }
      const text = normalizeAskAgentSelection(range.toString());
      if (!text) {
        selectionSessionActive = false;
        return clear();
      }
      rememberRange(range);
      const rootRect = root.getBoundingClientRect();
      const viewport: SelectionRect = {
        left: Math.max(0, rootRect.left),
        top: Math.max(0, rootRect.top),
        right: Math.min(window.innerWidth, rootRect.right),
        bottom: Math.min(window.innerHeight, rootRect.bottom),
      };
      const rect = visibleSelectionBounds(Array.from(range.getClientRects()), viewport);
      // Keep the cloned range and the existing chip for a later scroll/resize;
      // WebKit can briefly return no client rect while it is moving a handle.
      if (!rect) return;
      const horizontalInset = Math.min(56, (viewport.right - viewport.left) / 2);
      const left = Math.min(viewport.right - horizontalInset, Math.max(viewport.left + horizontalInset, rect.left + (rect.right - rect.left) / 2));
      const below = viewport.bottom - rect.bottom >= 54;
      const top = below
        ? Math.min(rect.bottom + 8, viewport.bottom - 44)
        : Math.max(rect.top - 8, viewport.top + 44);
      const anchor = elementFor(range.startContainer)?.closest<HTMLElement>("[data-reader-unit], [data-reader-page]");
      const unitElement = elementFor(range.startContainer)?.closest<HTMLElement>("[data-reader-unit]");
      const pageElement = elementFor(range.startContainer)?.closest<HTMLElement>("[data-reader-page]");
      const rects = Array.from(range.getClientRects()).slice(0, 32).map((item) => ({ left: item.left, top: item.top, width: item.width, height: item.height }));
      cancelClear();
      setSelection({
        text: text.slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1), left, top, below,
        unitId: unitElement?.dataset.readerUnit || anchor?.dataset.readerUnit,
        page: pageElement?.dataset.readerPage ? Number(pageElement.dataset.readerPage) : undefined,
        rects,
        range: range.cloneRange(),
      });
      // The release window has been consumed. A later handle adjustment must
      // start a fresh quiet period instead of being mistaken for the original
      // touch release.
      lastSelectionEndAt = 0;
      lastSelectionEndDelay = 0;
    };
    const cancelPublish = () => {
      publishToken += 1;
      if (publishTimer !== null) window.clearTimeout(publishTimer);
      publishTimer = null;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const cancelClear = () => {
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      clearTimer = null;
    };
    const schedulePublish = (delay: number) => {
      cancelPublish();
      const token = ++publishToken;
      publishTimer = window.setTimeout(() => {
        publishTimer = null;
        if (token !== publishToken) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          if (token !== publishToken) return;
          if (selectionSessionActive) publish();
        });
      }, delay);
    };
    const scheduleClear = (delay: number) => {
      cancelClear();
      clearTimer = window.setTimeout(() => {
        clearTimer = null;
        if (!currentReaderRange(rootRef.current)) {
          selectionSessionActive = false;
          stableRangeRef.current = null;
          stableRangeAt = 0;
          clear();
        }
      }, delay);
    };
    const handleSelectionChange = () => {
      const current = currentReaderRange(rootRef.current);
      if (current) {
        cancelClear();
        selectionSessionActive = true;
        rememberRange(current);
        // A new handle position invalidates the old chip's geometry. Remove
        // only the portal action (never the browser-owned Range) while the
        // handle is moving; the settled publish below will mount a fresh one.
        clear();
        const releaseWindow = lastSelectionEndAt > 0
          && Date.now() - lastSelectionEndAt <= lastSelectionEndDelay + READER_SELECTION_GRACE_MS;
        // iOS handle drags can emit selectionchange without a matching
        // touch/pointer end. The long quiet fallback is only a last resort;
        // it is deliberately much later than the native menu gesture. If a
        // release was just observed, keep its shorter, menu-safe timer.
        if (!releaseWindow) schedulePublish(READER_SELECTION_HANDLE_IDLE_DELAY_MS);
        return;
      }
      if (selectionSessionActive && stableRangeRef.current && Date.now() - stableRangeAt <= READER_SELECTION_GRACE_MS) {
        // WebKit may expose a collapsed range for a short release-time window.
        // Keep the snapshot briefly, but do not render or touch the native
        // selection while that window is open.
        const elapsedSinceRelease = lastSelectionEndAt > 0 ? Date.now() - lastSelectionEndAt : Infinity;
        const releaseWindow = elapsedSinceRelease <= lastSelectionEndDelay + READER_SELECTION_GRACE_MS;
        if (releaseWindow) {
          if (publishTimer === null) schedulePublish(Math.max(60, lastSelectionEndDelay - elapsedSinceRelease));
        } else cancelPublish();
        scheduleClear(READER_SELECTION_GRACE_MS);
      } else {
        cancelPublish();
        selectionSessionActive = false;
        stableRangeRef.current = null;
        stableRangeAt = 0;
        cancelClear();
        clear();
      }
    };
    const handleSelectionEnd = (event: Event) => {
      // These listeners are bubble/passive observers only. In particular, no
      // touch/pointer start or move listener is installed, and this callback
      // never calls preventDefault.
      const pointerType = "pointerType" in event ? String((event as PointerEvent).pointerType || "") : "";
      const touch = event.type === "touchend" || event.type === "touchcancel" || pointerType === "touch";
      // iOS may follow one touchend with a compatibility pointerup/mouseup.
      // Do not let that synthetic mouse boundary shorten the touch settle
      // window that protects the native edit menu.
      if (!touch && Date.now() - lastTouchEndAt < READER_SELECTION_TOUCH_DELAY_MS + 120) return;
      if (!selectionSessionActive) return;
      const endedAt = Date.now();
      if (touch) lastTouchEndAt = endedAt;
      lastSelectionEndAt = endedAt;
      lastSelectionEndDelay = touch ? READER_SELECTION_TOUCH_DELAY_MS : READER_SELECTION_MOUSE_DELAY_MS;
      if (currentReaderRange(rootRef.current)) {
        cancelClear();
        schedulePublish(lastSelectionEndDelay);
      } else if (stableRangeRef.current && Date.now() - stableRangeAt <= READER_SELECTION_GRACE_MS) {
        cancelClear();
        schedulePublish(lastSelectionEndDelay);
      }
    };
    const handleViewportChange = () => {
      // A selection-handle drag can auto-scroll the reader without emitting a
      // touch/pointer end. Do not let that scroll event publish the Agent chip
      // underneath the still-moving native handle.
      if (selectionSessionActive) schedulePublish(READER_SELECTION_HANDLE_IDLE_DELAY_MS);
    };
    const root = rootRef.current;
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("pointerup", handleSelectionEnd, { passive: true });
    window.addEventListener("touchend", handleSelectionEnd, { passive: true });
    window.addEventListener("mouseup", handleSelectionEnd, { passive: true });
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, { passive: true });
    root?.addEventListener("scroll", handleViewportChange, { capture: true, passive: true });
    return () => {
      cancelPublish();
      cancelClear();
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("pointerup", handleSelectionEnd);
      window.removeEventListener("touchend", handleSelectionEnd);
      window.removeEventListener("mouseup", handleSelectionEnd);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange);
      root?.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [rootRef]);

  return selection;
}

export function ReaderSelectionAction({ selection, onAsk, onHighlight, onNote }: { selection: ReaderSelection; onAsk: (text: string) => void; onHighlight?: (selection: ReaderSelection) => void; onNote?: (selection: ReaderSelection) => void }) {
  const [usedText, setUsedText] = useState<string | null>(null);
  const handledTextRef = useRef<string | null>(null);
  useEffect(() => setUsedText(null), [selection.text]);
  useEffect(() => { handledTextRef.current = null; }, [selection.text]);
  const consumeSelection = (action: () => void) => {
    if (handledTextRef.current === selection.text) return;
    handledTextRef.current = selection.text;
    setUsedText(selection.text);
    action();
  };
  if (usedText === selection.text) return null;
  const action = <div className={`reader-selection-actions ${selection.below ? "below" : "above"}`} style={{ left: selection.left, top: selection.top }}>
    <button type="button" className="ask-agent-selection reader-selection-action" onClick={() => consumeSelection(() => onAsk(selection.text))}><Zap size={14} /><span>询问 Agent</span></button>
    {onHighlight && <button type="button" className="reader-selection-tool" title="标记" aria-label="标记选中文字" onClick={() => consumeSelection(() => onHighlight(selection))}><Highlighter size={14} /></button>}
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
  const [voiceIds, setVoiceIds] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [readerVoiceState, setReaderVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [streamingContent, setStreamingContent] = useState("");
  const [activities, setActivities] = useState<Array<{ label?: string; kind?: string; detail?: string; status?: string }>>([]);
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [selection, setSelection] = useState<AgentSelection | null>(null);
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

  useEffect(() => setQuote(normalizeAskAgentSelection(quoteExcerpt).slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1)), [quoteExcerpt]);

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
        if (!activity.activeJob && pendingQuestion) void refreshConversation().then(() => { setPendingQuestion(""); setSubmitting(false); });
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
    setSubmitting(true); setError(""); setPendingQuestion(message); setInput(""); setStreamingContent("");
    window.requestAnimationFrame(() => { const container = historyRef.current; if (container) container.scrollTop = container.scrollHeight; });
    try {
      const result = await api.sendMessage(conversationId, message, files, quote, false, voiceIds, selection);
      setFiles([]);
      setVoiceIds([]);
      if (result.job) connectJob(result.job);
      else if (result.activeJob) connectJob(result.activeJob);
      else void api.conversationActivity(conversationId).then((activity) => { syncActivity(activity); if (activity.activeJob) connectJob(activity.activeJob); }).catch(() => undefined);
    } catch (reason) {
      setPendingQuestion(""); setSubmitting(false); setError(reason instanceof Error ? reason.message : "发送失败，请重试。");
    }
  }

  async function stop() {
    if (!submitting) return;
    try {
      await api.cancelConversation(conversationId);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setPendingQuestion("");
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
      }} pendingQuestion={pendingQuestion} pendingLabel="正在发送…" streamingContent={streamingContent} progressLabel={active && !streamingContent ? activities.findLast((activity) => activity.label)?.label || "正在处理…" : undefined} beforeMessages={historyLoading ? <div className="reader-ask-history-loading"><LoaderCircle className="spin" size={14} />正在加载更早消息…</div> : null} />
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
      canSend={Boolean(input.trim() && selection)}
      className="reader-ask-composer"
      controlsClassName={`reader-ask-bottom-row${readerVoiceState !== "idle" ? " is-voice-active" : ""}`}
      attachmentClassName="reader-ask-attach"
      sendClassName="reader-ask-send"
      voicePanelClassName="reader-ask-voice-panel"
      voiceControlClassName="reader-ask-voice-wrap"
      voiceMicClassName="reader-ask-mic"
      onChange={setInput}
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
