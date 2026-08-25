import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type Dispatch, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive, ArrowLeft, ArrowUp, Bot, Check, ChevronDown, CircleDashed, Clock3, Download, Eye, File as FileIcon, FileImage, FileText, FolderOpen, Gauge, HardDrive,
  Copy, CornerUpLeft, GripVertical, LoaderCircle, LogOut, Menu, Mic, Minus, Monitor, Moon, MoreHorizontal, Paperclip, Pause, Pencil, Plus, Search, Settings2, Share2, Square, Sun,
  Play, RotateCcw, Trash2, TriangleAlert, X, Zap,
} from "lucide-react";
import { api, BASE_PATH, fileThumbnailUrl, fileUrl, resumableUploadEndpoint, resumableUploadHeaders, setCsrf, type AgentOptions, type ComposerDraft, type Conversation, type ConversationActivity, type ConversationDetail, type FileShareState, type Job, type JobEvent, type PendingPrompt, type ReasoningEffort, type Session, type WakePlan, type WorkFile } from "./api";
import { filePreviewIdFromPath, filePreviewUrl, fileReaderKind, isBrowserPreviewable, isLocalMarkdownUrl, publicFilePreviewIdFromPath, resolveMessageFileLink } from "./file-links";
import { sanitizeAgentMarkdown } from "./agent-content";
import { chooseComposerPrimaryAction } from "./composer-action";
import { chooseSelectedConversation, mergeJobEvents } from "./recovery";
import { resolveAccountIdentity } from "./account-identity";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "./chat-font-size";
import { applyThemePreference, readStoredThemePreference, THEME_PREFERENCE_KEY, type ThemePreference } from "./theme";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection, visibleSelectionBounds } from "./ask-agent-selection";
import { mergeMessagePages, preservePrependedScrollTop, resolveUnreadScrollTarget } from "./message-history";
import { resolveScrollFollow } from "./scroll-follow";
import { useAsyncMarkdownMath } from "./markdown-math";
import { buildProcessJournal, isNarrativeActivity } from "./process-journal";
import { formatContextUsage, formatRolloutBytes, shouldWarnAboutRollout } from "./rollout-capacity";
import { recoverBrowserSession } from "./session-recovery";
import { buildSubagentActivity, subagentStatusLabel } from "./subagent-activity";

const SELECTED_CONVERSATION_KEY = "codex-web:selected-conversation";
const COMPOSER_DRAFT_SAVE_DELAY_MS = 1_500;
const COMPOSER_LONG_PRESS_DELAY_MS = 650;
const COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX = 12;
const FILE_READER_MAX_BYTES = 5 * 1024 * 1024;
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 64 * 1024 * 1024;
const RESUMABLE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

type DraftSaveState = "idle" | "unsaved" | "saving" | "saved" | "error";
type DraftUpload = { id: string; name: string; resumable: boolean; progress: number; status: "uploading" | "retrying" | "paused" | "error" };
type TusUploadClient = import("tus-js-client").Upload;
type CachedComposerDraft = { content: string; quoteExcerpt: string; composerDraft: ComposerDraft | null };

function composerDraftSignature(content: string, quoteExcerpt: string): string {
  return `${content}\u0000${quoteExcerpt}`;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const publicPreviewFileId = publicFilePreviewIdFromPath(window.location.pathname);
  const previewFileId = publicPreviewFileId ? null : filePreviewIdFromPath(window.location.pathname);
  const expireSession = useCallback(() => {
    setCsrf();
    setSession({ authenticated: false });
  }, []);
  useEffect(() => {
    if (publicPreviewFileId) return;
    const controller = new AbortController();
    recoverBrowserSession(api.session, { signal: controller.signal }).then((value) => {
      setCsrf(value.csrfToken);
      setSession(value);
      setLoading(false);
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Session recovery failed", error);
    });
    return () => controller.abort();
  }, [publicPreviewFileId]);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    applyThemePreference(themePreference, systemPrefersDark);
    try { window.localStorage.setItem(THEME_PREFERENCE_KEY, themePreference); } catch { /* Storage can be unavailable in private browsing. */ }
  }, [systemPrefersDark, themePreference]);

  if (publicPreviewFileId) return <PublicFilePreviewPage fileId={publicPreviewFileId} />;
  if (loading) return <div className="boot"><div className="brand-mark"><Zap size={20} /></div><LoaderCircle className="spin" /><span>正在恢复登录状态…</span></div>;
  if (!session?.authenticated) return <Login onLogin={(value) => { setCsrf(value.csrfToken); setSession(value); }} />;
  if (previewFileId) return <FilePreviewPage fileId={previewFileId} onSessionExpired={expireSession} />;
  return <Workspace session={session} onLogout={() => { setCsrf(); setSession({ authenticated: false }); }} themePreference={themePreference} onThemePreferenceChange={setThemePreference} />;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { onLogin(await api.login(username, password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setBusy(false); }
  }

  return <main className="login-page">
    <section className="login-card">
      <div className="brand-mark large"><Zap size={25} /></div>
      <div className="login-heading"><h1>Codex Web</h1><p>登录你的私人 Agent 工作站</p></div>
      <form onSubmit={submit}>
        <label>用户名<input autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>密码<input autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : "登录"}</button>
      </form>
      <p className="privacy-note">任务与文件仅在你的本机处理</p>
    </section>
  </main>;
}

function FileReaderContent({ file, content }: {
  file: Pick<WorkFile, "original_name" | "mime_type">;
  content: string;
}) {
  const readerKind = fileReaderKind(file);
  const math = useAsyncMarkdownMath(content);
  if (readerKind === "markdown") return <div className="file-preview-scroll">
    <article className="file-reader-markdown markdown">
      <ReactMarkdown
        remarkPlugins={math.plugins ? [remarkGfm, math.plugins.remarkMath] : [remarkGfm]}
        rehypePlugins={math.plugins ? [[math.plugins.rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]] : []}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ href, children }) => href?.startsWith("#")
            ? <a href={href}>{children}</a>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          img: ({ node: _node, alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" />,
          table: ({ node: _node, ...props }) => <div className="file-reader-table"><table {...props} /></div>,
        }}
      >{math.content}</ReactMarkdown>
    </article>
  </div>;
  if (readerKind === "html") return <iframe
    className="file-reader-html"
    title={file.original_name || "HTML 文件预览"}
    sandbox="allow-popups allow-popups-to-escape-sandbox"
    referrerPolicy="no-referrer"
    srcDoc={content}
  />;
  return null;
}

function FileShareMenu({ file, share, onChange }: { file: WorkFile; share: FileShareState; onChange: (share: FileShareState) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setError("");
    window.requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    const closeEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    document.addEventListener("keydown", closeEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [closeDialog, open]);

  async function enable() {
    setBusy(true); setError("");
    try { onChange((await api.enableFileShare(file.id)).share); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "开启公开分享失败"); }
    finally { setBusy(false); }
  }

  async function disable() {
    if (!window.confirm("关闭后，这个固定链接及其中的图片将立即无法访问。确定关闭吗？")) return;
    setBusy(true); setError("");
    try { onChange((await api.disableFileShare(file.id)).share); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "关闭公开分享失败"); }
    finally { setBusy(false); }
  }

  async function copyLink() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(share.publicUrl);
      else {
        const input = document.createElement("textarea");
        input.value = share.publicUrl;
        input.style.position = "fixed"; input.style.opacity = "0";
        document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch { setError("复制失败，请手动复制链接。"); }
  }

  return <div className="file-preview-share-wrap">
    <button ref={trigger} className={`file-preview-share${open ? " active" : ""}`} type="button" title="公开分享" aria-label="公开分享" aria-haspopup="dialog" aria-expanded={open} aria-controls="file-share-dialog" onClick={() => {
      if (open) closeDialog();
      else { setOpen(true); setError(""); }
    }}>
      <Share2 size={18} /><span>分享</span>
    </button>
    {open && createPortal(<div className="file-share-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section id="file-share-dialog" className="file-share-panel" role="dialog" aria-modal="true" aria-labelledby="file-share-dialog-title">
        <header className="file-share-heading">
          <div className="file-share-titleline"><strong id="file-share-dialog-title">公开分享</strong>{share.enabled && <span>● 已开启</span>}</div>
          <button ref={closeButton} className="file-share-close" type="button" aria-label="关闭分享设置" onClick={closeDialog}><X size={18} /></button>
        </header>
        <p>{share.enabled ? "任何获得链接的人都能查看此文件及其中引用的图片，无需登录。" : "默认保持私有。开启后，任何获得固定链接的人都能查看。"}</p>
        {share.enabled && <input readOnly value={share.publicUrl} aria-label="公开链接" onFocus={(event) => event.currentTarget.select()} />}
        {error && <div className="file-share-error">{error}</div>}
        <div className="file-share-actions">
          {share.enabled
            ? <><button type="button" disabled={busy} onClick={() => void copyLink()}><Copy size={14} />{copied ? "已复制" : "复制链接"}</button><button className="danger" type="button" disabled={busy} onClick={() => void disable()}>{busy ? "正在关闭…" : "关闭分享"}</button></>
            : <button type="button" disabled={busy} onClick={() => void enable()}>{busy ? "正在开启…" : "开启公开分享"}</button>}
        </div>
      </section>
    </div>, document.body)}
  </div>;
}

function FilePreviewPage({ fileId, onSessionExpired }: { fileId: string; onSessionExpired: () => void }) {
  const [file, setFile] = useState<WorkFile | null>(null);
  const [share, setShare] = useState<FileShareState | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const readerKind = file ? fileReaderKind(file) : null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setContent(null);
    void (async () => {
      try {
        const metadata = await api.filePreview(fileId, controller.signal);
        if (controller.signal.aborted) return;
        setFile(metadata.file); setShare(metadata.share);
        if (!fileReaderKind(metadata.file)) { setError("这个文件不支持站内阅读，请下载后打开。"); return; }
        if (metadata.file.size > FILE_READER_MAX_BYTES) {
          setError(`文件大小为 ${formatSize(metadata.file.size)}，超过 5 MB 的移动端在线阅读上限，请直接下载。`); return;
        }
        const text = await api.fileText(metadata.file, controller.signal);
        if (!controller.signal.aborted) setContent(text);
      } catch (reason) {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : "文件读取失败";
        setError(message);
        if (message === "请先登录。") onSessionExpired();
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [fileId, onSessionExpired]);

  useEffect(() => {
    let checking = false;
    async function verifySession() {
      if (checking) return;
      checking = true;
      try {
        const current = await api.session();
        if (!current.authenticated) { setContent(null); setFile(null); onSessionExpired(); }
      } catch { /* A transient network failure must not clear an otherwise valid reader. */ }
      finally { checking = false; }
    }
    const verifyVisibleSession = () => { if (!document.hidden) void verifySession(); };
    const interval = window.setInterval(() => void verifySession(), 60_000);
    window.addEventListener("focus", verifyVisibleSession);
    document.addEventListener("visibilitychange", verifyVisibleSession);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", verifyVisibleSession);
      document.removeEventListener("visibilitychange", verifyVisibleSession);
    };
  }, [onSessionExpired]);

  const download = file ? fileUrl(file, true) : "";
  return <main className={`file-preview-page ${readerKind ?? ""}`}>
    <header className="file-preview-header">
      <a className="file-preview-back" href={BASE_PATH || "/"} title="返回工作站"><ArrowLeft size={18} /><span>工作站</span></a>
      <div className="file-preview-title"><FileText size={18} /><strong>{file?.original_name || "正在读取文件…"}</strong></div>
      <div className="file-preview-actions">
        {file && share && <FileShareMenu file={file} share={share} onChange={setShare} />}
        {file && <a className="file-preview-download" href={download} download={file.original_name} title="下载原文件" aria-label={`下载 ${file.original_name}`}><Download size={18} /><span>下载</span></a>}
      </div>
    </header>
    <section className="file-preview-body">
      {loading && <div className="file-preview-state"><LoaderCircle className="spin" size={24} /><p>正在安全读取原文件…</p></div>}
      {!loading && error && <div className="file-preview-state error"><FileText size={28} /><strong>暂时无法在线阅读</strong><p>{error}</p>{file && <a href={download} download={file.original_name}>下载原文件</a>}</div>}
      {!loading && !error && content !== null && file && <FileReaderContent file={file} content={content} />}
    </section>
  </main>;
}

function PublicFilePreviewPage({ fileId }: { fileId: string }) {
  const viewId = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [file, setFile] = useState<Pick<WorkFile, "id" | "original_name" | "mime_type" | "size" | "kind"> | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const readerKind = file ? fileReaderKind(file) : null;

  useEffect(() => {
    const controller = new AbortController();
    void api.publicFilePreview(fileId, viewId.current, controller.signal)
      .then((preview) => { setFile(preview.file); setContent(preview.content); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "公开文件读取失败"))
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fileId]);

  useEffect(() => {
    let checking = false;
    async function verify() {
      if (checking || !content) return;
      checking = true;
      try { await api.verifyPublicFileShare(fileId); }
      catch (reason) { setContent(null); setError(reason instanceof Error ? reason.message : "公开分享已关闭。"); }
      finally { checking = false; }
    }
    const verifyVisible = () => { if (!document.hidden) void verify(); };
    const interval = window.setInterval(() => void verify(), 60_000);
    window.addEventListener("focus", verifyVisible);
    document.addEventListener("visibilitychange", verifyVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", verifyVisible);
      document.removeEventListener("visibilitychange", verifyVisible);
    };
  }, [content, fileId]);

  return <main className={`file-preview-page public ${readerKind ?? ""}`}>
    <header className="file-preview-header public">
      <div className="file-preview-title"><FileText size={18} /><strong>{file?.original_name || "公开文件"}</strong></div>
    </header>
    <section className="file-preview-body">
      {loading && <div className="file-preview-state"><LoaderCircle className="spin" size={24} /><p>正在读取公开文件…</p></div>}
      {!loading && error && <div className="file-preview-state error"><FileText size={28} /><strong>暂时无法在线阅读</strong><p>{error}</p></div>}
      {!loading && !error && content !== null && file && <FileReaderContent file={file} content={content} />}
    </section>
  </main>;
}

function Workspace({ session, onLogout, themePreference, onThemePreferenceChange }: { session: Session; onLogout: () => void; themePreference: ThemePreference; onThemePreferenceChange: (preference: ThemePreference) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => window.localStorage.getItem(SELECTED_CONVERSATION_KEY));
  const [conversationSelectionReady, setConversationSelectionReady] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [askAgentQuote, setAskAgentQuote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null);
  const [draftUploads, setDraftUploads] = useState<DraftUpload[]>([]);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [editingPending, setEditingPending] = useState<PendingPrompt | null>(null);
  const [removedEditingFileIds, setRemovedEditingFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [activities, setActivities] = useState<JobEvent[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [taskMenu, setTaskMenu] = useState<{ conversationId: string; top: number; left: number } | null>(null);
  const [archivedDialogOpen, setArchivedDialogOpen] = useState(false);
  const [wakeDialogConversation, setWakeDialogConversation] = useState<Conversation | null>(null);
  const [archivedConversations, setArchivedConversations] = useState<Conversation[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [chatFontSize, setChatFontSize] = useState(() => normalizeChatFontSize(session.chatFontSize, CHAT_FONT_SIZE_DEFAULT));
  const [fontSizeSaving, setFontSizeSaving] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const prependScrollRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const unreadScrollTargetRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const connectedJobRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const detailRef = useRef<ConversationDetail | null>(detail);
  const editingPendingRef = useRef<PendingPrompt | null>(editingPending);
  const lastEventIdRef = useRef(0);
  const lastEventJobRef = useRef<string | null>(null);
  const inputRef = useRef(input);
  const askAgentQuoteRef = useRef(askAgentQuote);
  const composerDraftRef = useRef<ComposerDraft | null>(composerDraft);
  const draftUploadsRef = useRef<DraftUpload[]>(draftUploads);
  const draftUploadControllersRef = useRef(new Map<string, AbortController>());
  const draftTusUploadsRef = useRef(new Map<string, TusUploadClient>());
  const cancelledDraftUploadIdsRef = useRef(new Set<string>());
  const draftLoadedConversationRef = useRef<string | null>(null);
  const draftCacheRef = useRef(new Map<string, CachedComposerDraft>());
  const draftSyncedSignaturesRef = useRef(new Map<string, string>());
  const draftMutationGenerationRef = useRef(new Map<string, number>());
  const draftSaveTimerRef = useRef<number | null>(null);
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const creatingConversationRef = useRef(false);
  const queryRef = useRef(query);
  selectedIdRef.current = selectedId;
  detailRef.current = detail;
  editingPendingRef.current = editingPending;
  inputRef.current = input;
  askAgentQuoteRef.current = askAgentQuote;
  composerDraftRef.current = composerDraft;
  draftUploadsRef.current = draftUploads;
  queryRef.current = query;

  function askAgentAbout(selectedText: string) {
    const normalized = normalizeAskAgentSelection(selectedText);
    if (!normalized) return;
    setAskAgentQuote(normalized.slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1));
    setComposerFocusRequest((request) => request + 1);
  }

  const refreshList = useCallback(async (search = queryRef.current) => {
    const result = await api.conversations(search);
    let conversations = result.conversations;
    const selected = selectedIdRef.current;
    if (selected && !conversations.some((conversation) => conversation.id === selected)) {
      const retained = detailRef.current?.conversation.id === selected ? detailRef.current.conversation : null;
      if (retained) conversations = [...conversations, retained];
    }
    setConversations(conversations);
    return conversations;
  }, []);

  const syncConversation = useCallback((conversation: Conversation) => {
    setConversations((current) => current.map((item) => item.id === conversation.id ? conversation : item));
    setDetail((current) => current?.conversation.id === conversation.id ? { ...current, conversation } : current);
  }, []);

  const persistComposerDraft = useCallback((conversationId: string, content: string, quoteExcerpt: string, keepalive = false) => {
    const signature = composerDraftSignature(content, quoteExcerpt);
    const operation = draftSaveQueueRef.current.catch(() => undefined).then(async () => {
      if (selectedIdRef.current === conversationId && !editingPendingRef.current) setDraftSaveState("saving");
      const result = await api.saveConversationDraft(conversationId, content, quoteExcerpt, keepalive && new Blob([content, quoteExcerpt]).size < 60_000);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      draftSyncedSignaturesRef.current.set(conversationId, signature);
      const cached = draftCacheRef.current.get(conversationId);
      if (cached) draftCacheRef.current.set(conversationId, { ...cached, composerDraft: result.composerDraft });
      if (selectedIdRef.current === conversationId && !editingPendingRef.current) {
        composerDraftRef.current = result.composerDraft;
        setComposerDraft(result.composerDraft);
        setDraftSaveState(composerDraftSignature(inputRef.current, askAgentQuoteRef.current) === signature ? "saved" : "unsaved");
      }
    }).catch((reason) => {
      if (selectedIdRef.current === conversationId && !editingPendingRef.current) setDraftSaveState("error");
      throw reason;
    });
    draftSaveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, []);

  const applyActivitySnapshot = useCallback((id: string, snapshot: ConversationActivity, hydrated: boolean) => {
    if (selectedIdRef.current !== id) return;
    setJob(snapshot.activeJob);
    setSending(Boolean(snapshot.activeJob));
    setActivities(mergeJobEvents([], snapshot.jobEvents));
    const eventJobId = snapshot.activeJob?.id ?? snapshot.latestJob?.id ?? null;
    lastEventJobRef.current = eventJobId;
    lastEventIdRef.current = snapshot.jobEvents.at(-1)?.seq ?? 0;
    if (hydrated || !snapshot.activeJob) setActivitiesLoading(false);
  }, []);

  const refreshActivity = useCallback(async (id: string) => {
    const snapshot = await api.conversationActivity(id);
    applyActivitySnapshot(id, snapshot, true);
    return snapshot;
  }, [applyActivitySnapshot]);

  const refreshDetail = useCallback(async (id: string) => {
    const draftGenerationAtRequest = draftMutationGenerationRef.current.get(id) ?? 0;
    let result = await api.conversation(id);
    if (selectedIdRef.current !== id) return result;
    const unreadAnchorMessageId = result.conversation.has_unread_result
      ? result.conversation.unread_anchor_message_id
      : null;
    let preparedUnreadHistory = false;
    let unreadScrollTargetMessageId = unreadAnchorMessageId
      ? resolveUnreadScrollTarget(result.messages, unreadAnchorMessageId, result.messagePage.hasMore)
      : null;
    while (unreadAnchorMessageId && !unreadScrollTargetMessageId && result.messagePage.hasMore && result.messagePage.nextCursor) {
      const older = await api.conversationMessages(id, result.messagePage.nextCursor);
      if (selectedIdRef.current !== id) return result;
      result = { ...result, messages: mergeMessagePages(older.messages, result.messages), messagePage: older.messagePage };
      preparedUnreadHistory = true;
      unreadScrollTargetMessageId = resolveUnreadScrollTarget(result.messages, unreadAnchorMessageId, result.messagePage.hasMore);
    }
    if (unreadScrollTargetMessageId) {
      unreadScrollTargetRef.current = { conversationId: id, messageId: unreadScrollTargetMessageId };
      autoFollowRef.current = false;
      preparedUnreadHistory = true;
    }
    if (result.conversation.has_unread_result) {
      try {
        const seen = await api.markConversationSeen(id);
        result = { ...result, conversation: seen.conversation };
        syncConversation(seen.conversation);
      } catch {
        // Viewing the task must still work if the acknowledgement request is temporarily unavailable.
      }
    }
    setDetail((current) => current?.conversation.id === id
      ? {
          ...result,
          messages: mergeMessagePages(current.messages, result.messages),
          messagePage: preparedUnreadHistory ? result.messagePage : current.messagePage,
        }
      : result);
    setSelectedModel(result.agentSelection.model);
    setReasoningEffort(result.agentSelection.reasoningEffort);
    applyActivitySnapshot(id, { activeJob: result.activeJob, latestJob: result.latestJob, jobEvents: result.jobEvents }, false);
    if (result.editingPrompt) {
      composerDraftRef.current = result.composerDraft;
      setComposerDraft(result.composerDraft);
      const cachedDraft = draftCacheRef.current.get(id);
      if (cachedDraft) draftCacheRef.current.set(id, { ...cachedDraft, composerDraft: result.composerDraft });
      if (editingPendingRef.current?.id !== result.editingPrompt.id) {
        editingPendingRef.current = result.editingPrompt;
        setEditingPending(result.editingPrompt);
        setRemovedEditingFileIds([]);
        setFiles([]);
        setInput(result.editingPrompt.content);
        setAskAgentQuote(result.editingPrompt.quote_excerpt ?? "");
      }
    } else {
      const wasEditing = Boolean(editingPendingRef.current);
      if (wasEditing) {
        editingPendingRef.current = null;
        setEditingPending(null);
        setRemovedEditingFileIds([]);
        draftLoadedConversationRef.current = null;
      }
      const cached = draftCacheRef.current.get(id);
      const shouldRestore = wasEditing || draftLoadedConversationRef.current !== id;
      if (shouldRestore) {
        const cachedSignature = cached ? composerDraftSignature(cached.content, cached.quoteExcerpt) : undefined;
        const cachedIsDirty = Boolean(cached && cachedSignature !== draftSyncedSignaturesRef.current.get(id));
        const restored = cachedIsDirty ? cached! : {
          content: result.composerDraft?.content ?? "",
          quoteExcerpt: result.composerDraft?.quote_excerpt ?? "",
          composerDraft: result.composerDraft,
        };
        draftLoadedConversationRef.current = id;
        composerDraftRef.current = restored.composerDraft;
        setComposerDraft(restored.composerDraft);
        setInput(restored.content);
        setAskAgentQuote(restored.quoteExcerpt);
        setFiles([]);
        draftCacheRef.current.set(id, restored);
        if (!cachedIsDirty) draftSyncedSignaturesRef.current.set(id, composerDraftSignature(restored.content, restored.quoteExcerpt));
        setDraftSaveState(cachedIsDirty ? "unsaved" : restored.composerDraft ? "saved" : "idle");
      } else {
        const localSignature = composerDraftSignature(inputRef.current, askAgentQuoteRef.current);
        const syncedSignature = draftSyncedSignaturesRef.current.get(id);
        const serverContent = result.composerDraft?.content ?? "";
        const serverQuote = result.composerDraft?.quote_excerpt ?? "";
        const serverSignature = composerDraftSignature(serverContent, serverQuote);
        const responseIsStale = (draftMutationGenerationRef.current.get(id) ?? 0) !== draftGenerationAtRequest;
        const serverDraft = responseIsStale ? composerDraftRef.current : result.composerDraft;
        composerDraftRef.current = serverDraft;
        setComposerDraft(serverDraft);
        if (!responseIsStale && localSignature === syncedSignature && serverSignature !== syncedSignature) {
          setInput(serverContent);
          setAskAgentQuote(serverQuote);
          draftSyncedSignaturesRef.current.set(id, serverSignature);
          draftCacheRef.current.set(id, { content: serverContent, quoteExcerpt: serverQuote, composerDraft: serverDraft });
          setDraftSaveState(serverDraft ? "saved" : "idle");
        } else {
          const current = draftCacheRef.current.get(id);
          if (current) draftCacheRef.current.set(id, { ...current, composerDraft: serverDraft });
        }
      }
    }
    lastEventIdRef.current = result.jobEvents.at(-1)?.seq ?? 0;
    if (["failed", "interrupted"].includes(result.latestJob?.status ?? "") && !result.latestJob?.error) {
      setError(result.jobEvents.findLast((event) => event.message)?.message || "任务处理失败");
    }
    return result;
  }, [applyActivitySnapshot, syncConversation]);

  useEffect(() => {
    void refreshList().then((items) => {
      const next = chooseSelectedConversation(selectedIdRef.current, items);
      if (next !== selectedIdRef.current) { selectedIdRef.current = next; setSelectedId(next); }
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "任务列表加载失败"))
      .finally(() => setConversationSelectionReady(true));
  }, [refreshList]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshList(query).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "任务搜索失败");
    }), query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [query, refreshList]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshList().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshList]);
  useEffect(() => {
    window.localStorage.removeItem("codex-web:model");
    window.localStorage.removeItem("codex-web:reasoning");
    void api.agentOptions().then((options) => {
      setAgentOptions(options);
      if (!selectedIdRef.current) {
        setSelectedModel(options.selection.model);
        setReasoningEffort(options.selection.reasoningEffort);
      }
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "模型选项加载失败"));
  }, []);
  useEffect(() => {
    autoFollowRef.current = true;
    lastScrollTopRef.current = 0;
    loadingOlderMessagesRef.current = false;
    prependScrollRestoreRef.current = null;
    unreadScrollTargetRef.current = null;
    setLoadingOlderMessages(false);
    if (!selectedId) {
      window.localStorage.removeItem(SELECTED_CONVERSATION_KEY);
      eventSourceRef.current?.close(); connectedJobRef.current = null;
      setDetail(null); setJob(null); setSending(false); setActivities([]); setActivitiesLoading(false);
      setEditingPending(null); setRemovedEditingFileIds([]); setAskAgentQuote("");
      composerDraftRef.current = null; setComposerDraft(null); setDraftUploads([]); setDraftSaveState("idle");
      draftLoadedConversationRef.current = null;
      if (agentOptions) {
        setSelectedModel(agentOptions.selection.model);
        setReasoningEffort(agentOptions.selection.reasoningEffort);
      }
      return;
    }
    window.localStorage.setItem(SELECTED_CONVERSATION_KEY, selectedId);
    eventSourceRef.current?.close(); connectedJobRef.current = null; lastEventJobRef.current = null; lastEventIdRef.current = 0; setActivities([]); setActivitiesLoading(true);
    editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]); setFiles([]); setDraftUploads([]);
    const cached = draftCacheRef.current.get(selectedId);
    draftLoadedConversationRef.current = cached ? selectedId : null;
    composerDraftRef.current = cached?.composerDraft ?? null;
    setComposerDraft(cached?.composerDraft ?? null);
    setInput(cached?.content ?? "");
    setAskAgentQuote(cached?.quoteExcerpt ?? "");
    setDraftSaveState(cached ? "unsaved" : "idle");
    void reconcile(selectedId);
    setSidebarOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId || editingPending || draftLoadedConversationRef.current !== selectedId) return;
    const signature = composerDraftSignature(input, askAgentQuote);
    draftCacheRef.current.set(selectedId, { content: input, quoteExcerpt: askAgentQuote, composerDraft: composerDraftRef.current });
    if (signature === draftSyncedSignaturesRef.current.get(selectedId)) {
      setDraftSaveState(composerDraftRef.current ? "saved" : "idle");
      return;
    }
    setDraftSaveState("unsaved");
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      void persistComposerDraft(selectedId, input, askAgentQuote).catch(() => undefined);
    }, COMPOSER_DRAFT_SAVE_DELAY_MS);
    return () => {
      if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    };
  }, [askAgentQuote, editingPending, input, persistComposerDraft, selectedId]);
  useEffect(() => () => {
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    const conversationId = selectedId;
    if (!conversationId || editingPendingRef.current || draftLoadedConversationRef.current !== conversationId) return;
    const content = inputRef.current;
    const quoteExcerpt = askAgentQuoteRef.current;
    if (composerDraftSignature(content, quoteExcerpt) !== draftSyncedSignaturesRef.current.get(conversationId)) {
      void persistComposerDraft(conversationId, content, quoteExcerpt, true).catch(() => undefined);
    }
  }, [persistComposerDraft, selectedId]);
  useEffect(() => {
    const resume = () => { if (selectedIdRef.current) void reconcile(selectedIdRef.current); };
    const visible = () => {
      if (document.visibilityState === "visible") return resume();
      const conversationId = selectedIdRef.current;
      if (!conversationId || editingPendingRef.current || draftLoadedConversationRef.current !== conversationId) return;
      const content = inputRef.current;
      const quoteExcerpt = askAgentQuoteRef.current;
      if (composerDraftSignature(content, quoteExcerpt) !== draftSyncedSignaturesRef.current.get(conversationId)) {
        void persistComposerDraft(conversationId, content, quoteExcerpt, true).catch(() => undefined);
      }
    };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visible);
      eventSourceRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistComposerDraft]);
  useLayoutEffect(() => {
    const unreadTarget = unreadScrollTargetRef.current;
    if (unreadTarget && detail?.conversation.id === unreadTarget.conversationId) {
      const messages = messagesRef.current;
      const target = messages
        ? Array.from(messages.querySelectorAll<HTMLElement>("[data-message-id]")).find((element) => element.dataset.messageId === unreadTarget.messageId)
        : undefined;
      if (messages && target) {
        unreadScrollTargetRef.current = null;
        prependScrollRestoreRef.current = null;
        const messagesTop = messages.getBoundingClientRect().top;
        const targetTop = target.getBoundingClientRect().top;
        messages.scrollTop = Math.max(0, messages.scrollTop + targetTop - messagesTop - 12);
        lastScrollTopRef.current = messages.scrollTop;
        autoFollowRef.current = false;
        return;
      }
    }
    const restore = prependScrollRestoreRef.current;
    if (!restore) return;
    prependScrollRestoreRef.current = null;
    const messages = messagesRef.current;
    if (!messages) return;
    messages.scrollTop = preservePrependedScrollTop(restore.scrollTop, restore.scrollHeight, messages.scrollHeight);
    lastScrollTopRef.current = messages.scrollTop;
    autoFollowRef.current = false;
  }, [detail?.messages.length]);
  useEffect(() => {
    if (!autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const messages = messagesRef.current;
      if (!messages || !autoFollowRef.current) return;
      messages.scrollTop = messages.scrollHeight;
      lastScrollTopRef.current = messages.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail?.messages.length, activities, sending]);

  function handleMessagesScroll(event: React.UIEvent<HTMLDivElement>) {
    const messages = event.currentTarget;
    const scrollingUp = messages.scrollTop < lastScrollTopRef.current - 1;
    autoFollowRef.current = resolveScrollFollow({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      following: autoFollowRef.current,
    });
    lastScrollTopRef.current = messages.scrollTop;
    if (scrollingUp && messages.scrollTop <= 80) void loadOlderMessages();
  }

  async function loadOlderMessages() {
    const current = detail;
    const conversationId = current?.conversation.id;
    const before = current?.messagePage.nextCursor;
    if (!conversationId || !current.messagePage.hasMore || !before || loadingOlderMessagesRef.current) return;
    loadingOlderMessagesRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const result = await api.conversationMessages(conversationId, before);
      if (selectedIdRef.current !== conversationId) return;
      const messages = messagesRef.current;
      prependScrollRestoreRef.current = messages
        ? { scrollTop: messages.scrollTop, scrollHeight: messages.scrollHeight }
        : null;
      setDetail((latest) => latest?.conversation.id === conversationId
        ? {
            ...latest,
            messages: mergeMessagePages(result.messages, latest.messages),
            messagePage: result.messagePage,
          }
        : latest);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早消息加载失败");
    } finally {
      loadingOlderMessagesRef.current = false;
      if (selectedIdRef.current === conversationId) setLoadingOlderMessages(false);
    }
  }

  function connectJob(activeJob: Job) {
    if (connectedJobRef.current === activeJob.id && eventSourceRef.current?.readyState !== EventSource.CLOSED) {
      setActivitiesLoading(false);
      return;
    }
    eventSourceRef.current?.close();
    connectedJobRef.current = activeJob.id;
    setJob(activeJob); setSending(true);
    const after = lastEventJobRef.current === activeJob.id ? lastEventIdRef.current : 0;
    lastEventJobRef.current = activeJob.id;
    const source = new EventSource(`${BASE_PATH}/api/jobs/${activeJob.id}/events${after ? `?after=${after}` : ""}`);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      if (eventSourceRef.current !== source || selectedIdRef.current !== activeJob.conversation_id) return;
      const data = JSON.parse(event.data) as JobEvent;
      const seq = Number(event.lastEventId || data.seq || 0);
      const stored = { ...data, seq };
      if (data.type === "replay_complete") {
        setActivitiesLoading(false);
        return;
      }
      if (seq) {
        lastEventJobRef.current = activeJob.id;
        lastEventIdRef.current = Math.max(lastEventIdRef.current, seq);
      }
      if (data.type && ["status", "progress"].includes(data.type)) setActivities((previous) => mergeJobEvents(previous, [stored]));
      if (data.type && ["done", "failed"].includes(data.type)) {
        setActivitiesLoading(false);
        source.close(); connectedJobRef.current = null;
        if (data.type === "failed" && !data.message) setError("任务处理失败");
        void reconcile(activeJob.conversation_id);
      }
    };
    source.onerror = () => {
      if (eventSourceRef.current === source && selectedIdRef.current === activeJob.conversation_id) {
        window.setTimeout(() => void reconcile(activeJob.conversation_id), 250);
      }
    };
  }

  async function reconcile(id: string) {
    try {
      const [value] = await Promise.all([refreshDetail(id), refreshList()]);
      if (selectedIdRef.current !== id) return;
      const activity = await refreshActivity(id);
      if (selectedIdRef.current !== id) return;
      syncConversation(value.conversation);
      if (activity.activeJob) connectJob(activity.activeJob);
      else {
        eventSourceRef.current?.close(); eventSourceRef.current = null; connectedJobRef.current = null;
        setSending(false); setJob(null);
      }
    } catch (reason) {
      if (selectedIdRef.current !== id) return;
      const items = await refreshList().catch(() => [] as Conversation[]);
      if (!items.some((conversation) => conversation.id === id)) {
        window.localStorage.removeItem(SELECTED_CONVERSATION_KEY);
        setSelectedId(chooseSelectedConversation(null, items));
      } else {
        setError(reason instanceof Error ? reason.message : "状态刷新失败");
      }
    }
  }

  async function newConversation() {
    if (creatingConversationRef.current) return;
    creatingConversationRef.current = true;
    setError("");
    try {
      const result = await api.createConversation();
      setSelectedModel(result.agentSelection.model); setReasoningEffort(result.agentSelection.reasoningEffort);
      selectedIdRef.current = result.conversation.id;
      await refreshList();
      setSelectedId(result.conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新任务创建失败");
    } finally {
      creatingConversationRef.current = false;
    }
  }

  async function mergeCompletedDraftUpload(conversationId: string, upload: DraftUpload, result: { composerDraft: ComposerDraft; uploadedFiles: WorkFile[] }) {
    if (cancelledDraftUploadIdsRef.current.has(upload.id)) {
      await Promise.all(result.uploadedFiles.map((uploadedFile) => api.deleteConversationDraftFile(conversationId, uploadedFile.id)));
      return;
    }
    draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
    const mergeUpload = (current: ComposerDraft | null): ComposerDraft => current ? {
      ...current,
      files: [...current.files, ...result.uploadedFiles.filter((uploadedFile) => !current.files.some((file) => file.id === uploadedFile.id))],
      updated_at: result.composerDraft.updated_at,
    } : result.composerDraft;
    if (selectedIdRef.current === conversationId && !editingPendingRef.current) {
      const merged = mergeUpload(composerDraftRef.current);
      composerDraftRef.current = merged;
      setComposerDraft(merged);
    }
    const cached = draftCacheRef.current.get(conversationId);
    const cachedDraft = mergeUpload(cached?.composerDraft ?? null);
    if (cached) draftCacheRef.current.set(conversationId, { ...cached, composerDraft: cachedDraft });
    else draftCacheRef.current.set(conversationId, {
      content: conversationId === selectedIdRef.current ? inputRef.current : result.composerDraft.content,
      quoteExcerpt: conversationId === selectedIdRef.current ? askAgentQuoteRef.current : result.composerDraft.quote_excerpt ?? "",
      composerDraft: cachedDraft,
    });
    if (selectedIdRef.current === conversationId) {
      const currentSignature = composerDraftSignature(inputRef.current, askAgentQuoteRef.current);
      setDraftSaveState(currentSignature === draftSyncedSignaturesRef.current.get(conversationId) ? "saved" : "unsaved");
    }
  }

  async function startResumableComposerUpload(conversationId: string, file: File, upload: DraftUpload) {
    let TusUpload: typeof import("tus-js-client").Upload;
    try {
      ({ Upload: TusUpload } = await import("tus-js-client"));
    } catch (reason) {
      setDraftUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "error" } : item));
      setError(reason instanceof Error ? reason.message : "无法加载断点续传组件，请检查网络后重试");
      return;
    }
    const client = new TusUpload(file, {
      endpoint: resumableUploadEndpoint(),
      chunkSize: RESUMABLE_UPLOAD_CHUNK_BYTES,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000, 20_000],
      removeFingerprintOnSuccess: true,
      storeFingerprintForResuming: true,
      headers: resumableUploadHeaders(),
      metadata: { filename: file.name, filetype: file.type || "application/octet-stream", conversationId },
      fingerprint: () => Promise.resolve(["codex-web", conversationId, file.name, file.type, file.size, file.lastModified].join("-")),
      onProgress(bytesUploaded, bytesTotal) {
        const progress = bytesTotal > 0 ? bytesUploaded / bytesTotal : 0;
        setDraftUploads((current) => current.map((item) => item.id === upload.id ? { ...item, progress, status: "uploading" } : item));
      },
      onShouldRetry(reason, retryAttempt) {
        if (cancelledDraftUploadIdsRef.current.has(upload.id)) return false;
        const status = (reason as { originalResponse?: { getStatus?: () => number } }).originalResponse?.getStatus?.();
        if (status && status < 500 && status !== 409 && status !== 423 && status !== 429) return false;
        setDraftUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "retrying" } : item));
        return retryAttempt < 6;
      },
      onError(reason) {
        if (cancelledDraftUploadIdsRef.current.has(upload.id)) return;
        setDraftUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "error" } : item));
        setError(reason instanceof Error ? reason.message : "草稿附件断点续传失败，可点击继续重试");
      },
      onSuccess() {
        void (async () => {
          try {
            if (!client.url) throw new Error("服务器没有返回上传资源地址");
            const result = await api.resumableUploadResult(client.url);
            await mergeCompletedDraftUpload(conversationId, upload, result);
            draftTusUploadsRef.current.delete(upload.id);
            cancelledDraftUploadIdsRef.current.delete(upload.id);
            setDraftUploads((current) => current.filter((item) => item.id !== upload.id));
          } catch (reason) {
            setDraftUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "error" } : item));
            setError(reason instanceof Error ? reason.message : "上传完成登记失败，可点击继续恢复");
          }
        })();
      },
    });
    draftTusUploadsRef.current.set(upload.id, client);
    try {
      const previous = await client.findPreviousUploads();
      if (previous.length > 0) client.resumeFromPreviousUpload(previous[0]);
      client.start();
    } catch (reason) {
      setDraftUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "error" } : item));
      setError(reason instanceof Error ? reason.message : "无法启动断点续传");
    }
  }

  async function addComposerFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    const conversationId = selectedIdRef.current;
    if (editingPendingRef.current || !conversationId) {
      setFiles((previous) => [...previous, ...incoming].slice(0, 12));
      return;
    }
    const available = Math.max(0, 12 - (composerDraftRef.current?.files.length ?? 0) - draftUploadsRef.current.length);
    const accepted = incoming.slice(0, available);
    if (accepted.length === 0) { setNotice("单个会话草稿最多包含 12 个附件。"); return; }
    const uploads = accepted.map((file): DraftUpload => ({
      id: crypto.randomUUID(), name: file.name, resumable: file.size >= RESUMABLE_UPLOAD_THRESHOLD_BYTES, progress: 0, status: "uploading",
    }));
    setDraftUploads((current) => [...current, ...uploads]);
    setError("");
    await Promise.all(accepted.map(async (file, index) => {
      const upload = uploads[index];
      if (upload.resumable) {
        await startResumableComposerUpload(conversationId, file, upload);
        return;
      }
      const controller = new AbortController();
      draftUploadControllersRef.current.set(upload.id, controller);
      try {
        const result = await api.uploadConversationDraftFiles(conversationId, [file], controller.signal);
        await mergeCompletedDraftUpload(conversationId, upload, result);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "草稿附件上传失败");
      } finally {
        draftUploadControllersRef.current.delete(upload.id);
        cancelledDraftUploadIdsRef.current.delete(upload.id);
        setDraftUploads((current) => current.filter((currentUpload) => currentUpload.id !== upload.id));
      }
    }));
  }

  function cancelComposerDraftUpload(uploadId: string) {
    cancelledDraftUploadIdsRef.current.add(uploadId);
    draftUploadControllersRef.current.get(uploadId)?.abort();
    const resumable = draftTusUploadsRef.current.get(uploadId);
    if (resumable) {
      draftTusUploadsRef.current.delete(uploadId);
      void resumable.abort(true).catch((reason) => setError(reason instanceof Error ? reason.message : "取消上传失败，服务器会在到期后自动清理"));
    }
    setDraftUploads((current) => current.filter((upload) => upload.id !== uploadId));
  }

  function pauseComposerDraftUpload(uploadId: string) {
    const upload = draftTusUploadsRef.current.get(uploadId);
    if (!upload) return;
    void upload.abort(false).then(() => {
      setDraftUploads((current) => current.map((item) => item.id === uploadId ? { ...item, status: "paused" } : item));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "暂停上传失败"));
  }

  function resumeComposerDraftUpload(uploadId: string) {
    const upload = draftTusUploadsRef.current.get(uploadId);
    if (!upload) return;
    setDraftUploads((current) => current.map((item) => item.id === uploadId ? { ...item, status: "uploading" } : item));
    upload.start();
  }

  async function removeComposerDraftFile(file: WorkFile) {
    const conversationId = selectedIdRef.current;
    if (!conversationId || !file.id) return;
    setError("");
    try {
      const result = await api.deleteConversationDraftFile(conversationId, file.id);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      if (selectedIdRef.current !== conversationId || editingPendingRef.current) return;
      composerDraftRef.current = result.composerDraft;
      setComposerDraft(result.composerDraft);
      const cached = draftCacheRef.current.get(conversationId);
      if (cached) draftCacheRef.current.set(conversationId, { ...cached, composerDraft: result.composerDraft });
      const currentSignature = composerDraftSignature(inputRef.current, askAgentQuoteRef.current);
      setDraftSaveState(currentSignature === draftSyncedSignaturesRef.current.get(conversationId)
        ? result.composerDraft ? "saved" : "idle"
        : "unsaved");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除草稿附件失败"); }
  }

  async function clearComposerDraft() {
    const conversationId = selectedIdRef.current;
    if (!conversationId || editingPendingRef.current || draftUploads.length > 0) return;
    if (!window.confirm("清空这个会话尚未发送的正文、引用和附件？")) return;
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    await draftSaveQueueRef.current;
    try {
      await api.deleteConversationDraft(conversationId);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      draftCacheRef.current.delete(conversationId);
      draftSyncedSignaturesRef.current.set(conversationId, composerDraftSignature("", ""));
      composerDraftRef.current = null;
      setComposerDraft(null); setInput(""); setAskAgentQuote(""); setFiles([]); setDraftSaveState("idle");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "清空草稿失败"); }
  }

  async function send(message = input) {
    const hasRetainedEditingFile = Boolean(editingPending?.files.some((file) => !removedEditingFileIds.includes(file.id)));
    const hasComposerDraftFile = Boolean(!editingPending && composerDraft?.files.length);
    if ((!message.trim() && !askAgentQuote && files.length === 0 && !hasRetainedEditingFile && !hasComposerDraftFile) || submitting || selectionSaving) return;
    if (draftUploads.length > 0) { setNotice("请等待草稿附件上传完成后再发送。"); return; }
    setError(""); setNotice(""); setSubmitting(true);
    if (!sending) setActivities([{ kind: "status", label: files.length ? "正在上传并准备文件" : "正在提交任务" }]);
    try {
      let id = selectedId;
      const useComposerDraft = Boolean(id && !editingPending);
      if (!id) {
        const created = await api.createConversation(); id = created.conversation.id;
        setSelectedModel(created.agentSelection.model); setReasoningEffort(created.agentSelection.reasoningEffort);
        selectedIdRef.current = id; setSelectedId(id);
      }
      if (editingPending) {
        const result = await api.updatePendingPrompt(id, editingPending.id, message, files, removedEditingFileIds, askAgentQuote);
        if (result.needsInstruction) {
          const persisted = result.editingPrompt ?? result.pendingPrompt ?? editingPending;
          editingPendingRef.current = persisted; setEditingPending(persisted); setRemovedEditingFileIds([]);
          setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        } else {
          editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]);
          draftLoadedConversationRef.current = null;
        }
      } else {
        if (useComposerDraft) {
          if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
          await draftSaveQueueRef.current;
          await persistComposerDraft(id, message, askAgentQuote);
        }
        const result = await api.sendMessage(id, message, useComposerDraft ? [] : files, askAgentQuote, useComposerDraft);
        if (result.needsInstruction) setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        if (useComposerDraft) {
          draftMutationGenerationRef.current.set(id, (draftMutationGenerationRef.current.get(id) ?? 0) + 1);
          draftCacheRef.current.delete(id);
          draftSyncedSignaturesRef.current.set(id, composerDraftSignature("", ""));
          composerDraftRef.current = null; setComposerDraft(null); setDraftSaveState("idle");
        }
      }
      setInput(""); setAskAgentQuote(""); setFiles([]);
      await reconcile(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally { setSubmitting(false); }
  }

  async function beginPendingEdit(prompt: PendingPrompt) {
    if (!selectedId || editingPending || submitting) return;
    setError(""); setSubmitting(true);
    try {
      if (draftLoadedConversationRef.current === selectedId) {
        if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
        await draftSaveQueueRef.current;
        await persistComposerDraft(selectedId, inputRef.current, askAgentQuoteRef.current);
      }
      const result = await api.editPendingPrompt(selectedId, prompt.id);
      editingPendingRef.current = result.editingPrompt;
      setEditingPending(result.editingPrompt); setRemovedEditingFileIds([]); setFiles([]); setAskAgentQuote(result.editingPrompt.quote_excerpt ?? ""); setInput(result.editingPrompt.content);
      draftLoadedConversationRef.current = null;
      if (selectedModel !== prompt.agent_model || reasoningEffort !== prompt.reasoning_effort) {
        await persistAgentSelection({ model: prompt.agent_model, reasoningEffort: prompt.reasoning_effort });
      }
      await refreshDetail(selectedId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "进入编辑状态失败"); }
    finally { setSubmitting(false); }
  }

  async function cancelPendingEdit() {
    if (!selectedId || !editingPending || submitting) return;
    setSubmitting(true); setError("");
    try {
      if (editingPending.content.trim() || editingPending.quote_excerpt) await api.restorePendingPrompt(selectedId, editingPending.id);
      else await api.deletePendingPrompt(selectedId, editingPending.id);
      editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]); setInput(""); setAskAgentQuote(""); setFiles([]);
      draftLoadedConversationRef.current = null;
      setNotice("");
      await reconcile(selectedId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "取消编辑失败"); }
    finally { setSubmitting(false); }
  }

  async function deletePendingPrompt(prompt: PendingPrompt) {
    if (!selectedId || submitting) return;
    setSubmitting(true); setError("");
    try { await api.deletePendingPrompt(selectedId, prompt.id); await reconcile(selectedId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除待发送任务失败"); }
    finally { setSubmitting(false); }
  }

  async function steerPendingPrompt(prompt: PendingPrompt) {
    if (!selectedId || submitting) return;
    const action = job?.status === "running" ? "引导当前任务" : "插入任务";
    setSubmitting(true); setError("");
    try { await api.steerPendingPrompt(selectedId, prompt.id); await reconcile(selectedId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : `${action}失败`); }
    finally { setSubmitting(false); }
  }

  async function reorderPendingPrompts(ordered: PendingPrompt[]) {
    if (!selectedId || !detail) return;
    const previous = detail.pendingPrompts;
    setDetail({ ...detail, pendingPrompts: ordered });
    try {
      const result = await api.reorderPendingPrompts(selectedId, ordered.map((prompt) => prompt.id));
      setDetail((current) => current ? { ...current, pendingPrompts: result.pendingPrompts } : current);
    } catch (reason) {
      setDetail((current) => current ? { ...current, pendingPrompts: previous } : current);
      setError(reason instanceof Error ? reason.message : "调整待发送顺序失败");
      await refreshDetail(selectedId).catch(() => undefined);
    }
  }

  async function deleteConversation(conversation: Conversation) {
    if (!window.confirm(`删除“${conversation.title}”？相关任务会被停止，本机工作文件和结果文件将无法恢复；数据库审计记录会保留。`)) return;
    try {
      await api.deleteConversation(conversation.id);
      if (selectedId === conversation.id) setSelectedId(null);
      await refreshList();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
  }

  async function renameConversation(conversation: Conversation) {
    const title = window.prompt("修改任务名称", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    await api.renameConversation(conversation.id, title); await refreshList(); if (selectedId === conversation.id) await refreshDetail(conversation.id);
  }

  function toggleTaskMenu(conversation: Conversation, button: HTMLButtonElement) {
    if (taskMenu?.conversationId === conversation.id) {
      setTaskMenu(null);
      return;
    }
    const bounds = button.getBoundingClientRect();
    const width = 156;
    const height = 126;
    const top = bounds.bottom + 6 + height <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6);
    const left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    setTaskMenu({ conversationId: conversation.id, top, left });
  }

  useEffect(() => {
    if (!taskMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-task-menu]")) setTaskMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTaskMenu(null);
    };
    const closeOnResize = () => setTaskMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [taskMenu]);

  async function openArchivedConversations() {
    setAccountSettingsOpen(false);
    setArchivedDialogOpen(true);
    setArchivedLoading(true);
    setError("");
    try {
      const result = await api.archivedConversations();
      setArchivedConversations(result.conversations);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取已归档任务失败");
    } finally {
      setArchivedLoading(false);
    }
  }

  async function archiveConversation(conversation: Conversation) {
    setTaskMenu(null);
    try {
      await api.archiveConversation(conversation.id);
      await refreshList();
      if (selectedId === conversation.id) await refreshDetail(conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    }
  }

  async function scheduleWake(conversation: Conversation) {
    setTaskMenu(null);
    setWakeDialogConversation(conversation);
  }

  async function cancelActiveWake(conversation: Conversation) {
    setTaskMenu(null);
    try {
      const { wakePlan } = await api.activeWake(conversation.id);
      if (!wakePlan) { setNotice("当前没有等待计划。"); return; }
      if (!window.confirm("取消这个自动续跑计划？")) return;
      await api.cancelWake(conversation.id, wakePlan.id);
      await refreshList();
      if (selectedIdRef.current === conversation.id) await refreshDetail(conversation.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "取消自动续跑失败"); }
  }

  async function triggerWake(plan: WakePlan) {
    try {
      await api.triggerWake(plan.conversation_id, plan.id);
      await reconcile(plan.conversation_id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "立即继续失败"); }
  }

  async function postponeWake(plan: WakePlan) {
    try {
      await api.rescheduleWake(plan.conversation_id, plan.id, 30 * 60);
      await reconcile(plan.conversation_id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "延后计划失败"); }
  }

  async function restoreConversation(conversation: Conversation) {
    try {
      await api.restoreConversation(conversation.id);
      setArchivedConversations((current) => current.filter((item) => item.id !== conversation.id));
      await refreshList();
      if (selectedId === conversation.id) await refreshDetail(conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复失败");
    }
  }

  async function logout() { try { await api.logout(); } finally { onLogout(); } }

  async function persistAgentSelection(selection: { model: string; reasoningEffort: ReasoningEffort }) {
    const targetId = selectedIdRef.current;
    const previous = { model: selectedModel, reasoningEffort };
    setSelectedModel(selection.model); setReasoningEffort(selection.reasoningEffort); setSelectionSaving(true); setError("");
    try {
      const result = await api.updateAgentSelection(selection, targetId ?? undefined);
      if (selectedIdRef.current === targetId) {
        setSelectedModel(result.selection.model);
        setReasoningEffort(result.selection.reasoningEffort);
      }
      setAgentOptions((current) => current ? { ...current, selection: result.selection } : current);
    } catch (reason) {
      if (selectedIdRef.current === targetId) {
        setSelectedModel(previous.model);
        setReasoningEffort(previous.reasoningEffort);
      }
      setError(reason instanceof Error ? reason.message : "模型设置保存失败");
    } finally {
      setSelectionSaving(false);
    }
  }

  function changeModel(modelId: string) {
    const options = agentOptions;
    const model = options?.models.find((candidate) => candidate.id === modelId);
    if (!options || !model) return;
    const nextEffort = reasoningEffort && model.reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : model.reasoningEfforts.includes(options.defaults.reasoningEffort)
        ? options.defaults.reasoningEffort
        : model.reasoningEfforts.at(-1)!;
    void persistAgentSelection({ model: model.id, reasoningEffort: nextEffort });
  }

  function changeReasoning(effort: ReasoningEffort) {
    if (!selectedModel) return;
    void persistAgentSelection({ model: selectedModel, reasoningEffort: effort });
  }

  async function changeChatFontSize(delta: number) {
    if (fontSizeSaving) return;
    const previous = chatFontSize;
    const next = normalizeChatFontSize(previous + delta, previous);
    if (next === previous) return;
    setChatFontSize(next);
    setFontSizeSaving(true);
    setError("");
    try {
      const saved = await api.updateChatFontSize(next);
      setChatFontSize(saved.chatFontSize);
    } catch (reason) {
      setChatFontSize(previous);
      setError(reason instanceof Error ? reason.message : "字号设置保存失败");
    } finally {
      setFontSizeSaving(false);
    }
  }

  const filtered = conversations;
  const currentDetail = detail?.conversation.id === selectedId ? detail : null;
  const restoringConversationSelection = !conversationSelectionReady;
  const loadingConversation = restoringConversationSelection || Boolean(selectedId && !currentDetail);
  const taskMenuConversation = taskMenu ? conversations.find((conversation) => conversation.id === taskMenu.conversationId) : undefined;
  const account = resolveAccountIdentity(session);

  return <div className="shell">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="sidebar-top">
        <div className="wordmark"><span className="brand-mark small"><Zap size={15} /></span><span className="brand-copy"><strong>Codex Web</strong><small>SELF-HOSTED CODEX WORKSTATION</small></span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭"><X size={19} /></button>
      </div>
      <button className="new-task" onClick={() => void newConversation()}><Plus size={17} />新建任务</button>
      <div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务" /></div>
      <div className="conversation-section"><div className="section-label"><span>任务</span><strong>{filtered.length}</strong></div>
        <div className="conversation-list" onScroll={() => setTaskMenu(null)}>
          {filtered.map((conversation) => <div key={conversation.id} className={`conversation-row ${selectedId === conversation.id ? "active" : ""} ${conversation.has_unread_result ? "unread" : ""} ${taskMenu?.conversationId === conversation.id ? "menu-open" : ""}`}>
            <button className="conversation-select" onClick={() => setSelectedId(conversation.id)}>
              <FolderOpen size={16} /><span>{conversation.title}</span>
              {conversation.status === "running"
                ? <LoaderCircle size={14} className="spin" role="img" aria-label="正在执行" />
                : Boolean(conversation.has_pending_work) && !conversation.active_wake_count
                  ? <CircleDashed size={14} className="conversation-waiting" role="img" aria-label="等待发送" />
                  : Boolean(conversation.active_wake_count)
                    ? <Clock3 size={14} className="conversation-waiting" role="img" aria-label="等待自动续跑" />
                  : null}
            </button>
            <div className="row-actions">
              <button type="button" className="task-menu-trigger" data-task-menu aria-label={`任务 ${conversation.title} 操作`} aria-haspopup="menu" aria-expanded={taskMenu?.conversationId === conversation.id} title="任务操作" onClick={(event) => toggleTaskMenu(conversation, event.currentTarget)}><MoreHorizontal size={15} /></button>
            </div>
          </div>)}
          {filtered.length === 0 && <div className="empty-list">{query ? "没有匹配任务" : "还没有任务"}</div>}
        </div>
      </div>
      <div className="account-area">
        {accountSettingsOpen && <section className="account-settings" aria-label="个人设置">
          <div className="account-settings-heading"><Settings2 size={15} /><strong>个人设置</strong></div>
          <div className="font-size-setting">
            <div><strong>聊天正文字号</strong><small>正文、行距与内容间距同步调整</small></div>
            <div className="font-size-stepper">
              <button type="button" aria-label="减小聊天正文字号" disabled={fontSizeSaving || chatFontSize <= CHAT_FONT_SIZE_MIN} onClick={() => void changeChatFontSize(-1)}><Minus size={15} /></button>
              <output aria-live="polite">{chatFontSize}px</output>
              <button type="button" aria-label="增大聊天正文字号" disabled={fontSizeSaving || chatFontSize >= CHAT_FONT_SIZE_MAX} onClick={() => void changeChatFontSize(1)}><Plus size={15} /></button>
            </div>
          </div>
          <div className="theme-setting">
            <div><strong>外观</strong><small>选择固定主题或跟随设备设置</small></div>
            <div className="theme-options" role="group" aria-label="外观模式">
              <button type="button" aria-label="使用浅色模式" aria-pressed={themePreference === "light"} onClick={() => onThemePreferenceChange("light")}><Sun size={16} /><span>浅色</span></button>
              <button type="button" aria-label="使用深色模式" aria-pressed={themePreference === "dark"} onClick={() => onThemePreferenceChange("dark")}><Moon size={16} /><span>深色</span></button>
              <button type="button" aria-label="外观跟随系统" aria-pressed={themePreference === "system"} onClick={() => onThemePreferenceChange("system")}><Monitor size={16} /><span>系统</span></button>
            </div>
          </div>
          <button type="button" className="account-settings-archive" onClick={() => void openArchivedConversations()}><Archive size={15} /><span>已归档任务</span></button>
        </section>}
        <div className="account-row">
          <button className="account-profile" type="button" aria-expanded={accountSettingsOpen} onClick={() => setAccountSettingsOpen((open) => !open)}>
            <span className="avatar" aria-label={`${account.displayName} 头像`}>{account.initials}</span><span className="account-copy"><strong>{account.displayName}</strong><small>自托管工作站</small></span><Settings2 size={15} />
          </button>
          <button className="icon-button" onClick={() => void logout()} title="退出登录"><LogOut size={17} /></button>
        </div>
      </div>
    </aside>

    {taskMenu && taskMenuConversation && createPortal(<div
      className="task-menu-panel"
      data-task-menu
      role="menu"
      aria-label={`任务 ${taskMenuConversation.title} 操作`}
      style={{ top: taskMenu.top, left: taskMenu.left }}
    >
      {taskMenuConversation.active_wake_count
        ? <button type="button" role="menuitem" onClick={() => void cancelActiveWake(taskMenuConversation)}><Clock3 size={16} /><span>取消自动续跑</span></button>
        : <button type="button" role="menuitem" onClick={() => void scheduleWake(taskMenuConversation)}><Clock3 size={16} /><span>定时自动续跑</span></button>}
      <button type="button" role="menuitem" onClick={() => void archiveConversation(taskMenuConversation)}><Archive size={16} /><span>归档</span></button>
      <button type="button" role="menuitem" onClick={() => { setTaskMenu(null); void renameConversation(taskMenuConversation); }}><Pencil size={16} /><span>重命名</span></button>
      <button type="button" role="menuitem" className="danger" onClick={() => { setTaskMenu(null); void deleteConversation(taskMenuConversation); }}><Trash2 size={16} /><span>删除</span></button>
    </div>, document.body)}

    {archivedDialogOpen && createPortal(<div className="archive-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchivedDialogOpen(false); }}>
      <section className="archive-dialog" role="dialog" aria-modal="true" aria-label="已归档任务">
        <header><div><Archive size={19} /><strong>已归档任务</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setArchivedDialogOpen(false)}><X size={18} /></button></header>
        <div className="archived-conversation-list">
          {archivedLoading ? <div className="archived-conversation-empty"><LoaderCircle className="spin" size={18} /><span>正在加载…</span></div>
            : archivedConversations.length === 0 ? <div className="archived-conversation-empty">还没有已归档任务</div>
            : archivedConversations.map((conversation) => <div className="archived-conversation-row" key={conversation.id}>
                <button type="button" className="archived-conversation-open" onClick={() => { setSelectedId(conversation.id); setArchivedDialogOpen(false); }}>
                  <Archive size={17} /><span><strong>{conversation.title}</strong><small>{formatMessageDateTime(conversation.archived_at ?? conversation.updated_at)}</small></span>
                </button>
                <button type="button" className="archived-conversation-restore" aria-label={`恢复 ${conversation.title}`} title="恢复" onClick={() => void restoreConversation(conversation)}><RotateCcw size={16} /></button>
              </div>)}
        </div>
      </section>
    </div>, document.body)}

    {wakeDialogConversation && createPortal(<WakePlanDialog conversation={wakeDialogConversation} onClose={() => setWakeDialogConversation(null)} onCreated={(result) => {
      setWakeDialogConversation(null);
      setNotice("已登记自动续跑计划。");
      const nextId = result.targetConversation?.id ?? wakeDialogConversation.id;
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      void refreshList().then(() => refreshDetail(nextId));
    }} />, document.body)}

    <main className={`workspace ${currentDetail?.pendingPrompts.length ? "has-pending-queue" : ""}`}>
      <header className="mobile-header"><button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏"><Menu size={20} /></button><div className="wordmark"><span className="brand-mark small"><Zap size={14} /></span><span className="brand-copy"><strong>Codex Web</strong><small>SELF-HOSTED CODEX WORKSTATION</small></span></div></header>
      {currentDetail ? <Chat detail={currentDetail} activities={activities} activitiesLoading={activitiesLoading} sending={sending} loadingOlderMessages={loadingOlderMessages} messagesRef={messagesRef} onMessagesScroll={handleMessagesScroll} onAskAgent={askAgentAbout} userInitials={account.initials} chatFontSize={chatFontSize} onCancelWake={(plan) => cancelActiveWake(currentDetail.conversation).then(() => undefined)} onPostponeWake={postponeWake} onTriggerWake={triggerWake} />
        : loadingConversation ? <ConversationLoading restoring={restoringConversationSelection} />
        : <Welcome onSuggestion={(text) => setInput(text)} />}
      {error && <div className="toast"><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
      {notice && <div className="toast info" role="status"><span>{notice}</span><button onClick={() => setNotice("")}><X size={16} /></button></div>}
      {currentDetail?.conversation.archived_at && <div className="archived-conversation-banner"><Archive size={15} /><span>这个任务已归档，历史内容仍可查看。</span><button type="button" onClick={() => void restoreConversation(currentDetail.conversation)}>恢复任务</button></div>}
      {conversationSelectionReady && (!selectedId || (currentDetail && !currentDetail.conversation.archived_at)) && <Composer key={selectedId ?? "new-conversation"} input={input} setInput={setInput} askAgentQuote={askAgentQuote} onClearAskAgentQuote={() => setAskAgentQuote("")} focusRequest={composerFocusRequest} files={files} setFiles={setFiles} draftFiles={composerDraft?.files ?? []} draftUploads={draftUploads} draftSaveState={draftSaveState} sending={sending} submitting={submitting} selectionSaving={selectionSaving} voiceEnabled={Boolean(session.voiceEnabled)}
        conversationId={selectedId}
        pendingPrompts={currentDetail?.pendingPrompts ?? []} editingPending={editingPending} removedEditingFileIds={removedEditingFileIds}
        agentOptions={agentOptions} selectedModel={selectedModel} reasoningEffort={reasoningEffort}
        onModelChange={changeModel} onReasoningChange={changeReasoning}
        onReorderPending={(ordered) => void reorderPendingPrompts(ordered)} onEditPending={(prompt) => void beginPendingEdit(prompt)}
        onDeletePending={(prompt) => void deletePendingPrompt(prompt)} onSteerPending={(prompt) => void steerPendingPrompt(prompt)}
        pendingActionMode={job?.status === "running" ? "steer" : "insert"} waitingForWake={Boolean(currentDetail?.wakePlan)} onCancelPendingEdit={() => void cancelPendingEdit()}
        onAddFiles={(incoming) => void addComposerFiles(incoming)} onCancelDraftUpload={cancelComposerDraftUpload} onPauseDraftUpload={pauseComposerDraftUpload} onResumeDraftUpload={resumeComposerDraftUpload} onRemoveDraftFile={(file) => void removeComposerDraftFile(file)} onClearDraft={() => void clearComposerDraft()}
        onRemoveEditingFile={(fileId) => setRemovedEditingFileIds((current) => [...current, fileId])}
        onRestoreEditingFile={(fileId) => setRemovedEditingFileIds((current) => current.filter((id) => id !== fileId))}
        onSend={(message) => void send(message)} onCancel={job && selectedId ? () => void api.cancelConversation(selectedId).then(() => reconcile(selectedId)) : undefined} />}
    </main>
  </div>;
}

function WakePlanDialog({ conversation, onClose, onCreated }: {
  conversation: Conversation;
  onClose: () => void;
  onCreated: (result: Awaited<ReturnType<typeof api.createTimeWake>>) => void;
}) {
  const [delay, setDelay] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [label, setLabel] = useState("两小时后自动继续");
  const [prompt, setPrompt] = useState("请检查之前任务的最新状态和结果，并从中断处继续；如果仍需等待，请根据实际情况再次安排下一次自动续跑。");
  const [newConversation, setNewConversation] = useState(false);
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.agentOptions({ conversationId: conversation.id }).then((value) => {
      if (!active) return;
      setOptions(value); setModel(value.selection.model); setReasoningEffort(value.selection.reasoningEffort);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "续跑模型选项加载失败"); });
    return () => { active = false; };
  }, [conversation.id]);

  const selectedModel = options?.models.find((item) => item.id === model);
  const effortOptions = options?.reasoningEfforts.filter((item) => selectedModel?.reasoningEfforts.includes(item.id)) ?? [];
  function changeModel(value: string) {
    setModel(value);
    const modelOption = options?.models.find((item) => item.id === value);
    if (!modelOption?.reasoningEfforts.includes(reasoningEffort)) setReasoningEffort(modelOption?.reasoningEfforts[0] ?? "");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(delay);
    const multiplier = unit === "minutes" ? 60 : unit === "hours" ? 3_600 : 86_400;
    if (!Number.isFinite(amount) || amount <= 0 || !prompt.trim() || !model || !reasoningEffort) {
      setError("请填写有效的等待时间、续跑指令、模型和思考深度。"); return;
    }
    setBusy(true); setError("");
    try {
      onCreated(await api.createTimeWake(conversation.id, {
        delaySeconds: Math.max(1, Math.round(amount * multiplier)), label: label.trim(), prompt: prompt.trim(),
        newConversation, model, reasoningEffort,
      }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "自动续跑安排失败"); setBusy(false); }
  }
  return <div className="wake-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="wake-dialog" role="dialog" aria-modal="true" aria-labelledby="wake-dialog-title" onSubmit={submit}>
      <header><div><h2 id="wake-dialog-title">安排自动续跑</h2><p>“{conversation.title}”会在时间到达后{newConversation ? "在新会话中" : "回到原会话"}继续。</p></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="wake-dialog-body">
        <label>等待时间<div className="wake-delay-row"><input type="number" min="0.1" step="0.1" value={delay} onChange={(event) => setDelay(event.target.value)} /><select value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></div></label>
        <label>显示名称<input maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
        <label className="wake-conversation-toggle"><input type="checkbox" checked={newConversation} onChange={(event) => setNewConversation(event.target.checked)} /><span><strong>新建会话继续</strong><small>{newConversation ? "安排时立即创建一个新会话，等待与结果都留在新会话。" : "保持关闭时，到点后接着当前会话继续。"}</small></span></label>
        <div className="wake-selection-row"><label>续跑模型<select disabled={!options} value={model} onChange={(event) => changeModel(event.target.value)}>{options?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>思考深度<select disabled={!options || effortOptions.length === 0} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>{effortOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
        {options && <p className="wake-selection-summary">本次续跑：{selectedModel?.label ?? model} · {effortOptions.find((item) => item.id === reasoningEffort)?.label ?? reasoningEffort}</p>}
        <label>到点后交给 Codex 的指令<textarea maxLength={20_000} rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <p className="wake-plan-note"><Clock3 size={14} />等待不占用 Worker，也不会使用 sleep 保持任务。</p>
        {error && <div className="wake-dialog-error">{error}</div>}
      </div>
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !options}>{busy ? "正在安排…" : "确认安排"}</button></footer>
    </form>
  </div>;
}

function ConversationLoading({ restoring = false }: { restoring?: boolean }) {
  return <section className="conversation-loading" role="status" aria-live="polite"><LoaderCircle className="spin" size={23} /><span>{restoring ? "正在恢复上次任务…" : "正在加载任务…"}</span></section>;
}

function Welcome({ onSuggestion }: { onSuggestion: (value: string) => void }) {
  const suggestions = [
    [<FileText key="a" />, "处理文档", "整理、改写或生成 Word/PDF"],
    [<FolderOpen key="b" />, "制作演示", "分析资料并制作一份 PPT"],
    [<FileImage key="c" />, "分析图片", "识别截图并给出处理结果"],
    [<Bot key="d" />, "执行临时任务", "在独立工作区完成复杂操作"],
  ];
  return <section className="welcome"><div className="welcome-logo"><Zap size={27} /></div><h1>今天想完成什么？</h1><p>文字、图片和文件都会交给本机 Agent 处理</p><div className="suggestions">
    {suggestions.map(([icon, title, description]) => <button key={String(title)} onClick={() => onSuggestion(`${title}：`)}>{icon}<strong>{title}</strong><span>{description}</span></button>)}
  </div></section>;
}

type AskAgentSelection = { text: string; left: number; top: number; below: boolean };

function AssistantMarkdown({ content, files, citationFiles }: { content: string; files: WorkFile[]; citationFiles: WorkFile[] }) {
  const sanitized = useMemo(() => sanitizeAgentMarkdown(content, citationFiles), [citationFiles, content]);
  const math = useAsyncMarkdownMath(sanitized);
  return <div className="markdown" data-agent-selectable="true" aria-busy={math.loading || undefined}><ReactMarkdown
    remarkPlugins={math.plugins ? [remarkGfm, math.plugins.remarkMath] : [remarkGfm]}
    rehypePlugins={math.plugins ? [[math.plugins.rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]] : []}
    urlTransform={(url) => isLocalMarkdownUrl(url) ? url : defaultUrlTransform(url)}
    components={{ a: ({ href, children }) => {
      const resolved = resolveMessageFileLink(href, files);
      if (resolved.kind === "preview") return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
      if (resolved.kind === "raw") return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
      if (resolved.kind === "download") return <a href={resolved.href} download>{children}</a>;
      if (resolved.kind === "unavailable") return <span className="unavailable-file-link" title="该本机文件未登记为此消息的附件">{children}（不可下载）</span>;
      return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
    } }}
  >{math.content}</ReactMarkdown></div>;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy command failed");
  } finally {
    textarea.remove();
  }
}

function AssistantCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function copyReply() {
    if (!content || copied) return;
    try {
      await copyTextToClipboard(content);
      setCopied(true);
      setFailed(false);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setFailed(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setFailed(false), 2200);
    }
  }

  return <div className="assistant-message-actions">
    <button type="button" className="assistant-copy-button" onClick={() => void copyReply()} aria-label={failed ? "复制失败，重试" : copied ? "已复制" : "复制回复"} title={failed ? "复制失败，点击重试" : copied ? "已复制" : "复制回复"}>
      {copied ? <Check size={12} aria-hidden="true" /> : failed ? <CircleAlert size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  </div>;
}

function Chat({ detail, activities, activitiesLoading, sending, loadingOlderMessages, messagesRef, onMessagesScroll, onAskAgent, userInitials, chatFontSize, onCancelWake, onPostponeWake, onTriggerWake }: { detail: ConversationDetail; activities: JobEvent[]; activitiesLoading: boolean; sending: boolean; loadingOlderMessages: boolean; messagesRef: React.RefObject<HTMLDivElement | null>; onMessagesScroll: (event: React.UIEvent<HTMLDivElement>) => void; onAskAgent: (selectedText: string) => void; userInitials: string; chatFontSize: number; onCancelWake: (plan: WakePlan) => Promise<void>; onPostponeWake: (plan: WakePlan) => Promise<void>; onTriggerWake: (plan: WakePlan) => Promise<void> }) {
  const citationFiles = detail.messages.flatMap((message) => message.files);
  const latestJobError = detail.latestJob && ["failed", "interrupted"].includes(detail.latestJob.status) ? detail.latestJob.error?.trim() ?? "" : "";
  const chatRef = useRef<HTMLElement>(null);
  const [askSelection, setAskSelection] = useState<AskAgentSelection | null>(null);

  useEffect(() => {
    let frame = 0;
    const clear = () => setAskSelection(null);
    const selectableParent = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return element?.closest<HTMLElement>("[data-agent-selectable]") ?? null;
    };
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return clear();
        const text = normalizeAskAgentSelection(selection.toString());
        if (!text) return clear();
        const range = selection.getRangeAt(0);
        const start = selectableParent(range.startContainer);
        const end = selectableParent(range.endContainer);
        if (!start || start !== end || !chatRef.current?.contains(start)) return clear();
        const messages = messagesRef.current;
        if (!messages) return clear();
        const messagesRect = messages.getBoundingClientRect();
        const viewport = {
          left: Math.max(0, messagesRect.left),
          top: Math.max(0, messagesRect.top),
          right: Math.min(window.innerWidth, messagesRect.right),
          bottom: Math.min(window.innerHeight, messagesRect.bottom),
        };
        const rect = visibleSelectionBounds(Array.from(range.getClientRects()), viewport);
        if (!rect) return clear();
        const horizontalInset = Math.min(72, (viewport.right - viewport.left) / 2);
        const left = Math.min(viewport.right - horizontalInset, Math.max(viewport.left + horizontalInset, rect.left + (rect.right - rect.left) / 2));
        const below = viewport.bottom - rect.bottom >= 56;
        const top = below
          ? Math.min(rect.bottom + 10, viewport.bottom - 46)
          : Math.max(rect.top - 10, viewport.top + 46);
        setAskSelection({ text, left, top, below });
      });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    const messages = messagesRef.current;
    messages?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      messages?.removeEventListener("scroll", update);
    };
  }, [detail.conversation.id]);

  function useSelectedText() {
    if (!askSelection) return;
    onAskAgent(askSelection.text);
    setAskSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  return <section ref={chatRef} className="chat"><div className="chat-header"><div><span className="chat-kicker">CODEX WEB <i>/</i> AI 工作台</span><h1>{detail.conversation.title}</h1></div><div className="chat-header-actions"><span className="message-count">已加载 {detail.messages.length} 条</span>{shouldWarnAboutRollout(detail.rolloutBytes) && <details className="rollout-warning"><summary className="icon-button" aria-label="会话历史容量提醒"><TriangleAlert size={19} /><span /></summary><div className="rollout-warning-panel"><strong>会话历史已达 {formatRolloutBytes(detail.rolloutBytes!)}</strong><p>超长会话会增加加载和续接成本。建议完成当前任务后归档，并新建任务继续。</p></div></details>}<details className="capacity-menu"><summary className="icon-button" aria-label="会话容量" title="会话容量"><MoreHorizontal size={20} /></summary><div className="capacity-menu-panel"><div className="capacity-menu-row" title="Codex 本地会话记录的磁盘占用"><HardDrive size={16} /><span><small>Rollout 文件</small><strong>{detail.rolloutBytes === null ? "暂无数据" : formatRolloutBytes(detail.rolloutBytes)}</strong></span></div><div className="capacity-menu-row" title="最近一次请求使用的输入上下文 / 当前模型上下文窗口"><Bot size={16} /><span><small>Codex 上下文</small><strong>{detail.contextUsage ? formatContextUsage(detail.contextUsage.inputTokens, detail.contextUsage.modelContextWindow) : "暂无数据"}</strong></span></div><div className="capacity-menu-row" title="当前 Codex 套餐周期的剩余额度"><Gauge size={16} /><span><small>套餐额度</small><strong>{detail.packageQuota ? `${Math.round(detail.packageQuota.remainingPercent)}%` : "暂无数据"}</strong></span></div></div></details></div></div>
    <div ref={messagesRef} className="messages" onScroll={onMessagesScroll} style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}>
      {detail.messagePage.hasMore && <div className="history-loader" aria-live="polite">{loadingOlderMessages ? <><LoaderCircle className="spin" size={14} /><span>正在加载更早消息…</span></> : <span>向上滚动加载更早消息</span>}</div>}
      {detail.messages.map((message) => <article className={`message ${message.role}`} data-message-id={message.id} key={message.id}>
        <div className="message-avatar">{message.role === "assistant" ? <Zap size={15} /> : userInitials}</div>
        <div className="message-body">
          <div className="message-meta"><span className="message-name">{message.role === "assistant" ? "Codex Web" : "你"}</span><time dateTime={message.created_at} title={formatFullDateTime(message.created_at)}>{formatMessageDateTime(message.created_at)}</time></div>
          {message.role === "assistant" ? <><AssistantMarkdown content={message.content} files={message.files} citationFiles={citationFiles} />{message.content && <AssistantCopyButton content={message.content} />}</> : <>
            {message.quote_excerpt && <div className="message-reference" title={message.quote_excerpt}><CornerUpLeft size={14} /><span><strong>引用</strong>{message.quote_excerpt}</span></div>}
            {message.content && <p data-agent-selectable="true">{message.content}</p>}
          </>}
          {message.files.length > 0 && <div className="file-grid">{message.files.map((file) => <FileCard key={file.id} file={file} />)}</div>}
        </div>
      </article>)}
      {latestJobError && <article className="message system error" data-message-id={`job-error-${detail.latestJob?.id}`}>
        <div className="message-avatar"><TriangleAlert size={16} /></div><div className="message-body"><div className="message-meta"><span className="message-name">任务错误</span>{detail.latestJob?.updated_at && <time dateTime={detail.latestJob.updated_at}>{formatMessageDateTime(detail.latestJob.updated_at)}</time>}</div><div className="error-bubble" role="alert"><TriangleAlert size={17} /><div><strong>任务未完成</strong><p data-agent-selectable="true">{latestJobError}</p></div></div></div>
      </article>}
      {detail.wakePlan && <WakePlanCard plan={detail.wakePlan} onCancel={onCancelWake} onPostpone={onPostponeWake} onTrigger={onTriggerWake} />}
      {sending && <article className="message assistant running"><div className="message-avatar"><Zap size={15} /></div><div className="message-body"><div className="message-meta"><span className="message-name">Codex Web</span><span className="live-label">实时进度</span></div><ProcessPanel key={detail.conversation.id} activities={activities} loading={activitiesLoading} /></div></article>}
      <div />
    </div>{askSelection && <button type="button" className={`ask-agent-selection ${askSelection.below ? "below" : "above"}`} style={{ left: askSelection.left, top: askSelection.top }} onPointerDown={(event) => { event.preventDefault(); useSelectedText(); }} onClick={(event) => { if (event.detail === 0) useSelectedText(); }}><Zap size={14} /><span>询问 Agent</span></button>}
  </section>;
}

function WakePlanCard({ plan, onCancel, onPostpone, onTrigger }: { plan: WakePlan; onCancel: (plan: WakePlan) => Promise<void>; onPostpone: (plan: WakePlan) => Promise<void>; onTrigger: (plan: WakePlan) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: (plan: WakePlan) => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await action(plan); } finally { setBusy(false); }
  };
  return <section className="wake-plan-card" aria-label="自动续跑计划">
    <div className="wake-plan-icon"><Clock3 size={18} /></div>
    <div className="wake-plan-copy"><strong>{plan.label || "自动续跑"}</strong><span>{plan.mode === "event_or_deadline" ? "等待外部事件，最晚" : "将在"} {formatFullDateTime(plan.deadline_at)}继续</span><small>{plan.new_conversation ? "新会话" : "当前会话"} · {plan.agent_model} · {plan.reasoning_effort}</small></div>
    <div className="wake-plan-actions">
      <button type="button" disabled={busy} onClick={() => void run(onPostponeWake)}><Clock3 size={14} />延后 30 分钟</button>
      <button type="button" disabled={busy} onClick={() => void run(onTriggerWake)}><Play size={14} />立即继续</button>
      <button type="button" className="danger" disabled={busy} onClick={() => void run(onCancel)}><X size={14} />取消</button>
    </div>
  </section>;
}

function ProcessPanel({ activities, loading }: { activities: JobEvent[]; loading: boolean }) {
  if (loading) return <div className="activity-card activity-loading" role="status" aria-live="polite" aria-busy="true">
    <div className="activity-title"><LoaderCircle className="spin" size={17} /><strong>正在加载运行记录</strong><span>正在恢复完整上下文，加载完成后显示实时进度</span></div>
  </div>;
  const latestStatus = activities.findLast((item) => item.type === "status" || item.kind === "status");
  const queueStatus = activities.findLast((activity) => activity.status === "queued");
  const queued = Boolean(queueStatus) && !activities.some((activity) => activity.status === "running");
  const retrying = !queued && latestStatus?.status === "retrying";
  const plan = activities.findLast((activity) => activity.kind === "todo" && Boolean(activity.items?.length));
  const journal = buildProcessJournal(activities);
  const subagents = buildSubagentActivity(activities);
  const completedPlanItems = plan?.items?.filter((item) => item.completed).length ?? 0;

  return <div className="activity-card" role="status" aria-live="polite">
    <div className="activity-title"><LoaderCircle className="spin" size={17} /><strong>{queued ? "正在排队" : retrying ? "正在自动重试" : "正在处理"}</strong><span>{queued ? (queueStatus?.jobsAhead ? `前面还有 ${queueStatus.jobsAhead} 个任务，完成后自动开始` : "即将自动开始") : retrying ? latestStatus.label : "完成前持续保留，可随时引导"}</span></div>
    {plan?.items && <div className="process-plan"><div className="process-section-title"><strong>执行计划</strong><span>{completedPlanItems}/{plan.items.length}</span></div><ul>
      {plan.items.map((item, index) => <li className={item.completed ? "completed" : index === completedPlanItems ? "current" : ""} key={`${item.text}-${index}`}><span>{item.completed ? <Check size={12} /> : index === completedPlanItems ? <LoaderCircle className="spin" size={12} /> : index + 1}</span><p>{item.text}</p></li>)}
    </ul></div>}
    {subagents.agents.length > 0 && <div className="subagent-panel"><div className="process-section-title"><strong>协作 Agent</strong><span>{subagents.active.length ? `${subagents.active.length} 个运行中` : `${subagents.completedCount} 个已完成${subagents.failedCount ? ` · ${subagents.failedCount} 个异常` : ""}`}</span></div><div className="subagent-list">{subagents.agents.map((agent) => <div className={`subagent-row ${agent.status}`} key={agent.id}><span>{["pending", "running"].includes(agent.status) ? <LoaderCircle className="spin" size={13} /> : agent.status === "completed" ? <Check size={13} /> : <TriangleAlert size={13} />}</span><div><strong>{agent.name}</strong><small>{subagentStatusLabel(agent.status)}{agent.summary ? ` · ${agent.summary}` : ""}</small></div></div>)}</div></div>}
    <div className="process-section-title"><strong>工作记录</strong><span>{journal.length ? `${journal.length} 条 · 阶段反馈保留上限 5 条` : "实时更新"}</span></div>
    <div className="process-journal">{journal.length ? journal.map((activity, index) => isNarrativeActivity(activity)
      ? <ProcessJournalNote activity={activity} key={activity.seq ?? `${activity.kind}-${index}`} />
      : <div className="activity-line" key={activity.seq ?? `${activity.label}-${index}`}>
          {activity.kind === "error" ? <TriangleAlert size={14} /> : activity.kind === "retry" ? <Clock3 size={14} /> : activity.label?.startsWith("正在") ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          <div><span>{activity.label}</span>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}
            {activity.kind === "file" && activity.files?.length ? <small>{activity.files.map((file) => file.split(/[\\/]/).at(-1)).join("、")}</small> : null}
            {["search", "tool", "error", "retry"].includes(activity.kind ?? "") && activity.detail ? <small>{activity.detail}</small> : null}
            {activity.kind === "command" && activity.detail ? <details className="technical-detail"><summary>{activity.actionCount && activity.actionCount > 1 ? `查看 ${activity.actionCount} 个技术步骤` : "查看技术细节"}</summary><code>{activity.groupedDetails?.join("\n\n") || activity.detail}</code></details> : null}
          </div>
        </div>) : <p className="process-journal-empty">正在建立执行方向…</p>}</div>
  </div>;
}

function ProcessJournalNote({ activity }: { activity: JobEvent }) {
  const math = useAsyncMarkdownMath(activity.detail ?? "");
  return <section className="process-journal-note">
    <header><Bot size={14} /><strong>{activity.kind === "reasoning" ? "重要思路" : "阶段反馈"}</strong>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}</header>
    <div className="process-note-content" aria-busy={math.loading || undefined}><ReactMarkdown
      remarkPlugins={math.plugins ? [remarkGfm, math.plugins.remarkMath] : [remarkGfm]}
      rehypePlugins={math.plugins ? [[math.plugins.rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]] : []}
    >{math.content}</ReactMarkdown></div>
  </section>;
}

function formatMessageDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

function formatFullDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}

function FileCard({ file }: { file: WorkFile }) {
  const image = file.mime_type.startsWith("image/");
  const icon = image ? null : <FileIcon size={20} />;
  const reader = fileReaderKind(file);
  const previewable = isBrowserPreviewable(file);
  const previewHref = reader ? filePreviewUrl(file) : previewable ? fileUrl(file) : "";
  const body = <>{image && <img className="file-card-image" src={fileThumbnailUrl(file)} alt="" loading="lazy" />}{icon}<span><strong>{file.original_name}</strong><small>{formatSize(file.size)} · {file.kind === "output" ? "结果文件" : "上传文件"}</small></span></>;
  return <div className={`file-card ${image ? "image-file-card" : ""}`}>
    {reader === "html"
      ? <a href={filePreviewUrl(file)} target="_blank" rel="noreferrer">{body}</a>
      : reader === "markdown" || previewable
      ? <a href={fileUrl(file)} target="_blank" rel="noreferrer">{body}</a>
      : <a href={fileUrl(file, true)} download={file.original_name}>{body}</a>}
    {previewHref && <a className="preview-button" href={previewHref} target="_blank" rel="noreferrer" title="预览" aria-label={`预览 ${file.original_name}`}><Eye size={16} /></a>}
    <a className="download-button" href={fileUrl(file, true)} download={file.original_name} title="下载"><Download size={16} /></a>
  </div>;
}

function PendingQueue({ prompts, busy, actionMode, waitingForWake, onReorder, onEdit, onDelete, onSteer }: {
  prompts: PendingPrompt[];
  busy: boolean;
  actionMode: "steer" | "insert";
  waitingForWake: boolean;
  onReorder: (ordered: PendingPrompt[]) => void;
  onEdit: (prompt: PendingPrompt) => void;
  onDelete: (prompt: PendingPrompt) => void;
  onSteer: (prompt: PendingPrompt) => void;
}) {
  const actionLabel = actionMode === "steer" ? "引导" : "插入";
  const queueSummary = waitingForWake
    ? "等待计划结束后依次发送"
    : actionMode === "steer" ? "当前任务完成后依次发送" : "即将依次发送";
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const touchDragRef = useRef<{ pointerId: number; sourceId: string; targetId: string | null } | null>(null);
  function dropOn(sourceId: string | null, targetId: string) {
    if (!sourceId || sourceId === targetId) return setDraggingId(null);
    const sourceIndex = prompts.findIndex((prompt) => prompt.id === sourceId);
    const targetIndex = prompts.findIndex((prompt) => prompt.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return setDraggingId(null);
    const ordered = [...prompts];
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    setDraggingId(null);
    onReorder(ordered);
  }
  function beginTouchDrag(event: ReactPointerEvent<HTMLButtonElement>, sourceId: string) {
    if (busy || event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    touchDragRef.current = { pointerId: event.pointerId, sourceId, targetId: null };
    setDraggingId(sourceId);
    setDragTargetId(null);
  }
  function moveTouchDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = touchDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".pending-queue-item[data-pending-prompt-id]");
    const targetId = target?.dataset.pendingPromptId;
    drag.targetId = targetId && targetId !== drag.sourceId ? targetId : null;
    setDragTargetId(drag.targetId);
  }
  function endTouchDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = touchDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    touchDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragTargetId(null);
    if (drag.targetId) dropOn(drag.sourceId, drag.targetId);
    else setDraggingId(null);
  }
  function cancelTouchDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = touchDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    touchDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingId(null);
    setDragTargetId(null);
  }
  return <section className={`pending-queue ${draggingId ? "drag-active" : ""}`} aria-label="待发送任务队列">
    <div className="pending-queue-heading"><strong>待发送</strong><span>{prompts.length} 个任务 · {queueSummary}</span></div>
    <div className="pending-queue-list">
      {prompts.map((prompt) => <article key={prompt.id} data-pending-prompt-id={prompt.id} className={`pending-queue-item ${draggingId === prompt.id ? "dragging" : ""} ${dragTargetId === prompt.id ? "drag-target" : ""}`}
        onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => { setDragTargetId(null); dropOn(draggingId, prompt.id); }}>
        <button type="button" className="pending-drag-handle" draggable={!busy}
          onDragStart={(event) => { setDraggingId(prompt.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { setDraggingId(null); setDragTargetId(null); }}
          onPointerDown={(event) => beginTouchDrag(event, prompt.id)} onPointerMove={moveTouchDrag}
          onPointerUp={endTouchDrag} onPointerCancel={cancelTouchDrag}
          title="按住并上下拖动调整顺序" aria-label="按住并上下拖动调整顺序" aria-grabbed={draggingId === prompt.id}><GripVertical size={17} /></button>
        <div className="pending-queue-copy" title={prompt.content || prompt.quote_excerpt || prompt.files.map((file) => file.original_name).join("、")}>
          <span>{prompt.content || prompt.quote_excerpt || prompt.files.map((file) => file.original_name).join("、") || "附件任务"}</span>
          {prompt.quote_excerpt && <small><CornerUpLeft size={11} />含引用</small>}
          {prompt.files.length > 0 && <small><Paperclip size={11} />{prompt.files.length} 个附件</small>}
        </div>
        <div className="pending-queue-actions">
          <button type="button" className="steer-action" disabled={busy} onClick={() => onSteer(prompt)} title={actionMode === "steer" ? "立即引导当前任务" : "立即插入并发送这项任务"}><CornerUpLeft size={14} /><span>{actionLabel}</span></button>
          <button type="button" disabled={busy} onClick={() => onEdit(prompt)} title="编辑"><Pencil size={14} /></button>
          <button type="button" disabled={busy} onClick={() => onDelete(prompt)} title="删除"><Trash2 size={14} /></button>
        </div>
      </article>)}
    </div>
  </section>;
}

function Composer({ conversationId, input, setInput, askAgentQuote, onClearAskAgentQuote, focusRequest, files, setFiles, draftFiles, draftUploads, draftSaveState, sending, submitting, selectionSaving, voiceEnabled, pendingPrompts, editingPending, removedEditingFileIds, agentOptions, selectedModel, reasoningEffort, onModelChange, onReasoningChange, onReorderPending, onEditPending, onDeletePending, onSteerPending, pendingActionMode, waitingForWake, onCancelPendingEdit, onAddFiles, onCancelDraftUpload, onPauseDraftUpload, onResumeDraftUpload, onRemoveDraftFile, onClearDraft, onRemoveEditingFile, onRestoreEditingFile, onSend, onCancel }: {
  conversationId: string | null;
  input: string;
  setInput: (value: string) => void;
  askAgentQuote: string;
  onClearAskAgentQuote: () => void;
  focusRequest: number;
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
  draftFiles: WorkFile[];
  draftUploads: DraftUpload[];
  draftSaveState: DraftSaveState;
  sending: boolean;
  submitting: boolean;
  selectionSaving: boolean;
  voiceEnabled: boolean;
  pendingPrompts: PendingPrompt[];
  editingPending: PendingPrompt | null;
  removedEditingFileIds: string[];
  agentOptions: AgentOptions | null;
  selectedModel: string;
  reasoningEffort: ReasoningEffort | "";
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
  onReorderPending: (ordered: PendingPrompt[]) => void;
  onEditPending: (prompt: PendingPrompt) => void;
  onDeletePending: (prompt: PendingPrompt) => void;
  onSteerPending: (prompt: PendingPrompt) => void;
  pendingActionMode: "steer" | "insert";
  waitingForWake: boolean;
  onCancelPendingEdit: () => void;
  onAddFiles: (files: File[]) => void;
  onCancelDraftUpload: (uploadId: string) => void;
  onPauseDraftUpload: (uploadId: string) => void;
  onResumeDraftUpload: (uploadId: string) => void;
  onRemoveDraftFile: (file: WorkFile) => void;
  onClearDraft: () => void;
  onRemoveEditingFile: (fileId: string) => void;
  onRestoreEditingFile: (fileId: string) => void;
  onSend: (message?: string) => void;
  onCancel?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteTimer = useRef<number | undefined>(undefined);
  const [pasteNotice, setPasteNotice] = useState("");
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [voiceNotice, setVoiceNotice] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const recordingLimitRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sendAfterTranscriptionRef = useRef(false);
  const discardRecordingRef = useRef(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointerRef = useRef<{ pointerId: number; startX: number; startY: number; triggered: boolean } | null>(null);
  const [longPressArmed, setLongPressArmed] = useState(false);
  const handledFocusRequestRef = useRef(focusRequest);
  const inputRef = useRef(input);
  const filesRef = useRef(files);
  const draftFilesRef = useRef(draftFiles);
  const draftUploadsRef = useRef(draftUploads);
  const editingPendingRef = useRef(editingPending);
  const removedEditingFileIdsRef = useRef(removedEditingFileIds);
  const onSendRef = useRef(onSend);
  inputRef.current = input;
  filesRef.current = files;
  draftFilesRef.current = draftFiles;
  draftUploadsRef.current = draftUploads;
  editingPendingRef.current = editingPending;
  removedEditingFileIdsRef.current = removedEditingFileIds;
  onSendRef.current = onSend;

  function resetLongPress(pointerId?: number) {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    const pointer = longPressPointerRef.current;
    const textarea = textareaRef.current;
    if (pointer && (pointerId === undefined || pointer.pointerId === pointerId) && textarea?.hasPointerCapture(pointer.pointerId)) {
      try { textarea.releasePointerCapture(pointer.pointerId); } catch {}
    }
    if (pointerId === undefined || pointer?.pointerId === pointerId) {
      longPressPointerRef.current = null;
      setLongPressArmed(false);
    }
  }

  function canArmLongPress() {
    return voiceState === "idle" && !submitting && !selectionSaving && !voiceNotice && !voiceError
      && !inputRef.current.trim() && !askAgentQuote && filesRef.current.length === 0
      && draftFilesRef.current.length === 0 && draftUploadsRef.current.length === 0 && !editingPendingRef.current;
  }

  function beginLongPress(event: ReactPointerEvent<HTMLTextAreaElement>) {
    if (event.pointerType !== "touch" || !event.isPrimary || !canArmLongPress()) return;
    resetLongPress();
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    longPressPointerRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, triggered: false };
    setLongPressArmed(true);
    longPressTimerRef.current = window.setTimeout(() => {
      const pointer = longPressPointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId || !canArmLongPress()) return resetLongPress(event.pointerId);
      pointer.triggered = true;
      longPressTimerRef.current = null;
      setLongPressArmed(false);
      void startRecording();
    }, COMPOSER_LONG_PRESS_DELAY_MS);
  }

  function moveLongPress(event: ReactPointerEvent<HTMLTextAreaElement>) {
    const pointer = longPressPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || pointer.triggered) return;
    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX) resetLongPress(event.pointerId);
  }

  function endLongPress(event: ReactPointerEvent<HTMLTextAreaElement>) {
    const pointer = longPressPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const wasTriggered = pointer.triggered;
    resetLongPress(event.pointerId);
    if (!wasTriggered) {
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length);
    }
  }

  useEffect(() => () => {
    window.clearTimeout(pasteTimer.current);
    resetLongPress();
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    releaseAudio();
  }, []);

  useEffect(() => {
    if (focusRequest === handledFocusRequestRef.current) return;
    handledFocusRequestRef.current = focusRequest;
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  function releaseAudio() {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    if (durationTimerRef.current !== null) window.clearInterval(durationTimerRef.current);
    if (recordingLimitRef.current !== null) window.clearTimeout(recordingLimitRef.current);
    animationRef.current = null; durationTimerRef.current = null; recordingLimitRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }

  function drawWaveform(analyser: AnalyserNode) {
    const canvas = waveformRef.current;
    if (canvas) {
      const values = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(values);
      const context = canvas.getContext("2d");
      if (context) {
        const width = canvas.clientWidth * window.devicePixelRatio;
        const height = canvas.clientHeight * window.devicePixelRatio;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.clearRect(0, 0, width, height);
        context.fillStyle = "#4b5794";
        const bars = 36; const gap = 2 * window.devicePixelRatio; const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
        for (let index = 0; index < bars; index += 1) {
          const sample = values[Math.floor(index * values.length / bars)] / 255;
          const barHeight = Math.max(3 * window.devicePixelRatio, sample * height * .9);
          context.beginPath();
          context.roundRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
          context.fill();
        }
      }
    }
    animationRef.current = requestAnimationFrame(() => drawWaveform(analyser));
  }

  async function startRecording() {
    if (voiceState !== "idle" || submitting || selectionSaving) return;
    setVoiceError("");
    setVoiceNotice("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("当前浏览器不支持录音，请改用最新版 Chrome、Edge 或 Safari。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream; recorderRef.current = recorder; chunksRef.current = [];
      sendAfterTranscriptionRef.current = false; discardRecordingRef.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        discardRecordingRef.current = true;
        if (recorder.state === "recording") recorder.stop();
        setVoiceNotice(""); setVoiceError("录音中断，请检查麦克风权限后重试。"); releaseAudio(); setVoiceState("idle");
      };
      recorder.onstop = () => void processRecording(recorder.mimeType || mimeType || "audio/webm");
      recorder.start(250);
      setVoiceElapsed(0); setVoiceState("recording");
      const startedAt = Date.now();
      durationTimerRef.current = window.setInterval(() => setVoiceElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
      recordingLimitRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          sendAfterTranscriptionRef.current = false;
          setVoiceNotice("已达到 5 分钟录音上限，正在识别…");
          recorder.stop();
          setVoiceState("transcribing");
        }
      }, 5 * 60 * 1000);
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audioContext = new AudioContextClass(); audioContextRef.current = audioContext;
        const analyser = audioContext.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .76;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        drawWaveform(analyser);
      }
    } catch (reason) {
      releaseAudio(); setVoiceState("idle");
      const denied = reason instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(reason.name);
      setVoiceError(denied ? "请允许浏览器使用麦克风，然后再试一次。" : "无法开始录音，请检查麦克风是否可用。");
    }
  }

  function finishRecording(sendAfter: boolean) {
    if (voiceState !== "recording" || recorderRef.current?.state !== "recording") return;
    sendAfterTranscriptionRef.current = sendAfter;
    recorderRef.current.stop();
    setVoiceState("transcribing");
  }

  function cancelRecording() {
    if (voiceState !== "recording" || recorderRef.current?.state !== "recording") return;
    discardRecordingRef.current = true;
    recorderRef.current.stop();
    releaseAudio();
    setVoiceState("idle"); setVoiceElapsed(0); setVoiceNotice("");
  }

  async function processRecording(mimeType: string) {
    releaseAudio(); recorderRef.current = null;
    if (discardRecordingRef.current) { chunksRef.current = []; return; }
    const blob = new Blob(chunksRef.current, { type: mimeType }); chunksRef.current = [];
    if (blob.size === 0) { setVoiceNotice(""); setVoiceError("没有录到声音，请重新录制。"); setVoiceState("idle"); return; }
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "webm";
    try {
      const retainedNames = (editingPendingRef.current?.files ?? [])
        .filter((file) => !removedEditingFileIdsRef.current.includes(file.id))
        .map((file) => file.original_name);
      const attachmentNames = [...retainedNames, ...draftFilesRef.current.map((file) => file.original_name), ...draftUploadsRef.current.map((file) => file.name), ...filesRef.current.map((file) => file.name)].slice(0, 12);
      const result = await api.transcribeAudio(blob, `recording.${extension}`, {
        conversationId: conversationId ?? undefined,
        draftText: inputRef.current,
        attachmentNames,
      });
      const existing = inputRef.current;
      const combined = existing ? `${existing}${/\s$/.test(existing) ? "" : "\n"}${result.text}` : result.text;
      inputRef.current = combined; setInput(combined); setVoiceState("idle"); setVoiceElapsed(0); setVoiceNotice("");
      if (sendAfterTranscriptionRef.current) onSendRef.current(combined);
    } catch (reason) {
      setVoiceNotice("");
      setVoiceError(reason instanceof Error ? reason.message : "语音识别失败，请重试。");
      setVoiceState("idle");
    } finally { sendAfterTranscriptionRef.current = false; }
  }
  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    onAddFiles(Array.from(list));
  }
  function pasted(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files);
    if (clipboardFiles.length === 0) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) clipboardFiles.push(file);
      }
    }
    if (clipboardFiles.length === 0) return;
    event.preventDefault();
    const timestamp = clipboardTimestamp(new Date());
    const normalized = clipboardFiles.map((file, index) => normalizeClipboardFile(file, timestamp, index));
    addFiles(normalized);
    const available = Math.max(0, 12 - files.length - draftFiles.length - draftUploads.length);
    const added = Math.min(normalized.length, available);
    setPasteNotice(added > 0 ? `已从剪贴板添加 ${added} 个附件` : "单次最多添加 12 个附件");
    window.clearTimeout(pasteTimer.current);
    pasteTimer.current = window.setTimeout(() => setPasteNotice(""), 2600);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); voiceState === "recording" ? finishRecording(true) : onSend(); } }
  const selectedModelOption = agentOptions?.models.find((model) => model.id === selectedModel);
  const effortOptions = agentOptions?.reasoningEfforts.filter((effort) => selectedModelOption?.reasoningEfforts.includes(effort.id)) ?? [];
  const modelOptions = agentOptions?.models.map((model) => ({ id: model.id, label: model.label, description: model.description })) ?? [];
  const hasRetainedEditingFile = Boolean(editingPending?.files.some((file) => !removedEditingFileIds.includes(file.id)));
  const primaryAction = chooseComposerPrimaryAction({
    running: Boolean(sending && onCancel),
    hasText: Boolean(input.trim() || askAgentQuote),
    hasAttachments: files.length > 0 || draftFiles.length > 0 || draftUploads.length > 0 || hasRetainedEditingFile,
    voiceActive: voiceState !== "idle",
  });
  const awaitingInstruction = Boolean(editingPending && !editingPending.content.trim() && !editingPending.quote_excerpt);
  const hasUnsentDraft = !editingPending && Boolean(input || askAgentQuote || draftFiles.length || draftUploads.length);
  const draftStatusLabel = draftUploads.length > 0 ? "正在上传附件…"
    : draftSaveState === "saving" ? "正在保存草稿…"
    : draftSaveState === "unsaved" ? "草稿将在停止输入后自动保存"
    : draftSaveState === "error" ? "草稿暂未保存，将在继续编辑时重试"
    : draftSaveState === "saved" || draftFiles.length > 0 ? "草稿已保存到服务器"
    : "";
  const pendingQueueGuidance = pendingActionMode === "steer"
    ? "任务运行中，新内容会先进入待发送队列；也可选择“引导”立即调整当前任务。"
    : waitingForWake
    ? "会话正在等待时间或事件，待发送任务会保持排队；可选择“插入”立即发送。"
    : "新内容会进入待发送队列；可选择“插入”立即发送。";
  return <div className="composer-wrap">
    {pendingPrompts.length > 0 && <PendingQueue prompts={pendingPrompts} busy={submitting} actionMode={pendingActionMode} waitingForWake={waitingForWake}
      onReorder={onReorderPending} onEdit={onEditPending} onDelete={onDeletePending} onSteer={onSteerPending} />}
    {editingPending && <div className={`editing-pending-banner ${awaitingInstruction ? "awaiting-instruction" : ""}`}><span>{awaitingInstruction ? <Paperclip size={13} /> : <Pencil size={13} />}{awaitingInstruction ? `已上传 ${editingPending.files.length} 个文件，请输入具体操作` : "正在编辑待发送任务"}</span><button type="button" onClick={onCancelPendingEdit} disabled={submitting}><X size={14} />{awaitingInstruction ? "清除文件" : "取消编辑"}</button></div>}
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
    {askAgentQuote && <div className="ask-agent-reference" title={askAgentQuote}><CornerUpLeft size={15} /><span>{askAgentQuote}</span><button type="button" onClick={onClearAskAgentQuote} aria-label="移除引用" title="移除引用"><X size={14} /></button></div>}
    {editingPending && editingPending.files.length > 0 && <div className="editing-pending-files">{editingPending.files.map((file) => {
      const removed = removedEditingFileIds.includes(file.id);
      return <span key={file.id} className={removed ? "removed" : ""}><FileIcon size={14} />{file.original_name}<button type="button" onClick={() => removed ? onRestoreEditingFile(file.id) : onRemoveEditingFile(file.id)} title={removed ? "恢复附件" : "移除附件"}>{removed ? <Plus size={13} /> : <X size={13} />}</button></span>;
    })}</div>}
    {!editingPending && draftFiles.length > 0 && <div className="pending-files">{draftFiles.map((file) => <span key={file.id}><FileIcon size={14} /><span className="attachment-chip-name">{file.original_name}</span><button type="button" aria-label={`移除附件 ${file.original_name}`} title="移除附件" onClick={() => onRemoveDraftFile(file)}><X size={13} /></button></span>)}</div>}
    {!editingPending && draftUploads.length > 0 && <div className="pending-files">{draftUploads.map((file) => <span key={file.id} className={`uploading ${file.status}`}>
      {file.status === "paused" || file.status === "error" ? <Pause size={14} /> : <LoaderCircle className="spin" size={14} />}
      <span className="attachment-upload-copy"><span className="attachment-chip-name">{file.name}</span><small>{file.resumable ? `${file.status === "retrying" ? "正在重试 · " : file.status === "paused" ? "已暂停 · " : file.status === "error" ? "等待继续 · " : ""}${Math.round(file.progress * 100)}%` : "正在上传"}</small>{file.resumable && <i style={{ width: `${Math.max(2, file.progress * 100)}%` }} />}</span>
      {file.resumable && (file.status === "paused" || file.status === "error")
        ? <button type="button" aria-label={`继续上传 ${file.name}`} title="继续上传" onClick={() => onResumeDraftUpload(file.id)}><Play size={12} /></button>
        : file.resumable ? <button type="button" aria-label={`暂停上传 ${file.name}`} title="暂停上传" onClick={() => onPauseDraftUpload(file.id)}><Pause size={12} /></button> : null}
      <button type="button" aria-label={`取消上传 ${file.name}`} title="取消并删除上传" onClick={() => onCancelDraftUpload(file.id)}><X size={13} /></button>
    </span>)}</div>}
    {files.length > 0 && <div className="pending-files">{files.map((file, index) => <span key={`${file.name}-${index}`}><FileIcon size={14} /><span className="attachment-chip-name">{file.name}</span><button type="button" aria-label={`移除附件 ${file.name}`} title="移除附件" onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={13} /></button></span>)}</div>}
    {pasteNotice && <div className="paste-notice" role="status" aria-live="polite"><Check size={14} />{pasteNotice}</div>}
    {voiceNotice && <div className="voice-notice" role="status" aria-live="polite"><Check size={14} />{voiceNotice}</div>}
    {voiceError && <div className="voice-error" role="alert"><span>{voiceError}</span><button type="button" onClick={() => setVoiceError("")}><X size={13} /></button></div>}
    <textarea ref={textareaRef} className={longPressArmed ? "long-press-armed" : undefined} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={keyDown} onPaste={pasted} onPointerDown={beginLongPress} onPointerMove={moveLongPress} onPointerUp={endLongPress} onPointerCancel={(event) => resetLongPress(event.pointerId)} onBlur={() => resetLongPress()} placeholder={voiceState === "recording" ? "可以继续输入文字；点击发送会先转写语音…" : awaitingInstruction ? "请输入要如何处理刚才上传的文件…" : editingPending ? "修改这条待发送任务…" : askAgentQuote ? "输入你想询问的问题…" : sending ? "继续输入，新任务会先进入待发送队列…" : "给 Agent 发送任务，或粘贴、拖入文件…"} rows={1} disabled={submitting || voiceState === "transcribing"} />
    {voiceState !== "idle" && <div className={`voice-panel ${voiceState}`}>
      {voiceState === "recording" ? <><button type="button" className="voice-cancel" onClick={cancelRecording} title="取消录音"><X size={15} /></button><canvas ref={waveformRef} aria-label="实时音量波形" /><time>{formatVoiceDuration(voiceElapsed)}</time><button type="button" className="voice-stop" onClick={() => finishRecording(false)} title="停止并转成文字"><Square size={12} fill="currentColor" /></button></> : <><LoaderCircle className="spin" size={17} /><span>正在识别语音…</span></>}
    </div>}
    <div className="composer-actions"><div className="composer-primary-actions"><button className="attach-button" onClick={() => fileInput.current?.click()} disabled={submitting}><Paperclip size={17} /><span>添加文件</span></button><input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }} />
      <SettingMenu className="model" label="模型" value={selectedModel} options={modelOptions} placeholder="加载中" title={selectedModelOption?.description || "选择任务使用的模型"} disabled={submitting || selectionSaving || !agentOptions} onChange={onModelChange} />
      <SettingMenu className="effort" label="思考" value={reasoningEffort} options={effortOptions} placeholder="加载中" title="选择模型的思考深度" disabled={submitting || selectionSaving || effortOptions.length === 0} onChange={(value) => onReasoningChange(value as ReasoningEffort)} />
    </div>
      <div className="composer-submit-actions">
        {voiceEnabled && voiceState === "idle" && <button type="button" className="mic-button" onClick={() => void startRecording()} disabled={submitting || selectionSaving} title="录音输入" aria-label="录音输入"><Mic size={18} /></button>}
        {primaryAction === "stop" && onCancel
          ? <button type="button" className="send-button stop" onClick={onCancel} title="停止当前显示的任务" aria-label="停止当前显示的任务"><Square size={15} fill="currentColor" /></button>
          : <button type="button" className="send-button" onClick={() => voiceState === "recording" ? finishRecording(true) : onSend()} disabled={submitting || selectionSaving || draftUploads.length > 0 || voiceState === "transcribing" || (voiceState !== "recording" && !input.trim() && !askAgentQuote && files.length === 0 && draftFiles.length === 0 && !hasRetainedEditingFile)} title={voiceState === "recording" ? "识别语音并发送" : "发送"} aria-label={voiceState === "recording" ? "识别语音并发送" : "发送"}>{submitting || voiceState === "transcribing" ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button>}
      </div>
    </div>
  </div><p className="composer-note"><span>{draftStatusLabel || pendingQueueGuidance}</span>{hasUnsentDraft && conversationId && <button type="button" onClick={onClearDraft} disabled={submitting || draftUploads.length > 0}>清空草稿</button>}</p></div>;
}

type SettingMenuOption = { id: string; label: string; description?: string };

function SettingMenu({ className, label, value, options, placeholder, title, disabled, onChange }: {
  className: string;
  label: string;
  value: string;
  options: SettingMenuOption[];
  placeholder: string;
  title: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.id === value);
  const menuId = `setting-menu-${className}`;

  useEffect(() => {
    if (disabled || options.length === 0) setOpen(false);
  }, [disabled, options.length]);
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  function choose(option: SettingMenuOption) {
    if (option.id !== value) onChange(option.id);
    setOpen(false);
  }

  function moveActive(step: number) {
    setActiveIndex((current) => (current + step + options.length) % options.length);
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
      else setOpen(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return <div ref={rootRef} className={`setting-menu ${className}`}>
    <button type="button" className="setting-select" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} disabled={disabled} title={title} onClick={() => setOpen((current) => !current)} onKeyDown={keyDown}>
      <span>{label}</span><strong className="setting-value">{(selected?.label ?? value) || placeholder}</strong><ChevronDown size={13} />
    </button>
    {open && <div id={menuId} className="setting-menu-panel" role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={`${option.id === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.id === value && <Check size={14} />}
      </button>)}
    </div>}
  </div>;
}

function clipboardTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function normalizeClipboardFile(file: File, timestamp: string, index: number): File {
  const genericName = !file.name || /^(image|blob|clipboard)(\.[a-z0-9]+)?$/i.test(file.name);
  if (!genericName) return file;
  const extensionByType: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "application/pdf": "pdf", "text/plain": "txt",
  };
  const extension = extensionByType[file.type] ?? file.name.split(".").pop()?.toLowerCase() ?? "bin";
  const prefix = file.type.startsWith("image/") ? "clipboard-image" : "clipboard-file";
  return new File([file], `${prefix}-${timestamp}-${index + 1}.${extension}`, { type: file.type, lastModified: Date.now() });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatVoiceDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
