import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type Dispatch, type DragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive, ArrowLeft, ArrowUp, BookOpen, Bot, Check, ChevronDown, CircleAlert, CircleDashed, Clock, Download, Eye, File as FileIcon, FileImage, FileText, Folder, FolderArchive, FolderOpen, Gauge, HardDrive,
  Copy, CornerUpLeft, GripVertical, KeyRound, LoaderCircle, LogOut, Menu, Mic, Minus, Monitor, MonitorUp, Moon, MoreHorizontal, Paperclip, Pause, Pencil, Pin, PinOff, Play, Plus, RefreshCw, RotateCcw, Search, Settings2, Share2, Square, SquarePen, Sun,
  Trash2, X, Zap,
} from "lucide-react";
import { api, BASE_PATH, fileThumbnailUrl, fileUrl, isApiErrorStatus, resumableUploadEndpoint, resumableUploadHeaders, setCsrf, type AgentOptions, type ComposerDraft, type Conversation, type ConversationActivity, type ConversationDetail, type ConversationPage, type DeploymentPhase, type DeploymentStatus, type Executor, type FileShareState, type Job, type JobEvent, type MaintenancePhase, type PendingPrompt, type Project, type ProjectDirectoryPage, type ReasoningEffort, type RemoteWorkerBootstrap, type Session, type SystemStatus, type WakePlan, type WorkFile } from "./api";
import { filePreviewIdFromPath, filePreviewUrl, fileReaderKind, isBrowserPreviewable, isLocalMarkdownUrl, publicFilePreviewIdFromPath, remoteMessageFileReferences, resolveMessageFileLink } from "./file-links";
import { sanitizeAgentMarkdown } from "./agent-content";
import { chooseComposerPrimaryAction } from "./composer-action";
import { chooseSelectedConversation, mergeJobEvents } from "./recovery";
import { resolveAccountIdentity } from "./account-identity";
import { accountSelectionStorageKeys, chooseSelectedProject, clearLegacySelectionStorage, readStoredSelection, writeStoredSelection } from "./account-selection-storage";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "./chat-font-size";
import { resolveScrollFollow } from "./scroll-follow";
import { applyThemePreference, GUEST_READER_THEME_PREFERENCE_KEY, readStoredThemePreference, resolveTheme, THEME_PREFERENCE_KEY, type ResolvedTheme, type ThemePreference } from "./theme";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection, visibleSelectionBounds } from "./ask-agent-selection";
import { mergeMessagePages, preservePrependedScrollTop, resolveUnreadScrollTarget } from "./message-history";
import { useAsyncMarkdownMath } from "./markdown-math";
import { buildProcessJournal, isNarrativeActivity } from "./process-journal";
import { buildSubagentActivity, subagentStatusLabel, type SubagentActivitySummary, type SubagentView } from "./subagent-activity";
import { resetProjectConversationPage } from "./project-conversation-page";
import { formatContextUsage, formatRolloutBytes, ROLLOUT_WARNING_BYTES, shouldWarnAboutRollout } from "./rollout-capacity";
import { conversationProjectMoveBlockReason, type ConversationProjectDrag } from "./conversation-project-move";
import { formatRemoteWorkerCapacity } from "./remote-worker-capacity";
import { recoverBrowserSession } from "./session-recovery";
import { mergeConversationMatches, removeConversationFromPage, retainSelectedConversation, sortConversationsByActivity } from "./conversation-search";
import { buildHandoffFirstTurn, CONTEXT_HANDOFF_PROMPT, latestContextHandoff } from "./context-handoff";
import { PersonalMemoryDialog } from "./personal-memory-dialog";
import { VoiceLexiconDialog } from "./voice-lexicon-dialog";
import { PublicSharesDialog } from "./public-shares-dialog";
import { canApplyDeferredInstanceReload } from "./reload-protection";
import { AccountAuthDialog } from "./account-auth-dialog";
import { DisplaySettingsDialog } from "./display-settings-dialog";
import { ProjectSkillsDialog } from "./project-skills-dialog";
import { markdownReaderOutline, prepareHtmlReaderDocument, type PreparedHtmlDocument } from "./file-reader-outline";
import { readReaderPosition, restoreReaderScrollTop, writeReaderPosition } from "./reader-position";
import { ReaderAskBubble, ReaderSelectionAction, useReaderSelection } from "./reader-ask";
import { ConversationVoicePanel } from "./conversation/ConversationVoiceInput";
import { useVoiceInput } from "./conversation/useVoiceInput";
import { ConversationMessageList } from "./conversation/ConversationMessageList";
import { ConversationComposerReference } from "./conversation/ConversationComposer";
import { SettingMenu } from "./conversation/SettingMenu";
import { formatConversationFullDateTime as formatFullDateTime, formatConversationMessageDateTime as formatMessageDateTime } from "./conversation/conversation-format";

const SIDEBAR_WIDTH_KEY = "cww:sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 520;
const CONVERSATION_PAGE_SIZE = 20;
const PROJECT_CONVERSATION_PAGE_SIZE = 5;
const BODY_SEARCH_RESULT_LIMIT = 100;
const MAINTENANCE_QUEUE_GUIDANCE = "系统正在维护，任务已保存到等待队列，维护完成后将自动开始。";
const COMPOSER_DRAFT_SAVE_DELAY_MS = 1_500;
const COMPOSER_LONG_PRESS_DELAY_MS = 650;
const COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX = 12;
const READER_POSITION_SAVE_DELAY_MS = 2_000;
const READER_POSITION_SAVE_INTERVAL_MS = 5_000;
const READER_POSITION_RESTORE_ATTEMPTS = 10;
const FILE_READER_MAX_BYTES = 5 * 1024 * 1024;
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 64 * 1024 * 1024;
const RESUMABLE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const HOST_ROOT_ACCOUNT_ID = "00000000-0000-4000-8000-000000000010";
const NEW_REMOTE_WORKER_OPTION = "__new_remote_worker__";

type DraftSaveState = "idle" | "unsaved" | "saving" | "saved" | "error";
type DraftUpload = { id: string; name: string; resumable: boolean; progress: number; status: "uploading" | "retrying" | "paused" | "error" };
type ProjectSearchState = {
  query: string;
  titleOffset: number;
  titleHasMore: boolean;
  bodyOffset: number;
  bodyHasMore: boolean;
};
type TusUploadClient = import("tus-js-client").Upload;
type CachedComposerDraft = { content: string; quoteExcerpt: string; composerDraft: ComposerDraft | null };
type DropPlacement = "before" | "after";
type ConversationDrag = ConversationProjectDrag & { pinned: boolean };
type ConversationProjectDropTarget = { projectId: string; allowed: boolean; reason: string | null };
type TouchDrag =
  | { kind: "project"; sourceId: string; targetId?: string; placement?: DropPlacement }
  | {
      kind: "conversation";
      sourceId: string;
      projectId: string;
      pinned: boolean;
      title: string;
      projectMoveBlocked: boolean;
      targetKind?: "conversation" | "project";
      targetId?: string;
      targetProjectId?: string;
      placement?: DropPlacement;
    };

function normalizedMaintenancePhase(phase: MaintenancePhase | undefined, maintenance: boolean | undefined): MaintenancePhase {
  return phase ?? (maintenance ? "active" : "idle");
}

function maintenanceStatusLabel(phase: MaintenancePhase, status: SystemStatus | null): string {
  if (phase === "active") return "维护中";
  if (phase !== "preparing") return "";
  const wait = status?.maintenanceWait;
  if (wait?.stalled) return "准备维护：任务可能停滞";
  if (wait?.taskTitle) return `准备维护：等待 ${wait.taskTitle}`;
  if (wait?.runningJobs) return `准备维护：等待 ${wait.runningJobs} 个任务`;
  return "准备维护";
}

const DEPLOYMENT_STAGES: Array<{ phase: DeploymentPhase; label: string }> = [
  { phase: "queued", label: "请求入队" },
  { phase: "building", label: "候选构建" },
  { phase: "candidate_ready", label: "候选就绪" },
  { phase: "waiting_for_jobs", label: "等待当前任务完成" },
  { phase: "promoting", label: "生产切换" },
  { phase: "health_check", label: "健康检查" },
];

function deploymentStageNumber(phase: DeploymentPhase): number {
  if (phase === "deployed") return DEPLOYMENT_STAGES.length;
  const index = DEPLOYMENT_STAGES.findIndex((stage) => stage.phase === phase);
  return index >= 0 ? index + 1 : 0;
}

function deploymentPhaseLabel(status: DeploymentStatus): string {
  if (status.phase === "deployed") return "最近发布已完成";
  if (status.phase === "failed") return "发布失败";
  if (status.phase === "conflict") return "发布冲突";
  if (status.phase === "deferred") return "发布已延期";
  return DEPLOYMENT_STAGES.find((stage) => stage.phase === status.phase)?.label ?? "发布处理中";
}

function deploymentStatusTone(status: DeploymentStatus): "active" | "success" | "error" {
  if (status.phase === "deployed") return "success";
  if (["failed", "conflict", "deferred"].includes(status.phase)) return "error";
  return "active";
}

function deploymentPhaseIsActive(phase: DeploymentPhase): boolean {
  return !["idle", "deployed", "superseded", "conflict", "deferred", "failed"].includes(phase);
}

function normalizeSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

function readStoredSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return stored === null ? SIDEBAR_WIDTH_DEFAULT : normalizeSidebarWidth(Number(stored));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function moveRelative<T extends { id: string }>(items: T[], id: string, targetId: string, placement: DropPlacement): T[] {
  if (id === targetId) return items;
  const moving = items.find((item) => item.id === id);
  if (!moving) return items;
  const next = items.filter((item) => item.id !== id);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return items;
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moving);
  return next;
}

function dropPlacement(event: DragEvent<HTMLElement>): DropPlacement {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

function elementDropPlacement(element: HTMLElement, clientY: number): DropPlacement {
  const bounds = element.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

function projectDropPlacement(event: DragEvent<HTMLDivElement>): DropPlacement {
  const projectRow = event.currentTarget.querySelector<HTMLElement>(".project-row");
  return projectRow ? elementDropPlacement(projectRow, event.clientY) : dropPlacement(event);
}

function projectDisplayName(name: string, machineName: string, executorKind: Executor["kind"]): string {
  return executorKind === "remote_worker" ? `[${machineName}]${name}` : name;
}

function composerDraftSignature(content: string, quoteExcerpt: string): string {
  return `${content}\u0000${quoteExcerpt}`;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [guestReaderThemePreference, setGuestReaderThemePreference] = useState<ThemePreference>(() => readStoredThemePreference(window.localStorage, GUEST_READER_THEME_PREFERENCE_KEY));
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const publicPreviewFileId = publicFilePreviewIdFromPath(window.location.pathname);
  const previewFileId = publicPreviewFileId ? null : filePreviewIdFromPath(window.location.pathname);
  const expireSession = useCallback(() => {
    setCsrf();
    setSession({ authenticated: false });
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const effectiveThemePreference = publicPreviewFileId ? guestReaderThemePreference : themePreference;
  useEffect(() => {
    applyThemePreference(effectiveThemePreference, systemPrefersDark);
    try {
      window.localStorage.setItem(publicPreviewFileId ? GUEST_READER_THEME_PREFERENCE_KEY : THEME_PREFERENCE_KEY, effectiveThemePreference);
    } catch { /* Browser privacy settings may disable storage. */ }
  }, [effectiveThemePreference, publicPreviewFileId, systemPrefersDark]);

  const resolvedTheme = resolveTheme(effectiveThemePreference, systemPrefersDark);

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

  if (publicPreviewFileId) return <PublicFilePreviewPage fileId={publicPreviewFileId} resolvedTheme={resolvedTheme} themePreference={guestReaderThemePreference} onThemePreferenceChange={setGuestReaderThemePreference} />;
  if (loading) return <div className="boot"><div className="brand-mark"><Zap size={20} /></div><LoaderCircle className="spin" /><span>正在恢复登录状态…</span></div>;
  if (!session?.authenticated) return <Login onLogin={(value) => { setCsrf(value.csrfToken); setSession(value); }} />;
  if (!session.accountId) return <div className="boot"><div className="brand-mark"><Zap size={20} /></div><span>账号信息不完整，请刷新后重新登录。</span></div>;
  if (previewFileId) return <FilePreviewPage fileId={previewFileId} userInitials={resolveAccountIdentity(session).initials} onSessionExpired={expireSession} resolvedTheme={resolvedTheme} themePreference={themePreference} onThemePreferenceChange={setThemePreference} />;
  return <Workspace key={session.accountId} session={session} onLogout={() => { setCsrf(); setSession({ authenticated: false }); }} themePreference={themePreference} onThemePreferenceChange={setThemePreference} />;
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

function readerNativeSelectionActive(container: HTMLElement): boolean {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  // During an iOS release WebKit can briefly expose a collapsed Range while
  // its native handles/menu are still being committed. Anchor/focus are still
  // inside the reader in that interval, so treat both collapsed and expanded
  // reader selections as browser-owned and avoid a React outline update.
  return Boolean(selection.anchorNode
    && selection.focusNode
    && container.contains(selection.anchorNode)
    && container.contains(selection.focusNode));
}

function updateReaderOutline(container: HTMLElement, headings: HTMLElement[], onActiveAnchorChange: (id: string) => void): void {
  // Updating the active TOC item is a React state change. Leave the document
  // completely quiet while WebKit owns a native selection/loupe transaction;
  // the next ordinary scroll will refresh the outline after the gesture.
  if (readerNativeSelectionActive(container)) return;
  if (headings.length < 2) return;
  // Author HTML can contain headings inside collapsed/removed controls. They
  // must not win the active-section calculation just because their DOM
  // position is still present while they are not rendered.
  const visibleHeadings = headings.filter((heading) => heading.getClientRects().length > 0);
  const candidates = visibleHeadings.length > 0 ? visibleHeadings : headings;
  const top = container.getBoundingClientRect().top;
  let current = candidates[0];
  for (const heading of candidates) {
    if (heading.getBoundingClientRect().top <= top + 96) current = heading;
    else break;
  }
  onActiveAnchorChange(current.id);
}

function HtmlFileReader({ file, content, activeAnchor, navigationToken }: {
  file: Pick<WorkFile, "original_name">;
  content: string;
  activeAnchor: string | null;
  navigationToken: number;
}) {
  const scrollRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeAnchor || navigationToken === 0 || !scrollRoot.current) return;
    const root = scrollRoot.current;
    const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === activeAnchor);
    if (!target) return;
    const rootRect = root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    root.scrollTo({ top: Math.max(0, root.scrollTop + targetRect.top - rootRect.top - 18), behavior: "smooth" });
  // Scroll-driven active-anchor changes must not trigger another smooth scroll.
  // This effect is intentionally keyed by the explicit TOC navigation token.
  }, [content, navigationToken]);

  return <div
    ref={scrollRoot}
    className="file-reader-html file-preview-scroll"
    role="document"
    aria-label={file.original_name || "HTML 文件预览"}
    dangerouslySetInnerHTML={{ __html: content }}
  />;
}

function FileReaderContent({ file, content, prepared, activeAnchor, navigationToken }: {
  file: Pick<WorkFile, "original_name" | "mime_type">;
  content: string;
  prepared: PreparedHtmlDocument;
  activeAnchor: string | null;
  navigationToken: number;
}) {
  const readerKind = fileReaderKind(file);
  const math = useAsyncMarkdownMath(content);
  if (readerKind === "markdown") return <div className="file-preview-scroll">
    <article className="file-reader-markdown markdown">
      {(() => {
        let headingCursor = 0;
        return <ReactMarkdown
          remarkPlugins={math.plugins ? [remarkGfm, math.plugins.remarkMath] : [remarkGfm]}
          rehypePlugins={math.plugins ? [[math.plugins.rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]] : []}
          skipHtml
          urlTransform={defaultUrlTransform}
          components={{
            h2: ({ children, ...props }) => {
              const item = prepared.outline[headingCursor++];
              return <h2 id={item?.id} {...props}>{children}</h2>;
            },
            a: ({ href, children }) => href?.startsWith("#")
              ? <a href={href}>{children}</a>
              : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
            img: ({ node: _node, alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" />,
            table: ({ node: _node, ...props }) => <div className="file-reader-table"><table {...props} /></div>,
          }}
        >{math.content}</ReactMarkdown>;
      })()}
    </article>
  </div>;
  if (readerKind === "html") return <HtmlFileReader file={file} content={prepared.content} activeAnchor={activeAnchor} navigationToken={navigationToken} />;
  return null;
}

// Status polling updates the reader header every few seconds. Keep those
// unrelated parent renders out of the document DOM so an active native Safari
// selection never has to survive needless reader reconciliation.
const FileReaderLayout = memo(function FileReaderLayout({ file, content, prepared, tocOpen, activeAnchor, onSelect, onActiveAnchorChange, navigationToken }: {
  file: Pick<WorkFile, "id" | "original_name" | "mime_type">;
  content: string;
  prepared: PreparedHtmlDocument;
  tocOpen: boolean;
  activeAnchor: string | null;
  onSelect: (id: string) => void;
  onActiveAnchorChange: (id: string) => void;
  navigationToken: number;
}) {
  const scrollRoot = useRef<HTMLDivElement>(null);
  const readerKind = fileReaderKind(file);
  const showOutline = prepared.outline.length >= 2;

  useEffect(() => {
    const documentRoot = scrollRoot.current;
    if (!documentRoot || !file.id) return;
    const container = documentRoot.querySelector<HTMLElement>(".file-preview-scroll");
    if (!container) return;

    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* Storage can be disabled in private browsing. */ }
    const saved = readReaderPosition(storage, file.id);
    let restored = false;
    let restoreAttempts = 0;
    let restoreTimer: number | null = null;
    let saveTimer: number | null = null;

    const headings = Array.from(container.querySelectorAll<HTMLElement>("h2[id]"));
    const syncActiveHeading = () => updateReaderOutline(container, headings, onActiveAnchorChange);
    const restore = () => {
      restoreTimer = null;
      if (!saved) {
        // The reader DOM is reused when navigating between files. Without an
        // explicit reset, a new file inherits the previous file's bottom
        // position even though it has never been opened before.
        container.scrollTop = 0;
        restored = true;
        window.requestAnimationFrame(syncActiveHeading);
        return;
      }
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      // Images and KaTeX can expand the document after the first paint. Retry a
      // few times while the saved position still cannot be represented.
      if (saved.scrollTop > 0 && maxScrollTop === 0 && restoreAttempts < READER_POSITION_RESTORE_ATTEMPTS) {
        restoreAttempts += 1;
        restoreTimer = window.setTimeout(restore, 120);
        return;
      }
      container.scrollTop = restoreReaderScrollTop(saved, container.scrollHeight, container.clientHeight);
      restored = true;
      window.requestAnimationFrame(syncActiveHeading);
    };

    const save = () => {
      saveTimer = null;
      if (!restored) return;
      writeReaderPosition(storage, file.id, {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        updatedAt: Date.now(),
      });
    };
    const scheduleSave = () => {
      if (!restored) return;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, READER_POSITION_SAVE_DELAY_MS);
    };
    const flushSave = () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = null;
      save();
    };
    const handleVisibilityChange = () => { if (document.visibilityState === "hidden") flushSave(); };

    container.addEventListener("scroll", scheduleSave, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushSave);
    restoreTimer = window.setTimeout(restore, 0);
    const interval = window.setInterval(save, READER_POSITION_SAVE_INTERVAL_MS);
    return () => {
      if (restoreTimer !== null) window.clearTimeout(restoreTimer);
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      window.clearInterval(interval);
      flushSave();
      container.removeEventListener("scroll", scheduleSave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushSave);
    };
  }, [content, file.id, onActiveAnchorChange, prepared.content]);

  useEffect(() => {
    if (readerKind !== "markdown" || navigationToken === 0 || !activeAnchor || !scrollRoot.current) return;
    const target = Array.from(scrollRoot.current.querySelectorAll<HTMLElement>("[id]"))
      .find((element) => element.id === activeAnchor);
    const container = target?.closest<HTMLElement>(".file-preview-scroll");
    if (target && container) container.scrollTo({ top: Math.max(0, target.offsetTop - 18), behavior: "smooth" });
  // Scroll-driven active-anchor changes must not trigger another smooth scroll.
  // This effect is intentionally keyed by the explicit TOC navigation token.
  }, [navigationToken, readerKind]);

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
    updateReaderOutline(container, headings, onActiveAnchorChange);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      container.removeEventListener("scroll", updateCurrentHeading);
    };
  }, [onActiveAnchorChange, prepared.content]);

  return <div className={`file-reader-layout${showOutline && tocOpen ? " outline-open" : ""}`}>
    {showOutline && tocOpen && <aside id="file-reader-outline" className="file-reader-outline" aria-label="文章目录">
      <h2>文章目录</h2>
      <ol>{prepared.outline.map((item) => <li key={item.id}>
        <a href={`#${encodeURIComponent(item.id)}`} aria-current={activeAnchor === item.id ? "location" : undefined} onClick={(event) => { event.preventDefault(); onSelect(item.id); }}>{item.label}</a>
      </li>)}</ol>
    </aside>}
    <div ref={scrollRoot} className="file-reader-document">
      <FileReaderContent file={file} content={content} prepared={prepared} activeAnchor={activeAnchor && readerKind === "html" ? activeAnchor : null} navigationToken={navigationToken} />
    </div>
  </div>;
});

function ReaderSelectionLayer({ rootRef, onAsk }: {
  rootRef: RefObject<HTMLElement | null>;
  onAsk: (text: string) => void;
}) {
  const selection = useReaderSelection(rootRef);
  return selection ? <ReaderSelectionAction selection={selection} onAsk={onAsk} /> : null;
}

function FileShareDialog({ file, share, onChange, open, onClose }: { file: Pick<WorkFile, "id" | "original_name">; share: FileShareState; onChange: (share: FileShareState) => void; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  const closeDialog = useCallback(() => {
    onClose();
    setError("");
  }, [onClose]);

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

  return open ? createPortal(<div className="file-share-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
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
    </div>, document.body) : null;
}

function ReaderSettingsMenu({ file, share, download, themePreference, onThemePreferenceChange, onShareChange }: {
  file: Pick<WorkFile, "id" | "original_name">;
  share: FileShareState | null;
  download: string | null;
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onShareChange: (share: FileShareState) => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    };
    const closeEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && menu.current?.open) menu.current.open = false; };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, []);

  return <details ref={menu} className="file-reader-settings-menu">
    <summary className="file-reader-settings-button" title="阅读器设置" aria-label="阅读器设置" aria-haspopup="menu"><Settings2 size={18} /></summary>
    <div className="file-reader-settings-popover" role="menu" aria-label="阅读器设置选项">
      {share && <button className="file-reader-settings-item" type="button" role="menuitem" onClick={() => { if (menu.current) menu.current.open = false; setShareOpen(true); }}><Share2 size={15} /><span>分享</span></button>}
      {download && <a className="file-reader-settings-item" role="menuitem" href={download} download={file.original_name} onClick={() => { if (menu.current) menu.current.open = false; }}><Download size={15} /><span>下载</span></a>}
      {(share || download) && <div className="file-reader-settings-divider" />}
      <div className="file-reader-theme-label">颜色模式</div>
      <div className="file-reader-theme-options" role="group" aria-label="颜色模式">
        <button type="button" aria-label="使用浅色模式" aria-pressed={themePreference === "light"} className={themePreference === "light" ? "selected" : ""} onClick={() => onThemePreferenceChange("light")}><Sun size={14} /><span>浅色</span></button>
        <button type="button" aria-label="使用深色模式" aria-pressed={themePreference === "dark"} className={themePreference === "dark" ? "selected" : ""} onClick={() => onThemePreferenceChange("dark")}><Moon size={14} /><span>深色</span></button>
        <button type="button" aria-label="外观跟随系统" aria-pressed={themePreference === "system"} className={themePreference === "system" ? "selected" : ""} onClick={() => onThemePreferenceChange("system")}><Monitor size={14} /><span>系统</span></button>
      </div>
    </div>
    {share && <FileShareDialog file={file} share={share} onChange={onShareChange} open={shareOpen} onClose={() => setShareOpen(false)} />}
  </details>;
}

function preparedReaderDocument(file: Pick<WorkFile, "mime_type" | "original_name"> | null, content: string | null, resolvedTheme: ResolvedTheme): PreparedHtmlDocument {
  if (!file || content === null) return { content: content ?? "", outline: [] };
  if (fileReaderKind(file) === "html") return prepareHtmlReaderDocument(content, resolvedTheme);
  if (fileReaderKind(file) === "markdown") return { content, outline: markdownReaderOutline(content) };
  return { content, outline: [] };
}

function useOutlineState(prepared: PreparedHtmlDocument) {
  const hasOutline = prepared.outline.length >= 2;
  const [open, setOpen] = useState(false);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [navigationToken, setNavigationToken] = useState(0);
  useEffect(() => {
    setActiveAnchor(hasOutline ? prepared.outline[0]?.id ?? null : null);
    setNavigationToken(0);
    setOpen(hasOutline && (window.matchMedia?.("(min-width: 721px)").matches ?? true));
  }, [hasOutline, prepared.content]);
  const select = useCallback((id: string) => {
    setActiveAnchor(id);
    setNavigationToken((value) => value + 1);
  }, []);
  const updateFromScroll = useCallback((id: string) => {
    setActiveAnchor((current) => current === id ? current : id);
  }, []);
  return { hasOutline, open, setOpen, activeAnchor, navigationToken, select, updateFromScroll };
}

function FilePreviewPage({ fileId, userInitials, onSessionExpired, resolvedTheme, themePreference, onThemePreferenceChange }: { fileId: string; userInitials: string; onSessionExpired: () => void; resolvedTheme: ResolvedTheme; themePreference: ThemePreference; onThemePreferenceChange: (preference: ThemePreference) => void }) {
  const [file, setFile] = useState<WorkFile | null>(null);
  const [conversation, setConversation] = useState<import("./api").FilePreviewMetadata["conversation"] | null>(null);
  const [conversationActivity, setConversationActivity] = useState<import("./api").ConversationActivity | null>(null);
  const [share, setShare] = useState<FileShareState | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askClosing, setAskClosing] = useState(false);
  const [askQuote, setAskQuote] = useState("");
  const readerBodyRef = useRef<HTMLElement>(null);
  const askCloseTimerRef = useRef<number | null>(null);
  const readerKind = file ? fileReaderKind(file) : null;
  const prepared = useMemo(() => preparedReaderDocument(file, content, resolvedTheme), [file, content, resolvedTheme]);
  const outline = useOutlineState(prepared);

  function openReaderAsk(selectedText: string) {
    if (askCloseTimerRef.current !== null) window.clearTimeout(askCloseTimerRef.current);
    setAskQuote(normalizeAskAgentSelection(selectedText).slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1));
    setAskClosing(false); setAskOpen(true);
  }

  function closeReaderAsk() {
    if (!askOpen || askClosing) return;
    setAskClosing(true);
    askCloseTimerRef.current = window.setTimeout(() => { askCloseTimerRef.current = null; setAskOpen(false); setAskClosing(false); }, 230);
  }

  useEffect(() => () => {
    if (askCloseTimerRef.current !== null) window.clearTimeout(askCloseTimerRef.current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setContent(null);
    void (async () => {
      try {
        const metadata = await api.filePreview(fileId, controller.signal);
        if (controller.signal.aborted) return;
        setFile(metadata.file); setConversation(metadata.conversation); setShare(metadata.share);
        setConversationActivity({
          conversationStatus: metadata.conversation.status,
          externalStatus: metadata.conversation.external_status,
          hasUnreadResult: Boolean(metadata.conversation.has_unread_result),
          hasPendingWork: Boolean(metadata.conversation.has_pending_work),
          activeJob: null,
          latestJob: null,
          jobEvents: [],
          remoteTurnId: null,
          remoteActivities: [],
        });
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
    const conversationId = conversation?.id;
    if (!conversationId) return;
    let stopped = false;
    const refreshActivity = async () => {
      try {
        const activity = await api.conversationActivity(conversationId);
        if (!stopped) setConversationActivity(activity);
      } catch { /* The reader remains usable during a transient status request failure. */ }
    };
    void refreshActivity();
    const interval = window.setInterval(() => void refreshActivity(), 2_500);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [conversation?.id]);

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
  const taskRunning = Boolean(conversationActivity?.activeJob || conversationActivity?.externalStatus === "running" || conversationActivity?.conversationStatus === "running");
  const hasUnreadResult = Boolean(conversationActivity?.hasUnreadResult || conversation?.has_unread_result);
  return <main className={`file-preview-page ${readerKind ?? ""}`}>
    <header className="file-preview-header">
      <div className="file-preview-header-start">
        <a className="file-preview-back" href={BASE_PATH || "/"} title="返回工作站" aria-label="返回工作站"><ArrowLeft size={18} /></a>
        {conversation && <button type="button" className={`file-reader-ask-launcher${askOpen ? " active" : ""}`} onClick={() => { if (askClosing) return; if (askOpen) closeReaderAsk(); else { setAskClosing(false); setAskOpen(true); } }} title={askOpen ? "收起询问 Agent" : "返回询问 Agent"} aria-label={askOpen ? "收起询问 Agent" : "返回询问 Agent"} aria-pressed={askOpen}><Bot size={17} />{taskRunning ? <LoaderCircle className="spin" size={10} /> : hasUnreadResult ? <i className="unread" /> : null}</button>}
        {outline.hasOutline && <button className={`file-preview-toc-toggle${outline.open ? " active" : ""}`} type="button" title={outline.open ? "收起文章目录" : "打开文章目录"} aria-label={outline.open ? "收起文章目录" : "打开文章目录"} aria-expanded={outline.open} aria-controls="file-reader-outline" onClick={() => outline.setOpen((value) => !value)}><Menu size={18} /></button>}
      </div>
      <div className="file-preview-title"><strong>{file?.original_name || "正在读取文件…"}</strong></div>
      <div className="file-preview-actions">
        {file && <ReaderSettingsMenu file={file} share={share} download={download} themePreference={themePreference} onThemePreferenceChange={onThemePreferenceChange} onShareChange={setShare} />}
      </div>
    </header>
    <section ref={readerBodyRef} className="file-preview-body">
      {loading && <div className="file-preview-state"><LoaderCircle className="spin" size={24} /><p>正在安全读取原文件…</p></div>}
      {!loading && error && <div className="file-preview-state error"><FileText size={28} /><strong>暂时无法在线阅读</strong><p>{error}</p>{file && <a href={download} download={file.original_name}>下载原文件</a>}</div>}
      {!loading && !error && content !== null && file && <FileReaderLayout file={file} content={content} prepared={prepared} tocOpen={outline.open} activeAnchor={outline.activeAnchor} onSelect={outline.select} onActiveAnchorChange={outline.updateFromScroll} navigationToken={outline.navigationToken} />}
      <ReaderSelectionLayer rootRef={readerBodyRef} onAsk={openReaderAsk} />
      {conversation && (askOpen || askClosing) && <ReaderAskBubble conversationId={conversation.id} conversationTitle={conversation.title} quoteExcerpt={askQuote} quoteLabel={file?.original_name} userInitials={userInitials} open={askOpen || askClosing} closing={askClosing} onClose={closeReaderAsk} />}
    </section>
  </main>;
}

function PublicFilePreviewPage({ fileId, resolvedTheme, themePreference, onThemePreferenceChange }: { fileId: string; resolvedTheme: ResolvedTheme; themePreference: ThemePreference; onThemePreferenceChange: (preference: ThemePreference) => void }) {
  const viewId = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [file, setFile] = useState<Pick<WorkFile, "id" | "original_name" | "mime_type" | "size" | "kind"> | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const readerKind = file ? fileReaderKind(file) : null;
  const prepared = useMemo(() => preparedReaderDocument(file, content, resolvedTheme), [file, content, resolvedTheme]);
  const outline = useOutlineState(prepared);

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
      <div className="file-preview-header-start">
        {outline.hasOutline && <button className={`file-preview-toc-toggle${outline.open ? " active" : ""}`} type="button" title={outline.open ? "收起文章目录" : "打开文章目录"} aria-label={outline.open ? "收起文章目录" : "打开文章目录"} aria-expanded={outline.open} aria-controls="file-reader-outline" onClick={() => outline.setOpen((value) => !value)}><Menu size={18} /></button>}
      </div>
      <div className="file-preview-title"><strong>{file?.original_name || "公开文件"}</strong></div>
      <div className="file-preview-actions">
        {file && <ReaderSettingsMenu file={file} share={null} download={null} themePreference={themePreference} onThemePreferenceChange={onThemePreferenceChange} onShareChange={() => undefined} />}
      </div>
    </header>
    <section className="file-preview-body">
      {loading && <div className="file-preview-state"><LoaderCircle className="spin" size={24} /><p>正在读取公开文件…</p></div>}
      {!loading && error && <div className="file-preview-state error"><FileText size={28} /><strong>暂时无法在线阅读</strong><p>{error}</p></div>}
      {!loading && !error && content !== null && file && <FileReaderLayout file={file} content={content} prepared={prepared} tocOpen={outline.open} activeAnchor={outline.activeAnchor} onSelect={outline.select} onActiveAnchorChange={outline.updateFromScroll} navigationToken={outline.navigationToken} />}
    </section>
  </main>;
}

type SearchVoiceInputProps = {
  query: string;
  projectId?: string | null;
  disabled?: boolean;
  onTranscript: (text: string) => void;
};

function SearchVoiceInput({ query, projectId, disabled = false, onTranscript }: SearchVoiceInputProps) {
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [longPressArmed, setLongPressArmed] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const recordingLimitRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const queryRef = useRef(query);
  const projectIdRef = useRef(projectId);
  const recordingProjectIdRef = useRef(projectId);
  const pressTimerRef = useRef<number | null>(null);
  const pressPointerRef = useRef<{ pointerId: number; startX: number; startY: number; triggered: boolean } | null>(null);
  const releaseAfterLongPressRef = useRef(false);
  const skipClickRef = useRef(false);
  queryRef.current = query;
  projectIdRef.current = projectId;

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
        const width = Math.max(1, canvas.clientWidth * window.devicePixelRatio);
        const height = Math.max(1, canvas.clientHeight * window.devicePixelRatio);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.clearRect(0, 0, width, height);
        context.fillStyle = "#f0aa3c";
        const bars = 24; const gap = 2 * window.devicePixelRatio; const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
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
    if (disabled || voiceState !== "idle") return;
    setVoiceError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("当前浏览器不支持录音，请改用最新版 Chrome、Edge 或 Safari。");
      return;
    }
    discardRecordingRef.current = false;
    recordingProjectIdRef.current = projectIdRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream; recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        discardRecordingRef.current = true;
        if (recorder.state === "recording") recorder.stop();
        releaseAudio(); setVoiceError("录音中断，请检查麦克风权限后重试。"); setVoiceState("idle");
      };
      recorder.onstop = () => void processRecording(recorder.mimeType || mimeType || "audio/webm");
      recorder.start(250);
      setVoiceElapsed(0); setVoiceState("recording");
      const startedAt = Date.now();
      durationTimerRef.current = window.setInterval(() => setVoiceElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
      recordingLimitRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") { recorder.stop(); setVoiceState("transcribing"); }
      }, 5 * 60 * 1000);
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audioContext = new AudioContextClass(); audioContextRef.current = audioContext;
        const analyser = audioContext.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .76;
        audioContext.createMediaStreamSource(stream).connect(analyser); drawWaveform(analyser);
      }
      if (releaseAfterLongPressRef.current) { releaseAfterLongPressRef.current = false; window.setTimeout(() => finishRecording(), 0); }
    } catch (reason) {
      releaseAudio(); setVoiceState("idle");
      const denied = reason instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(reason.name);
      setVoiceError(denied ? "请允许浏览器使用麦克风，然后再试一次。" : "无法开始录音，请检查麦克风是否可用。");
    }
  }

  function finishRecording() {
    if (voiceState !== "recording" || recorderRef.current?.state !== "recording") return;
    recorderRef.current.stop(); setVoiceState("transcribing");
  }

  function cancelRecording() {
    if (voiceState !== "recording") return;
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    releaseAudio(); recorderRef.current = null; chunksRef.current = [];
    setVoiceState("idle"); setVoiceElapsed(0);
  }

  async function processRecording(mimeType: string) {
    releaseAudio(); recorderRef.current = null;
    if (discardRecordingRef.current) { chunksRef.current = []; setVoiceState("idle"); setVoiceElapsed(0); return; }
    const blob = new Blob(chunksRef.current, { type: mimeType }); chunksRef.current = [];
    if (blob.size === 0) { setVoiceError("没有录到声音，请重新录制。"); setVoiceState("idle"); return; }
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "webm";
    try {
      const result = await api.transcribeAudio(blob, `search-recording.${extension}`, {
        projectId: recordingProjectIdRef.current ?? undefined,
        draftText: queryRef.current,
        purpose: "search",
      });
      onTranscript(result.text);
      setVoiceState("idle"); setVoiceElapsed(0);
    } catch (reason) {
      setVoiceError(reason instanceof Error ? reason.message : "语音识别失败，请重试。");
      setVoiceState("idle");
    }
  }

  function clearPress(pointerId?: number) {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
    const pointer = pressPointerRef.current;
    if (pointer && (pointerId === undefined || pointer.pointerId === pointerId)) pressPointerRef.current = null;
    setLongPressArmed(false);
  }

  function beginPress(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== "touch" || !event.isPrimary || disabled || voiceState === "transcribing") return;
    clearPress();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    pressPointerRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, triggered: false };
    setLongPressArmed(true);
    pressTimerRef.current = window.setTimeout(() => {
      const pointer = pressPointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      pointer.triggered = true; setLongPressArmed(false); void startRecording();
    }, COMPOSER_LONG_PRESS_DELAY_MS);
  }

  function movePress(event: ReactPointerEvent<HTMLButtonElement>) {
    const pointer = pressPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || pointer.triggered) return;
    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX) clearPress(event.pointerId);
  }

  function endPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const pointer = pressPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const triggered = pointer.triggered;
    clearPress(event.pointerId); skipClickRef.current = true;
    if (triggered) {
      if (voiceState === "recording") finishRecording(); else releaseAfterLongPressRef.current = true;
    } else if (voiceState === "idle") void startRecording();
    window.setTimeout(() => { skipClickRef.current = false; }, 0);
  }

  function handleClick() {
    if (skipClickRef.current || disabled || voiceState === "transcribing") return;
    if (voiceState === "recording") finishRecording(); else void startRecording();
  }

  useEffect(() => {
    const cancel = () => clearPress();
    window.addEventListener("blur", cancel); document.addEventListener("visibilitychange", cancel);
    return () => { window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", cancel); };
  }, []);
  useEffect(() => () => { discardRecordingRef.current = true; if (recorderRef.current?.state === "recording") recorderRef.current.stop(); releaseAudio(); }, []);

  return <>
    <button type="button" className={`search-mic-button ${voiceState !== "idle" ? "active" : ""} ${longPressArmed ? "long-press-armed" : ""}`} onClick={handleClick} onPointerDown={beginPress} onPointerMove={movePress} onPointerUp={endPress} onPointerCancel={() => clearPress()} onContextMenu={(event) => event.preventDefault()} disabled={disabled || voiceState === "transcribing"} title={voiceState === "recording" ? "停止并搜索" : "语音搜索（长按说话）"} aria-label={voiceState === "recording" ? "停止并搜索" : "语音搜索"}>
      {voiceState === "recording" ? <Square size={15} fill="currentColor" /> : voiceState === "transcribing" ? <LoaderCircle className="spin" size={16} /> : <Mic size={17} />}
    </button>
    {voiceState !== "idle" && <div className={`search-voice-panel ${voiceState}`}>
      {voiceState === "recording" ? <><button type="button" className="search-voice-cancel" onClick={cancelRecording} title="取消录音" aria-label="取消录音"><X size={13} /></button><canvas ref={waveformRef} aria-label="实时音量波形" /><time>{formatVoiceDuration(voiceElapsed)}</time><button type="button" className="search-voice-stop" onClick={finishRecording} title="停止并搜索" aria-label="停止并搜索"><Square size={10} fill="currentColor" /></button></> : <><LoaderCircle className="spin" size={15} /><span>正在识别语音关键词…</span></>}
    </div>}
    {voiceError && <div className="search-voice-error" role="alert"><span>{voiceError}</span><button type="button" onClick={() => setVoiceError("")} aria-label="关闭语音搜索错误"><X size={12} /></button></div>}
  </>;
}

function Workspace({ session, onLogout, themePreference, onThemePreferenceChange }: { session: Session; onLogout: () => void; themePreference: ThemePreference; onThemePreferenceChange: (preference: ThemePreference) => void }) {
  const selectionStorageKeys = useMemo(() => accountSelectionStorageKeys(session.accountId!), [session.accountId]);
  const savedProjectIdRef = useRef(readStoredSelection(window.localStorage, selectionStorageKeys.project));
  const savedConversationIdRef = useRef(readStoredSelection(window.localStorage, selectionStorageKeys.conversation));
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectConversationPages, setProjectConversationPages] = useState<Record<string, ConversationPage>>({});
  const [projectPageLoading, setProjectPageLoading] = useState<Record<string, boolean>>({});
  const [projectBodySearchLoading, setProjectBodySearchLoading] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversationHasMore, setConversationHasMore] = useState(false);
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [conversationBodySearchLoading, setConversationBodySearchLoading] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectSkillsDialogProject, setProjectSkillsDialogProject] = useState<Project | null>(null);
  const [syncingProjects, setSyncingProjects] = useState<Record<string, boolean>>({});
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; top: number; left: number } | null>(null);
  const [projectSectionMenu, setProjectSectionMenu] = useState<{ top: number; left: number } | null>(null);
  const [taskMenu, setTaskMenu] = useState<{ conversationId: string; top: number; left: number } | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{ id: string; placement: DropPlacement } | null>(null);
  const [draggedConversation, setDraggedConversation] = useState<ConversationDrag | null>(null);
  const [conversationDropTarget, setConversationDropTarget] = useState<{ id: string; placement: DropPlacement } | null>(null);
  const [conversationProjectDropTarget, setConversationProjectDropTarget] = useState<ConversationProjectDropTarget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversationSelectionReady, setConversationSelectionReady] = useState(false);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [askAgentQuote, setAskAgentQuote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null);
  const [draftUploads, setDraftUploads] = useState<DraftUpload[]>([]);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [maintenancePhase, setMaintenancePhase] = useState<MaintenancePhase>(() => normalizedMaintenancePhase(session.maintenancePhase, session.maintenance));
  const [maintenanceStatus, setMaintenanceStatus] = useState<SystemStatus | null>(null);
  const [voiceInputActive, setVoiceInputActive] = useState(false);
  const [instanceReloadDeferred, setInstanceReloadDeferred] = useState(false);
  const [editingPending, setEditingPending] = useState<PendingPrompt | null>(null);
  const [removedEditingFileIds, setRemovedEditingFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [activities, setActivities] = useState<JobEvent[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(false);
  const [error, setError] = useState("");
  const [cleanupRetry, setCleanupRetry] = useState<Conversation | null>(null);
  const [notice, setNotice] = useState("");
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [executorCatalogEpoch, setExecutorCatalogEpoch] = useState(0);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [displaySettingsDialogOpen, setDisplaySettingsDialogOpen] = useState(false);
  const [archivedDialogOpen, setArchivedDialogOpen] = useState(false);
  const [personalMemoryDialogOpen, setPersonalMemoryDialogOpen] = useState(false);
  const [voiceLexiconDialogOpen, setVoiceLexiconDialogOpen] = useState(false);
  const [publicSharesDialogOpen, setPublicSharesDialogOpen] = useState(false);
  const [accountAuthDialogOpen, setAccountAuthDialogOpen] = useState(false);
  const [wakeDialogConversation, setWakeDialogConversation] = useState<Conversation | null>(null);
  const [wakeDetailsConversation, setWakeDetailsConversation] = useState<Conversation | null>(null);
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
  const conversationMenuRef = useRef<HTMLDetailsElement>(null);
  const rolloutWarningRef = useRef<HTMLDetailsElement>(null);
  const accountAreaRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const connectedJobRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const retainedConversationRef = useRef<Conversation | null>(null);
  const editingPendingRef = useRef<PendingPrompt | null>(editingPending);
  const activeProjectIdRef = useRef<string | null>(activeProjectId);
  const projectConversationPagesRef = useRef(projectConversationPages);
  const projectSearchStateRef = useRef<Record<string, ProjectSearchState>>({});
  const collapsedProjectsRef = useRef(collapsedProjects);
  const projectCollapseSaveQueueRef = useRef(new Map<string, Promise<void>>());
  const projectPageGenerationRef = useRef<Record<string, number>>({});
  const projectPageRequestsRef = useRef(new Set<string>());
  const queryRef = useRef(query);
  const conversationLimitRef = useRef(CONVERSATION_PAGE_SIZE);
  const conversationListLoadingRef = useRef(false);
  const conversationsRef = useRef<Conversation[]>(conversations);
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
  const touchDragRef = useRef<TouchDrag | null>(null);
  const sidebarResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const executorCatalogTimesRef = useRef(new Map<string, string | null>());
  const serverInstanceIdRef = useRef<string | null>(null);
  const maintenancePhaseRef = useRef(maintenancePhase);
  const deploymentPhaseRef = useRef<DeploymentPhase>("idle");
  const voiceInputActiveRef = useRef(false);
  const instanceReloadDeferredRef = useRef(false);
  const conversationSelectionReadyRef = useRef(false);
  const creatingConversationProjectsRef = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  editingPendingRef.current = editingPending;
  activeProjectIdRef.current = activeProjectId;
  projectConversationPagesRef.current = projectConversationPages;
  collapsedProjectsRef.current = collapsedProjects;
  queryRef.current = query;
  conversationsRef.current = conversations;
  inputRef.current = input;
  askAgentQuoteRef.current = askAgentQuote;
  composerDraftRef.current = composerDraft;
  draftUploadsRef.current = draftUploads;
  maintenancePhaseRef.current = maintenancePhase;

  useEffect(() => clearLegacySelectionStorage(window.localStorage), []);

  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch { /* Browser privacy settings may disable storage. */ }
  }, [sidebarWidth]);

  useEffect(() => () => document.documentElement.classList.remove("sidebar-resizing"), []);

  useEffect(() => {
    const source = new EventSource(`${BASE_PATH}/api/system/events`);
    let stopped = false;
    let statusRefreshInFlight = false;
    const applySystemStatus = (status: SystemStatus): boolean => {
      if (serverInstanceIdRef.current && status.instanceId && serverInstanceIdRef.current !== status.instanceId) {
        serverInstanceIdRef.current = status.instanceId;
        if (voiceInputActiveRef.current || instanceReloadDeferredRef.current) {
          instanceReloadDeferredRef.current = true;
          setInstanceReloadDeferred(true);
        } else {
          source.close();
          window.location.reload();
          return false;
        }
      }
      if (status.instanceId) serverInstanceIdRef.current = status.instanceId;
      const phase = normalizedMaintenancePhase(status.maintenancePhase, status.maintenance);
      maintenancePhaseRef.current = phase;
      deploymentPhaseRef.current = status.deployment?.phase ?? "idle";
      setMaintenancePhase(phase);
      setMaintenanceStatus(status);
      return true;
    };
    const refreshSystemStatus = async () => {
      if (stopped || statusRefreshInFlight) return;
      statusRefreshInFlight = true;
      try { applySystemStatus(await api.systemStatus()); }
      catch { /* SSE reconnect and the next bounded poll remain available. */ }
      finally { statusRefreshInFlight = false; }
    };
    source.onmessage = (event) => {
      try {
        const status = JSON.parse(event.data) as SystemStatus & {
          type?: string;
          executors?: Executor[];
          projectId?: string;
          conversationId?: string;
          fromProjectId?: string;
          toProjectId?: string;
          executorId?: string;
        };
        if (status.type === "system_status") {
          if (!applySystemStatus(status)) return;
        }
        if (status.type === "executor_status" && status.executors) {
          const executors = new Map(status.executors.map((executor) => [executor.id, executor]));
          let catalogChanged = false;
          for (const executor of status.executors) {
            const next = executor.runtime?.catalogUpdatedAt ?? null;
            if (executorCatalogTimesRef.current.has(executor.id) && executorCatalogTimesRef.current.get(executor.id) !== next) catalogChanged = true;
            executorCatalogTimesRef.current.set(executor.id, next);
          }
          if (catalogChanged) setExecutorCatalogEpoch((value) => value + 1);
          setProjects((current) => current.map((project) => {
            const executor = executors.get(project.executor_id);
            return executor ? {
              ...project,
              machine_name: executor.machineName,
              executor_status: executor.status,
              executor_last_seen_at: executor.lastSeenAt,
              display_name: projectDisplayName(project.name, executor.machineName, executor.kind),
            } : project;
          }));
        }
        if (status.type === "executor_quota" && status.executorId) {
          window.dispatchEvent(new CustomEvent("codex-web-executor-quota-changed", {
            detail: { executorId: status.executorId },
          }));
        }
        if (status.type === "conversation_changed" && status.projectId && status.conversationId) {
          window.dispatchEvent(new CustomEvent("codex-web-conversation-changed", {
            detail: { projectId: status.projectId, conversationId: status.conversationId },
          }));
        }
        if (status.type === "conversation_moved" && status.conversationId && status.fromProjectId && status.toProjectId) {
          window.dispatchEvent(new CustomEvent("codex-web-conversation-moved", {
            detail: {
              conversationId: status.conversationId,
              fromProjectId: status.fromProjectId,
              toProjectId: status.toProjectId,
            },
          }));
        }
      } catch { /* A malformed status event must not interrupt normal chat updates. */ }
    };
    source.onerror = () => { void refreshSystemStatus(); };
    const reconcileTimer = window.setInterval(() => {
      if (maintenancePhaseRef.current !== "idle" || deploymentPhaseIsActive(deploymentPhaseRef.current) || source.readyState !== EventSource.OPEN) void refreshSystemStatus();
    }, 2_000);
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshSystemStatus();
    };
    window.addEventListener("focus", reconcileWhenVisible);
    window.addEventListener("online", reconcileWhenVisible);
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => {
      stopped = true;
      source.close();
      window.clearInterval(reconcileTimer);
      window.removeEventListener("focus", reconcileWhenVisible);
      window.removeEventListener("online", reconcileWhenVisible);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }, []);

  const refreshList = useCallback(async (reset = false, projectId = activeProjectIdRef.current, preserveSearchMatches = true) => {
    if (!session.projectMode) {
      if (reset) conversationLimitRef.current = CONVERSATION_PAGE_SIZE;
      else conversationLimitRef.current = Math.max(CONVERSATION_PAGE_SIZE, conversationsRef.current.length);
    }
    const projectLimit = Math.max(
      PROJECT_CONVERSATION_PAGE_SIZE,
      reset ? PROJECT_CONVERSATION_PAGE_SIZE : projectConversationPagesRef.current[projectId ?? ""]?.conversations.length ?? 0,
    );
    const response = await api.conversations({
      projectId: session.projectMode ? projectId ?? undefined : undefined,
      query: queryRef.current,
      limit: session.projectMode ? projectLimit : queryRef.current ? 100 : conversationLimitRef.current,
      offset: 0,
    });
    let result = retainSelectedConversation(response, retainedConversationRef.current, projectId ?? undefined);
    if (queryRef.current && preserveSearchMatches) {
      const visible = session.projectMode && projectId
        ? projectConversationPagesRef.current[projectId]?.conversations ?? []
        : conversationsRef.current;
      const conversations = mergeConversationMatches(result.conversations, visible);
      result = { ...result, conversations, total: conversations.length, hasMore: false, nextOffset: null };
    }
    if (session.projectMode && projectId) {
      setProjectConversationPages((current) => ({ ...current, [projectId]: result }));
      if (activeProjectIdRef.current === projectId) {
        setConversations(result.conversations);
        setConversationTotal(result.total);
        setConversationHasMore(result.hasMore);
      }
    } else {
      conversationsRef.current = result.conversations;
      setConversations(result.conversations);
      setConversationTotal(result.total);
      setConversationHasMore(result.hasMore);
    }
    if (!queryRef.current && projectId) {
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, conversation_count: result.total } : project));
    }
    return result.conversations;
  }, [session.projectMode]);

  const syncConversation = useCallback((conversation: Conversation) => {
    const selected = selectedIdRef.current === conversation.id;
    if (retainedConversationRef.current?.id === conversation.id || selected) retainedConversationRef.current = conversation;
    setConversations((current) => sortConversationsByActivity(current.map((item) => item.id === conversation.id ? conversation : item)));
    setProjectConversationPages((current) => Object.fromEntries(Object.entries(current).map(([projectId, page]) => [projectId, {
      ...page,
      conversations: sortConversationsByActivity(page.conversations.map((item) => item.id === conversation.id ? conversation : item)),
    }])));
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
    const externallyRunning = snapshot.externalStatus === "running";
    setJob(snapshot.activeJob);
    setSending(Boolean(snapshot.activeJob) || externallyRunning);
    const remoteActivity = !snapshot.activeJob && (externallyRunning || snapshot.remoteActivities.length > 0);
    setActivities(remoteActivity
      ? [
          ...(externallyRunning
            ? [{ kind: "status", label: "正在本机客户端中执行", detail: "电脑端完成一个处理步骤后会自动同步到这里；确认空闲后，待发送任务会自动开始。" } as JobEvent]
            : []),
          ...snapshot.remoteActivities,
        ]
      : mergeJobEvents([], snapshot.jobEvents));
    const eventJobId = snapshot.activeJob?.id ?? snapshot.latestJob?.id ?? null;
    lastEventJobRef.current = eventJobId;
    lastEventIdRef.current = snapshot.jobEvents.at(-1)?.seq ?? 0;
    if (hydrated && !snapshot.activeJob) setActivitiesLoading(false);
    if (!snapshot.activeJob && !externallyRunning) setActivitiesLoading(false);
  }, []);

  const refreshActivity = useCallback(async (id: string) => {
    const snapshot = await api.conversationActivity(id);
    applyActivitySnapshot(id, snapshot, true);
    return snapshot;
  }, [applyActivitySnapshot]);

  const refreshDetail = useCallback(async (id: string, activate = false) => {
    if (activate) {
      const activation = await api.activateConversation(id);
      if (activation.state !== "local") {
        if (selectedIdRef.current === id) setDetail(null);
        return { restoring: true as const, state: activation.state === "error" ? "error" as const : "restoring" as const, conversation: activation.conversation };
      }
    }
    const draftGenerationAtRequest = draftMutationGenerationRef.current.get(id) ?? 0;
    let result = await api.conversation(id);
    if (selectedIdRef.current !== id) return result;
    if ("restoring" in result) {
      setDetail(null);
      setActivitiesLoading(true);
      return result;
    }
    const unreadAnchorMessageId = result.conversation.has_unread_result
      ? result.conversation.unread_anchor_message_id
      : null;
    let preparedUnreadHistory = false;
    let unreadScrollTargetMessageId = unreadAnchorMessageId
      ? resolveUnreadScrollTarget(result.messages, unreadAnchorMessageId, result.messagePage.hasMore)
      : null;
    while (unreadAnchorMessageId
      && !unreadScrollTargetMessageId
      && result.messagePage.hasMore
      && result.messagePage.nextCursor) {
      const older = await api.conversationMessages(id, result.messagePage.nextCursor);
      if (selectedIdRef.current !== id) return result;
      result = {
        ...result,
        messages: mergeMessagePages(older.messages, result.messages),
        messagePage: older.messagePage,
      };
      preparedUnreadHistory = true;
      unreadScrollTargetMessageId = resolveUnreadScrollTarget(
        result.messages,
        unreadAnchorMessageId,
        result.messagePage.hasMore,
      );
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
    applyActivitySnapshot(id, {
      conversationStatus: result.conversation.status,
      externalStatus: result.conversation.external_status,
      hasUnreadResult: Boolean(result.conversation.has_unread_result),
      hasPendingWork: Boolean(result.conversation.has_pending_work),
      activeJob: result.activeJob,
      latestJob: result.latestJob,
      jobEvents: result.jobEvents,
      remoteTurnId: result.remoteTurnId,
      remoteActivities: result.remoteActivities,
    }, false);
    const latestQueueStatus = result.jobEvents.findLast((event) => event.status === "queued");
    if (result.activeJob?.status !== "queued" || latestQueueStatus?.label !== MAINTENANCE_QUEUE_GUIDANCE) {
      setNotice((current) => current === MAINTENANCE_QUEUE_GUIDANCE ? "" : current);
    }
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
        const currentDraft = composerDraftRef.current;
        const responseIsStale = (draftMutationGenerationRef.current.get(id) ?? 0) !== draftGenerationAtRequest;
        const serverDraft = responseIsStale ? currentDraft : result.composerDraft;
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
    if (["failed", "interrupted"].includes(result.latestJob?.status ?? "") && !result.latestJob?.error) {
      setError(result.jobEvents.findLast((event) => event.message)?.message || (result.latestJob?.status === "interrupted" ? "本轮已中断，请确认后继续" : "任务处理失败"));
    }
    return result;
  }, [applyActivitySnapshot, syncConversation]);

  useEffect(() => {
    void api.projects().then((result) => {
      setProjects(result.projects);
      const collapsed = Object.fromEntries(result.projects.map((project) => [project.id, Boolean(project.sidebar_collapsed)]));
      collapsedProjectsRef.current = collapsed;
      setCollapsedProjects(collapsed);
      const active = chooseSelectedProject(savedProjectIdRef.current, result.projects, result.defaultProjectId);
      activeProjectIdRef.current = active;
      setActiveProjectId(active);
      writeStoredSelection(window.localStorage, selectionStorageKeys.project, active);
      if (!active) {
        conversationSelectionReadyRef.current = true;
        setConversationSelectionReady(true);
      }
      setProjectsLoaded(true);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "项目加载失败"));
  }, [selectionStorageKeys.project]);
  useEffect(() => {
    if (!projectsLoaded || session.projectMode) return;
    let cancelled = false;
    setConversationBodySearchLoading(false);
    const timer = window.setTimeout(() => {
      setConversationListLoading(true);
      conversationListLoadingRef.current = true;
      void refreshList(true, activeProjectIdRef.current, false).then(async (items) => {
        if (cancelled) return;
        if (!conversationSelectionReadyRef.current) {
          const savedConversationId = savedConversationIdRef.current;
          const projectId = activeProjectIdRef.current;
          const restored = savedConversationId && projectId
            ? await api.validateConversationSelection(savedConversationId, projectId).catch(() => ({ valid: false }))
            : { valid: false };
          if (cancelled) return;
          const next = restored.valid ? savedConversationId : chooseSelectedConversation(null, items);
          conversationSelectionReadyRef.current = true;
          setConversationSelectionReady(true);
          if (next !== selectedIdRef.current) setSelectedId(next);
        }
        if (!query || cancelled) return;
        conversationListLoadingRef.current = false;
        setConversationListLoading(false);
        setConversationBodySearchLoading(true);
        let offset = 0;
        let visible = conversationsRef.current;
        while (!cancelled && offset < BODY_SEARCH_RESULT_LIMIT) {
          const bodyPage = await api.conversationBodyMatches({ query, limit: 1, offset });
          if (cancelled || !bodyPage.conversations.length) break;
          visible = mergeConversationMatches(visible, bodyPage.conversations);
          const retained = retainedConversationRef.current;
          if (retained && !visible.some((conversation) => conversation.id === retained.id)) visible = [...visible, retained];
          conversationsRef.current = visible;
          setConversations(visible);
          setConversationTotal(visible.length + (bodyPage.hasMore ? 1 : 0));
          setConversationHasMore(false);
          if (!bodyPage.hasMore || bodyPage.nextOffset === null) break;
          offset = bodyPage.nextOffset;
        }
      }).catch((reason) => setError(reason instanceof Error ? reason.message : "任务列表加载失败")).finally(() => {
        if (cancelled) return;
        conversationListLoadingRef.current = false;
        setConversationListLoading(false);
        setConversationBodySearchLoading(false);
      });
    }, query ? 220 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeProjectId, projectsLoaded, query, refreshList, session.projectMode]);
  async function loadProjectSearchBatch(projectId: string, searchQuery: string, capacity: number, seed: Conversation[] = []) {
    const previous = projectSearchStateRef.current[projectId];
    const state: ProjectSearchState = previous && previous.query === searchQuery
      ? { ...previous }
      : { query: searchQuery, titleOffset: 0, titleHasMore: true, bodyOffset: 0, bodyHasMore: true };
    let conversations = [...seed];
    while (conversations.length < capacity) {
      const remaining = capacity - conversations.length;
      const before = conversations.length;
      if (state.titleHasMore) {
        const page = await api.conversations({ projectId, query: searchQuery, limit: remaining, offset: state.titleOffset });
        conversations = mergeConversationMatches(conversations, page.conversations);
        state.titleOffset = page.nextOffset ?? state.titleOffset + page.conversations.length;
        state.titleHasMore = page.hasMore;
      } else if (state.bodyHasMore) {
        const page = await api.conversationBodyMatches({ projectId, query: searchQuery, limit: remaining, offset: state.bodyOffset });
        conversations = mergeConversationMatches(conversations, page.conversations);
        state.bodyOffset = page.nextOffset ?? state.bodyOffset + page.conversations.length;
        state.bodyHasMore = page.hasMore;
      } else {
        break;
      }
      if (conversations.length === before && !state.titleHasMore && !state.bodyHasMore) break;
    }
    projectSearchStateRef.current[projectId] = state;
    return { conversations, hasMore: state.titleHasMore || state.bodyHasMore };
  }

  const projectIdsKey = projects.map((project) => project.id).join("|");
  useEffect(() => {
    if (!session.projectMode || !projectsLoaded || projects.length === 0) return;
    let cancelled = false;
    projectSearchStateRef.current = {};
    // Hydrate only the active project for the first paint.  Other projects are
    // fetched when expanded or selected, so a large sidebar does not block the
    // conversation view with N parallel list requests.
    const snapshot = projects.filter((project) => project.id === activeProjectIdRef.current);
    const timer = window.setTimeout(() => {
      setProjectPageLoading((current) => ({ ...current, ...Object.fromEntries(snapshot.map((project) => [project.id, true])) }));
      void Promise.all(snapshot.map(async (project) => {
        const batch = query
          ? await loadProjectSearchBatch(project.id, query, PROJECT_CONVERSATION_PAGE_SIZE)
          : await api.conversations({ projectId: project.id, limit: PROJECT_CONVERSATION_PAGE_SIZE, offset: 0 });
        return [project.id, batch] as const;
      })).then(async (entries) => {
        if (cancelled) return;
        const pages = Object.fromEntries(entries.map(([projectId, page]) => [
          projectId,
          retainSelectedConversation({
            conversations: page.conversations,
            total: page.conversations.length + (page.hasMore ? 1 : 0),
            hasMore: page.hasMore,
            nextOffset: page.hasMore ? page.conversations.length : null,
          }, retainedConversationRef.current, projectId),
        ])) as Record<string, ConversationPage>;
        projectConversationPagesRef.current = pages;
        setProjectConversationPages(pages);
        setProjectPageLoading({});
        const activePage = activeProjectIdRef.current ? pages[activeProjectIdRef.current] : undefined;
        setConversations(activePage?.conversations ?? []);
        setConversationTotal(activePage?.total ?? 0);
        setConversationHasMore(activePage?.hasMore ?? false);
        if (!conversationSelectionReadyRef.current) {
          const savedConversationId = savedConversationIdRef.current;
          const projectId = activeProjectIdRef.current;
          const restored = savedConversationId && projectId
            ? await api.validateConversationSelection(savedConversationId, projectId).catch(() => ({ valid: false }))
            : { valid: false };
          if (cancelled) return;
          const next = restored.valid ? savedConversationId : chooseSelectedConversation(null, activePage?.conversations ?? []);
          conversationSelectionReadyRef.current = true;
          setConversationSelectionReady(true);
          setSelectedId(next);
        }
      }).catch((reason) => setError(reason instanceof Error ? reason.message : "项目任务加载失败")).finally(() => {
        if (cancelled) return;
        setProjectPageLoading({});
      });
    }, query ? 220 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  // Project names and counts can update without changing which pages must load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdsKey, projectsLoaded, query, session.projectMode]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (queryRef.current) return;
      if (session.projectMode) {
        for (const project of projects) void refreshList(false, project.id).catch(() => undefined);
      } else {
        void refreshList().catch(() => undefined);
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [projectIdsKey, refreshList, session.projectMode]);
  useEffect(() => {
    if (!projectsLoaded) return;
    window.localStorage.removeItem("codex-web:model");
    window.localStorage.removeItem("codex-web:reasoning");
    void api.agentOptions(activeProjectId ? { projectId: activeProjectId } : {}).then((options) => {
      setAgentOptions(options);
      if (!selectedIdRef.current) {
        setSelectedModel(options.selection.model);
        setReasoningEffort(options.selection.reasoningEffort);
      }
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "模型选项加载失败"));
  }, [activeProjectId, executorCatalogEpoch, projectsLoaded]);
  useEffect(() => {
    if (!conversationSelectionReady) return;
    autoFollowRef.current = true;
    lastScrollTopRef.current = 0;
    loadingOlderMessagesRef.current = false;
    prependScrollRestoreRef.current = null;
    unreadScrollTargetRef.current = null;
    setLoadingOlderMessages(false);
    if (!selectedId) {
      writeStoredSelection(window.localStorage, selectionStorageKeys.conversation, null);
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
    writeStoredSelection(window.localStorage, selectionStorageKeys.conversation, selectedId);
    eventSourceRef.current?.close(); connectedJobRef.current = null; lastEventJobRef.current = null; lastEventIdRef.current = 0; setActivities([]); setActivitiesLoading(true);
    editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]); setFiles([]); setDraftUploads([]);
    const cached = draftCacheRef.current.get(selectedId);
    draftLoadedConversationRef.current = cached ? selectedId : null;
    composerDraftRef.current = cached?.composerDraft ?? null;
    setComposerDraft(cached?.composerDraft ?? null);
    setInput(cached?.content ?? "");
    setAskAgentQuote(cached?.quoteExcerpt ?? "");
    setDraftSaveState(cached ? "unsaved" : "idle");
    void reconcile(selectedId, true);
    setSidebarOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationSelectionReady, selectedId, selectionStorageKeys.conversation]);
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
  useEffect(() => {
    if (!instanceReloadDeferred) return;
    const currentDraftSignature = composerDraftSignature(input, askAgentQuote);
    if (!canApplyDeferredInstanceReload({
      voiceActive: voiceInputActive,
      submitting,
      conversationId: selectedId,
      editingPending: Boolean(editingPending),
      input,
      quoteExcerpt: askAgentQuote,
      looseFileCount: files.length,
      uploadCount: draftUploads.length,
      draftLoaded: Boolean(selectedId && draftLoadedConversationRef.current === selectedId),
      currentDraftSignature,
      syncedDraftSignature: selectedId ? draftSyncedSignaturesRef.current.get(selectedId) : undefined,
    })) return;
    instanceReloadDeferredRef.current = false;
    setInstanceReloadDeferred(false);
    window.location.reload();
  }, [askAgentQuote, draftSaveState, draftUploads.length, editingPending, files.length, input, instanceReloadDeferred, selectedId, submitting, voiceInputActive]);
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
  }, [detail?.messages.length, detail?.wakePlan?.id, activities, sending]);
  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      const menu = conversationMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      const rolloutWarning = rolloutWarningRef.current;
      if (rolloutWarning?.open && event.target instanceof Node && !rolloutWarning.contains(event.target)) rolloutWarning.open = false;
      if (projectMenu && event.target instanceof Element && !event.target.closest("[data-project-menu]")) setProjectMenu(null);
      if (projectSectionMenu && event.target instanceof Element && !event.target.closest("[data-project-menu]")) setProjectSectionMenu(null);
      if (taskMenu && event.target instanceof Element && !event.target.closest("[data-task-menu]")) setTaskMenu(null);
      if (accountSettingsOpen && event.target instanceof Node && !accountAreaRef.current?.contains(event.target)) setAccountSettingsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && conversationMenuRef.current?.open) conversationMenuRef.current.open = false;
      if (event.key === "Escape" && rolloutWarningRef.current?.open) rolloutWarningRef.current.open = false;
      if (event.key === "Escape") setProjectMenu(null);
      if (event.key === "Escape") setProjectSectionMenu(null);
      if (event.key === "Escape") setTaskMenu(null);
      if (event.key === "Escape") setAccountSettingsOpen(false);
    };
    const closeSidebarMenus = () => { setProjectMenu(null); setProjectSectionMenu(null); setTaskMenu(null); };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeSidebarMenus);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeSidebarMenus);
    };
  }, [accountSettingsOpen, projectMenu, projectSectionMenu, taskMenu]);

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

  async function loadMoreConversations() {
    if (session.projectMode) return;
    if (!conversationHasMore || conversationListLoadingRef.current) return;
    conversationListLoadingRef.current = true;
    setConversationListLoading(true);
    try {
      const current = conversationsRef.current;
      const requestedProjectId = activeProjectIdRef.current;
      const requestedQuery = queryRef.current;
      const result = await api.conversations({
        projectId: session.projectMode ? requestedProjectId ?? undefined : undefined,
        query: requestedQuery,
        limit: CONVERSATION_PAGE_SIZE,
        offset: current.length,
      });
      if (activeProjectIdRef.current !== requestedProjectId || queryRef.current !== requestedQuery) return;
      const known = new Set(current.map((item) => item.id));
      const combined = [...current, ...result.conversations.filter((item) => !known.has(item.id))];
      conversationLimitRef.current = combined.length;
      setConversations(combined);
      setConversationTotal(result.total);
      setConversationHasMore(result.hasMore);
      if (!requestedQuery && requestedProjectId) {
        setProjects((projects) => projects.map((project) => project.id === requestedProjectId ? { ...project, conversation_count: result.total } : project));
      }
    }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "更多任务加载失败");
    } finally {
      conversationListLoadingRef.current = false;
      setConversationListLoading(false);
    }
  }

  function handleConversationListScroll(event: React.UIEvent<HTMLDivElement>) {
    setTaskMenu(null);
    if (session.projectMode) return;
    const list = event.currentTarget;
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= 80) void loadMoreConversations();
  }

  async function loadMoreProjectConversations(projectId: string) {
    const current = projectConversationPagesRef.current[projectId];
    if (!current?.hasMore || projectPageLoading[projectId]) return;
    const requestGeneration = projectPageGenerationRef.current[projectId] ?? 0;
    setProjectPageLoading((loading) => ({ ...loading, [projectId]: true }));
    try {
      if (queryRef.current) {
        const batch = await loadProjectSearchBatch(projectId, queryRef.current, PROJECT_CONVERSATION_PAGE_SIZE, current.conversations);
        const searchPage = retainSelectedConversation({
          conversations: batch.conversations,
          total: batch.conversations.length + (batch.hasMore ? 1 : 0),
          hasMore: batch.hasMore,
          nextOffset: batch.hasMore ? batch.conversations.length : null,
        }, retainedConversationRef.current, projectId);
        projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: searchPage };
        setProjectConversationPages((pages) => ({ ...pages, [projectId]: searchPage }));
        if (activeProjectIdRef.current === projectId) {
          setConversations(searchPage.conversations);
          setConversationTotal(searchPage.total);
          setConversationHasMore(searchPage.hasMore);
        }
        return;
      }
      const result = await api.conversations({
        projectId,
        query: queryRef.current,
        limit: PROJECT_CONVERSATION_PAGE_SIZE,
        offset: current.nextOffset ?? current.conversations.length,
      });
      const known = new Set(current.conversations.map((conversation) => conversation.id));
      const conversations = [...current.conversations, ...result.conversations.filter((conversation) => !known.has(conversation.id))];
      const expandedPage = retainSelectedConversation({ ...result, conversations }, retainedConversationRef.current, projectId);
      const page = (projectPageGenerationRef.current[projectId] ?? 0) === requestGeneration
        ? expandedPage
        : resetProjectConversationPage(expandedPage, PROJECT_CONVERSATION_PAGE_SIZE);
      projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: page };
      setProjectConversationPages((pages) => ({ ...pages, [projectId]: page }));
      if (activeProjectIdRef.current === projectId) {
        setConversations(page.conversations);
        setConversationTotal(result.total);
        setConversationHasMore(page.hasMore);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更多项目任务加载失败");
    } finally {
      setProjectPageLoading((loading) => ({ ...loading, [projectId]: false }));
    }
  }

  async function loadProjectPage(projectId: string) {
    if (projectConversationPagesRef.current[projectId] || projectPageRequestsRef.current.has(projectId)) return;
    projectPageRequestsRef.current.add(projectId);
    setProjectPageLoading((loading) => ({ ...loading, [projectId]: true }));
    try {
      const batch = queryRef.current
        ? await loadProjectSearchBatch(projectId, queryRef.current, PROJECT_CONVERSATION_PAGE_SIZE)
        : await api.conversations({ projectId, limit: PROJECT_CONVERSATION_PAGE_SIZE, offset: 0 });
      const page = retainSelectedConversation({
        conversations: batch.conversations,
        total: batch.conversations.length + (batch.hasMore ? 1 : 0),
        hasMore: batch.hasMore,
        nextOffset: batch.hasMore ? batch.conversations.length : null,
      }, retainedConversationRef.current, projectId);
      projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: page };
      setProjectConversationPages((pages) => ({ ...pages, [projectId]: page }));
      if (activeProjectIdRef.current === projectId) {
        setConversations(page.conversations);
        setConversationTotal(page.total);
        setConversationHasMore(page.hasMore);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目任务加载失败");
    } finally {
      projectPageRequestsRef.current.delete(projectId);
      setProjectPageLoading((loading) => ({ ...loading, [projectId]: false }));
    }
  }

  function resetProjectExpansion(projectId: string) {
    const current = projectConversationPagesRef.current[projectId];
    if (!current) return;
    const page = resetProjectConversationPage(current, PROJECT_CONVERSATION_PAGE_SIZE);
    projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: page };
    setProjectConversationPages((pages) => ({ ...pages, [projectId]: page }));
    if (activeProjectIdRef.current === projectId) {
      setConversations(page.conversations);
      setConversationTotal(page.total);
      setConversationHasMore(page.hasMore);
    }
  }

  function toggleProject(projectId: string) {
    const collapsing = !Boolean(collapsedProjectsRef.current[projectId]);
    const collapsed = { ...collapsedProjectsRef.current, [projectId]: collapsing };
    collapsedProjectsRef.current = collapsed;
    setCollapsedProjects(collapsed);
    if (collapsing) {
      projectPageGenerationRef.current[projectId] = (projectPageGenerationRef.current[projectId] ?? 0) + 1;
      resetProjectExpansion(projectId);
    } else {
      void loadProjectPage(projectId);
    }
    const previousSave = projectCollapseSaveQueueRef.current.get(projectId) ?? Promise.resolve();
    const save = previousSave.catch(() => undefined).then(async () => {
      await api.updateProjectSidebarCollapsed(projectId, collapsing);
    });
    projectCollapseSaveQueueRef.current.set(projectId, save);
    void save.catch(async (reason) => {
      if (projectCollapseSaveQueueRef.current.get(projectId) !== save) return;
      try {
        const result = await api.projects();
        setProjects(result.projects);
        const serverCollapsed = Object.fromEntries(result.projects.map((project) => [project.id, Boolean(project.sidebar_collapsed)]));
        collapsedProjectsRef.current = serverCollapsed;
        setCollapsedProjects(serverCollapsed);
      } catch { /* Keep the original save error as the useful message. */ }
      setError(reason instanceof Error ? reason.message : "项目展开状态保存失败");
    }).finally(() => {
      if (projectCollapseSaveQueueRef.current.get(projectId) === save) projectCollapseSaveQueueRef.current.delete(projectId);
    });
  }

  function selectProject(projectId: string) {
    if (projectId === activeProjectIdRef.current) return;
    writeStoredSelection(window.localStorage, selectionStorageKeys.project, projectId);
    activeProjectIdRef.current = projectId;
    queryRef.current = "";
    setQuery("");
    setActiveProjectId(projectId);
    retainedConversationRef.current = null;
    selectedIdRef.current = null;
    setSelectedId(null);
    const page = projectConversationPagesRef.current[projectId];
    setConversations(page?.conversations ?? []);
    setConversationTotal(page?.total ?? 0);
    setConversationHasMore(page?.hasMore ?? false);
    if (!page) void loadProjectPage(projectId);
  }

  function selectProjectConversation(projectId: string, conversationId: string) {
    const conversation = projectConversationPagesRef.current[projectId]?.conversations.find((item) => item.id === conversationId);
    if (conversation) retainedConversationRef.current = conversation;
    if (projectId !== activeProjectIdRef.current) {
      writeStoredSelection(window.localStorage, selectionStorageKeys.project, projectId);
      activeProjectIdRef.current = projectId;
      setActiveProjectId(projectId);
    }
    const page = projectConversationPagesRef.current[projectId];
    if (page && conversation) {
      const retained = retainSelectedConversation(page, conversation, projectId);
      projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: retained };
      setProjectConversationPages((pages) => ({ ...pages, [projectId]: retained }));
      conversationsRef.current = retained.conversations;
      setConversations(retained.conversations);
      setConversationTotal(retained.total);
      setConversationHasMore(retained.hasMore);
    }
    selectedIdRef.current = conversationId;
    setSelectedId(conversationId);
  }

  function selectConversation(conversation: Conversation) {
    retainedConversationRef.current = conversation;
    selectedIdRef.current = conversation.id;
    setSelectedId(conversation.id);
  }

  async function renameProject(project: Project) {
    const name = window.prompt("新的项目名称", project.name)?.trim();
    if (!name || name === project.name) return;
    try {
      const result = await api.renameProject(project.id, name);
      setProjects((current) => current.map((item) => item.id === project.id ? { ...item, ...result.project } : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "项目重命名失败"); }
  }

  function toggleProjectMenu(project: Project, button: HTMLButtonElement) {
    if (projectMenu?.projectId === project.id) { setProjectMenu(null); return; }
    setProjectSectionMenu(null);
    setTaskMenu(null);
    const bounds = button.getBoundingClientRect();
    const width = 176;
    const height = project.executor_id.startsWith("remote:") ? 132 : 92;
    const top = bounds.bottom + 6 + height <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6);
    const left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    setProjectMenu({ projectId: project.id, top, left });
  }

  function toggleProjectSectionMenu(button: HTMLButtonElement) {
    if (projectSectionMenu) { setProjectSectionMenu(null); return; }
    setProjectMenu(null);
    setTaskMenu(null);
    const bounds = button.getBoundingClientRect();
    const width = 176;
    const height = 56;
    const top = bounds.bottom + 6 + height <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6);
    const left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    setProjectSectionMenu({ top, left });
  }

  function toggleTaskMenu(conversation: Conversation, button: HTMLButtonElement) {
    if (taskMenu?.conversationId === conversation.id) { setTaskMenu(null); return; }
    setProjectMenu(null);
    const bounds = button.getBoundingClientRect();
    const width = 210;
    const height = conversation.active_wake_count ? 220 : 212;
    const top = bounds.bottom + 6 + height <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6);
    const left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    setTaskMenu({ conversationId: conversation.id, top, left });
  }

  async function archiveProject(project: Project) {
    setProjectMenu(null);
    if (!window.confirm(`归档项目“${project.name}”？\n\n项目和历史任务不会被删除。以后重新添加同一文件夹时会全部恢复。`)) return;
    setError("");
    try {
      await api.archiveProject(project.id);
      const projectIndex = projects.findIndex((candidate) => candidate.id === project.id);
      const remaining = projects.filter((candidate) => candidate.id !== project.id);
      setProjects(remaining);
      const pages = { ...projectConversationPagesRef.current };
      delete pages[project.id];
      projectConversationPagesRef.current = pages;
      setProjectConversationPages(pages);
      setProjectPageLoading((current) => { const next = { ...current }; delete next[project.id]; return next; });
      setSyncingProjects((current) => { const next = { ...current }; delete next[project.id]; return next; });
      const collapsed = { ...collapsedProjectsRef.current };
      delete collapsed[project.id];
      collapsedProjectsRef.current = collapsed;
      setCollapsedProjects(collapsed);
      if (activeProjectIdRef.current === project.id) {
        const nextProject = remaining[Math.min(Math.max(projectIndex, 0), remaining.length - 1)] ?? null;
        const nextProjectId = nextProject?.id ?? null;
        activeProjectIdRef.current = nextProjectId;
        setActiveProjectId(nextProjectId);
        writeStoredSelection(window.localStorage, selectionStorageKeys.project, nextProjectId);
        const nextPage = nextProjectId ? pages[nextProjectId] : undefined;
        setConversations(nextPage?.conversations ?? []);
        setConversationTotal(nextPage?.total ?? 0);
        setConversationHasMore(nextPage?.hasMore ?? false);
        setSelectedId(null);
      }
      setNotice(`项目“${project.name}”已归档；重新添加同一文件夹即可恢复历史任务。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目归档失败");
    }
  }

  function projectCreated(project: Project) {
    setProjects((current) => [...current, project]);
    setProjectConversationPages((current) => ({ ...current, [project.id]: { conversations: [], total: 0, hasMore: false, nextOffset: null } }));
    setCollapsedProjects((current) => ({ ...current, [project.id]: false }));
    setProjectDialogOpen(false);
    selectProject(project.id);
  }

  function beginProjectDrag(event: DragEvent<HTMLDivElement>, projectId: string) {
    if ((event.target as HTMLElement).closest(".project-actions")) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `project:${projectId}`);
    setDraggedConversation(null);
    setConversationDropTarget(null);
    setConversationProjectDropTarget(null);
    setDraggedProjectId(projectId);
  }

  function projectDragOver(event: DragEvent<HTMLDivElement>, projectId: string) {
    if (draggedConversation) {
      if (draggedConversation.projectId === projectId) return;
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      const reason = conversationProjectMoveBlockReason(draggedConversation, project, projects);
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = reason ? "none" : "move";
      setConversationDropTarget(null);
      setConversationProjectDropTarget({ projectId, allowed: !reason, reason });
      return;
    }
    if (!draggedProjectId || draggedProjectId === projectId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setProjectDropTarget({ id: projectId, placement: projectDropPlacement(event) });
  }

  async function persistProjectDrop(sourceId: string, targetId: string, placement: DropPlacement) {
    if (sourceId === targetId) return;
    const previous = projects;
    const reordered = moveRelative(previous, sourceId, targetId, placement);
    setProjects(reordered);
    setDraggedProjectId(null);
    setProjectDropTarget(null);
    try { await api.reorderProjects(reordered.map((project) => project.id)); }
    catch (reason) {
      setProjects(previous);
      setError(reason instanceof Error ? reason.message : "调整项目顺序失败");
    }
  }

  async function dropProject(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.stopPropagation();
    if (draggedConversation && draggedConversation.projectId !== targetId) {
      event.preventDefault();
      const targetProject = projects.find((project) => project.id === targetId);
      if (targetProject) await persistConversationProjectDrop(draggedConversation, targetProject);
      return;
    }
    if (!draggedProjectId || draggedProjectId === targetId) return;
    event.preventDefault();
    await persistProjectDrop(draggedProjectId, targetId, projectDropTarget?.id === targetId ? projectDropTarget.placement : projectDropPlacement(event));
  }

  function projectListDragOver(event: DragEvent<HTMLDivElement>) {
    if (!draggedProjectId || !projectDropTarget) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  async function dropProjectInList(event: DragEvent<HTMLDivElement>) {
    if (!draggedProjectId || !projectDropTarget) return;
    event.preventDefault();
    await persistProjectDrop(draggedProjectId, projectDropTarget.id, projectDropTarget.placement);
  }

  function beginConversationDrag(event: DragEvent<HTMLDivElement>, conversation: Conversation, projectId: string) {
    if (queryRef.current || (event.target as HTMLElement).closest(".row-actions")) { event.preventDefault(); return; }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `conversation:${conversation.id}`);
    setDraggedProjectId(null);
    setProjectDropTarget(null);
    setDraggedConversation({
      id: conversation.id,
      projectId,
      pinned: Boolean(conversation.pinned_at),
      title: conversation.title,
      projectMoveBlocked: Boolean(conversation.project_move_blocked),
    });
  }

  function conversationDragOver(event: DragEvent<HTMLDivElement>, conversation: Conversation, projectId: string) {
    if (!draggedConversation || draggedConversation.id === conversation.id || draggedConversation.projectId !== projectId || draggedConversation.pinned !== Boolean(conversation.pinned_at)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setConversationProjectDropTarget(null);
    setConversationDropTarget({ id: conversation.id, placement: dropPlacement(event) });
  }

  async function persistConversationDrop(source: ConversationDrag, target: Conversation, projectId: string, placement: DropPlacement) {
    if (!source || source.id === target.id || source.projectId !== projectId || source.pinned !== Boolean(target.pinned_at)) return;
    const previous = projectConversationPagesRef.current[projectId];
    if (!previous) return;
    const page = { ...previous, conversations: moveRelative(previous.conversations, source.id, target.id, placement) };
    projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: page };
    setProjectConversationPages((pages) => ({ ...pages, [projectId]: page }));
    if (activeProjectIdRef.current === projectId) setConversations(page.conversations);
    setDraggedConversation(null);
    setConversationDropTarget(null);
    setConversationProjectDropTarget(null);
    try { await api.moveConversation(source.id, target.id, placement); }
    catch (reason) {
      projectConversationPagesRef.current = { ...projectConversationPagesRef.current, [projectId]: previous };
      setProjectConversationPages((pages) => ({ ...pages, [projectId]: previous }));
      if (activeProjectIdRef.current === projectId) setConversations(previous.conversations);
      setError(reason instanceof Error ? reason.message : "调整任务顺序失败");
    }
  }

  async function dropConversation(event: DragEvent<HTMLDivElement>, target: Conversation, projectId: string) {
    const source = draggedConversation;
    if (!source || source.id === target.id || source.projectId !== projectId || source.pinned !== Boolean(target.pinned_at)) return;
    event.preventDefault();
    event.stopPropagation();
    await persistConversationDrop(source, target, projectId, conversationDropTarget?.id === target.id ? conversationDropTarget.placement : dropPlacement(event));
  }

  async function persistConversationProjectDrop(source: ConversationDrag, targetProject: Project) {
    const reason = conversationProjectMoveBlockReason(source, targetProject, projects);
    setDraggedConversation(null);
    setConversationDropTarget(null);
    setConversationProjectDropTarget(null);
    if (reason) {
      setNotice(reason);
      return;
    }
    setError("");
    setNotice("");
    try {
      const result = await api.moveConversationToProject(source.id, targetProject.id);
      if (!result.moved) return;
      if (collapsedProjectsRef.current[targetProject.id]) toggleProject(targetProject.id);
      syncConversation(result.conversation);
      if (selectedIdRef.current === source.id) {
        writeStoredSelection(window.localStorage, selectionStorageKeys.project, targetProject.id);
        activeProjectIdRef.current = targetProject.id;
        setActiveProjectId(targetProject.id);
        setSelectedId(source.id);
      }
      await Promise.all([
        refreshList(true, result.fromProjectId),
        refreshList(true, result.toProjectId),
        selectedIdRef.current === source.id ? refreshDetail(source.id) : Promise.resolve(null),
      ]);
      setNotice(`任务“${source.title}”已移到项目“${targetProject.display_name || targetProject.name}”；历史和附件已保留，项目文件未复制。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移动任务失败");
    }
  }

  function beginTouchDrag(event: ReactPointerEvent<HTMLElement>, drag: TouchDrag) {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    touchDragRef.current = drag;
    if (drag.kind === "project") {
      setDraggedConversation(null);
      setConversationDropTarget(null);
      setConversationProjectDropTarget(null);
      setDraggedProjectId(drag.sourceId);
    } else {
      setDraggedProjectId(null);
      setProjectDropTarget(null);
      setDraggedConversation({
        id: drag.sourceId,
        projectId: drag.projectId,
        pinned: drag.pinned,
        title: drag.title,
        projectMoveBlocked: drag.projectMoveBlocked,
      });
    }
  }

  function moveTouchDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = touchDragRef.current;
    if (!drag) return;
    event.preventDefault();
    const clearTarget = () => {
      delete drag.targetId;
      delete drag.placement;
      if (drag.kind === "project") {
        setProjectDropTarget(null);
      } else {
        delete drag.targetKind;
        delete drag.targetProjectId;
        setConversationDropTarget(null);
        setConversationProjectDropTarget(null);
      }
    };
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (drag.kind === "project") {
      const target = hit?.closest<HTMLElement>(".project-group[data-project-id]");
      const targetId = target?.dataset.projectId;
      if (!target || !targetId || targetId === drag.sourceId) { clearTarget(); return; }
      drag.targetId = targetId;
      const dropElement = target.querySelector<HTMLElement>(".project-row") ?? target;
      drag.placement = elementDropPlacement(dropElement, event.clientY);
      setProjectDropTarget({ id: targetId, placement: drag.placement });
      return;
    }

    const conversationTarget = hit?.closest<HTMLElement>("[data-conversation-id]");
    const targetConversationId = conversationTarget?.dataset.conversationId;
    const targetConversationProjectId = conversationTarget?.dataset.projectId;
    const targetPinned = conversationTarget?.dataset.pinned === "true";
    if (conversationTarget && targetConversationId && targetConversationId !== drag.sourceId
      && targetConversationProjectId === drag.projectId && targetPinned === drag.pinned) {
      drag.targetKind = "conversation";
      drag.targetId = targetConversationId;
      delete drag.targetProjectId;
      drag.placement = elementDropPlacement(conversationTarget, event.clientY);
      setConversationProjectDropTarget(null);
      setConversationDropTarget({ id: targetConversationId, placement: drag.placement });
      return;
    }

    const projectTarget = hit?.closest<HTMLElement>(".project-group[data-project-id]");
    const targetProjectId = projectTarget?.dataset.projectId;
    if (!targetProjectId || targetProjectId === drag.projectId) { clearTarget(); return; }
    const targetProject = projects.find((project) => project.id === targetProjectId);
    if (!targetProject) { clearTarget(); return; }
    const source: ConversationDrag = {
      id: drag.sourceId,
      projectId: drag.projectId,
      pinned: drag.pinned,
      title: drag.title,
      projectMoveBlocked: drag.projectMoveBlocked,
    };
    const reason = conversationProjectMoveBlockReason(source, targetProject, projects);
    drag.targetKind = "project";
    drag.targetProjectId = targetProjectId;
    delete drag.targetId;
    delete drag.placement;
    setConversationDropTarget(null);
    setConversationProjectDropTarget({ projectId: targetProjectId, allowed: !reason, reason });
  }

  function endTouchDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = touchDragRef.current;
    touchDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag) return;
    if (drag.kind === "project") {
      if (drag.targetId && drag.placement) void persistProjectDrop(drag.sourceId, drag.targetId, drag.placement);
      else {
        setDraggedProjectId(null);
        setProjectDropTarget(null);
      }
      return;
    }
    const source: ConversationDrag = {
      id: drag.sourceId,
      projectId: drag.projectId,
      pinned: drag.pinned,
      title: drag.title,
      projectMoveBlocked: drag.projectMoveBlocked,
    };
    if (drag.targetKind === "conversation" && drag.targetId && drag.placement) {
      const target = projectConversationPagesRef.current[drag.projectId]?.conversations.find((conversation) => conversation.id === drag.targetId);
      if (target) {
        void persistConversationDrop(source, target, drag.projectId, drag.placement);
        return;
      }
    }
    if (drag.targetKind === "project" && drag.targetProjectId) {
      const targetProject = projects.find((project) => project.id === drag.targetProjectId);
      if (targetProject) {
        void persistConversationProjectDrop(source, targetProject);
        return;
      }
    }
    setDraggedConversation(null);
    setConversationDropTarget(null);
    setConversationProjectDropTarget(null);
  }

  function cancelTouchDrag(event: ReactPointerEvent<HTMLElement>) {
    touchDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggedProjectId(null); setProjectDropTarget(null); setDraggedConversation(null); setConversationDropTarget(null); setConversationProjectDropTarget(null);
  }

  function askAgentAbout(selectedText: string) {
    const normalized = normalizeAskAgentSelection(selectedText);
    if (!normalized) return;
    setAskAgentQuote(normalized.slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1));
    setComposerFocusRequest((request) => request + 1);
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
      if (data.type === "conversation_title") void refreshList();
      if (data.type && ["status", "progress"].includes(data.type)) setActivities((previous) => mergeJobEvents(previous, [stored]));
      if (data.status === "running") setNotice((current) => current === MAINTENANCE_QUEUE_GUIDANCE ? "" : current);
      if (data.type && ["done", "failed"].includes(data.type)) {
        setActivitiesLoading(false);
        source.close(); connectedJobRef.current = null;
        // Terminal job errors are rendered inline in the conversation, like the
        // native client. Keep the global toast for malformed terminal events only.
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

  async function recoverMissingConversation(id: string) {
    if (selectedIdRef.current !== id) return;
    const missingProjectId = retainedConversationRef.current?.id === id
      ? retainedConversationRef.current.project_id
      : detail?.conversation.id === id
        ? detail.conversation.project_id
        : activeProjectIdRef.current;
    if (retainedConversationRef.current?.id === id) retainedConversationRef.current = null;
    draftCacheRef.current.delete(id);
    draftSyncedSignaturesRef.current.delete(id);
    draftMutationGenerationRef.current.delete(id);

    const remaining = conversationsRef.current.filter((conversation) => conversation.id !== id);
    conversationsRef.current = remaining;
    setConversations(remaining);
    const nextPages = Object.fromEntries(Object.entries(projectConversationPagesRef.current).map(([projectId, page]) => [
      projectId,
      removeConversationFromPage(page, id),
    ]));
    projectConversationPagesRef.current = nextPages;
    setProjectConversationPages(nextPages);
    if (missingProjectId) {
      setProjects((current) => current.map((project) => project.id === missingProjectId
        ? { ...project, conversation_count: Math.max(0, project.conversation_count - 1) }
        : project));
    }

    writeStoredSelection(window.localStorage, selectionStorageKeys.conversation, null);
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setError("");

    const items = await refreshList(false, missingProjectId ?? activeProjectIdRef.current, false).catch(() => remaining);
    if (selectedIdRef.current !== null) return;
    const next = chooseSelectedConversation(null, items.filter((conversation) => conversation.id !== id));
    selectedIdRef.current = next;
    setSelectedId(next);
  }

  async function reconcile(id: string, activate = false) {
    try {
      // Selecting a task already has its project page in memory.  Refresh the
      // sidebar only for background reconciliation (where ordering/status may
      // have changed), avoiding a duplicate list request during navigation.
      const value = await refreshDetail(id, activate);
      if (!activate) await refreshList();
      if (selectedIdRef.current !== id) return;
      if ("restoring" in value) {
        window.setTimeout(() => { if (selectedIdRef.current === id) void reconcile(id); }, 1_000);
        return;
      }
      syncConversation(value.conversation);
      // The detail response already carries the same activity snapshot.  Do
      // not immediately fetch /activity again; the SSE stream is responsible
      // for subsequent changes.
      if (value.activeJob) connectJob(value.activeJob);
      else {
        eventSourceRef.current?.close(); eventSourceRef.current = null; connectedJobRef.current = null;
        const externallyRunning = value.conversation.external_status === "running";
        setSending(externallyRunning); setJob(null);
      }
    } catch (reason) {
      if (selectedIdRef.current !== id) return;
      if (isApiErrorStatus(reason, 404)) {
        await recoverMissingConversation(id);
        return;
      }
      const items = await refreshList().catch(() => [] as Conversation[]);
      if (!items.some((conversation) => conversation.id === id)) {
        writeStoredSelection(window.localStorage, selectionStorageKeys.conversation, null);
        setSelectedId(chooseSelectedConversation(null, items));
      } else {
        setError(reason instanceof Error ? reason.message : "状态刷新失败");
      }
    }
  }

  useEffect(() => {
    if (!selectedId || job || !sending) return;
    let stopped = false;
    const poll = async () => {
      try {
        const activity = await refreshActivity(selectedId);
        if (stopped || selectedIdRef.current !== selectedId) return;
        if (activity.activeJob || activity.externalStatus !== "running") void reconcile(selectedId);
      } catch { /* The next push event or bounded poll can recover. */ }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, refreshActivity, selectedId, sending]);

  useEffect(() => {
    const timers = new Map<string, number>();
    const conversations = new Map<string, Set<string>>();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; conversationId?: string }>).detail;
      if (!detail?.projectId || !detail.conversationId) return;
      const projectConversations = conversations.get(detail.projectId) ?? new Set<string>();
      projectConversations.add(detail.conversationId);
      conversations.set(detail.projectId, projectConversations);
      const currentTimer = timers.get(detail.projectId);
      if (currentTimer !== undefined) window.clearTimeout(currentTimer);
      const timer = window.setTimeout(() => {
        timers.delete(detail.projectId!);
        const changedConversations = conversations.get(detail.projectId!) ?? new Set<string>();
        conversations.delete(detail.projectId!);
        void refreshList(true, detail.projectId);
        const selected = selectedIdRef.current;
        if (selected && changedConversations.has(selected)) void reconcile(selected);
      }, 250);
      timers.set(detail.projectId, timer);
    };
    window.addEventListener("codex-web-conversation-changed", changed);
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      window.removeEventListener("codex-web-conversation-changed", changed);
    };
  }, [refreshList]);

  useEffect(() => {
    let timer: number | undefined;
    const changed = () => {
      const selected = selectedIdRef.current;
      if (!selected) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (selectedIdRef.current === selected) void refreshDetail(selected).catch(() => undefined);
      }, 250);
    };
    window.addEventListener("codex-web-executor-quota-changed", changed);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("codex-web-executor-quota-changed", changed);
    };
  }, [refreshDetail]);

  useEffect(() => {
    const moved = (event: Event) => {
      const move = (event as CustomEvent<{ conversationId?: string; fromProjectId?: string; toProjectId?: string }>).detail;
      if (!move?.conversationId || !move.fromProjectId || !move.toProjectId) return;
      void Promise.all([
        refreshList(true, move.fromProjectId),
        refreshList(true, move.toProjectId),
      ]);
      if (selectedIdRef.current !== move.conversationId) return;
      writeStoredSelection(window.localStorage, selectionStorageKeys.project, move.toProjectId);
      activeProjectIdRef.current = move.toProjectId;
      setActiveProjectId(move.toProjectId);
      void refreshDetail(move.conversationId);
    };
    window.addEventListener("codex-web-conversation-moved", moved);
    return () => window.removeEventListener("codex-web-conversation-moved", moved);
  }, [refreshDetail, refreshList]);

  async function newConversation(projectId = activeProjectIdRef.current ?? undefined) {
    const creationKey = projectId ?? "__default__";
    if (creatingConversationProjectsRef.current.has(creationKey)) return;
    creatingConversationProjectsRef.current.add(creationKey);
    setError("");
    try {
      if (projectId) {
        if (projectId === activeProjectIdRef.current) {
          queryRef.current = "";
          setQuery("");
        } else selectProject(projectId);
        setCollapsedProjects((current) => ({ ...current, [projectId]: false }));
      }
      const result = await api.createConversation(projectId);
      setSelectedModel(result.agentSelection.model); setReasoningEffort(result.agentSelection.reasoningEffort);
      await refreshList(false, projectId ?? null);
      retainedConversationRef.current = result.conversation;
      selectedIdRef.current = result.conversation.id;
      setSelectedId(result.conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新任务创建失败");
    } finally {
      creatingConversationProjectsRef.current.delete(creationKey);
    }
  }

  async function requestContextHandoff() {
    const conversation = currentDetail?.conversation;
    if (!conversation || submitting) return;
    if (sending || currentDetail.pendingPrompts.length > 0 || conversation.active_wake_count > 0) {
      setNotice("请先等待当前任务、待发送任务或自动续跑计划结束，再生成交接摘要。");
      return;
    }
    if (!window.confirm("生成一份受限长度的交接摘要？\n\n摘要会作为当前会话的一条真实任务执行；完成后仍需你确认，系统才会创建并启动新会话。")) return;
    if (conversationMenuRef.current) conversationMenuRef.current.open = false;
    setError(""); setNotice(""); setSubmitting(true);
    setActivities([{ kind: "status", label: "正在生成交接摘要" }]);
    try {
      await api.sendMessage(conversation.id, CONTEXT_HANDOFF_PROMPT, []);
      await reconcile(conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "交接摘要任务提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function createConversationFromHandoff() {
    const source = currentDetail?.conversation;
    const handoff = currentDetail ? latestContextHandoff(currentDetail.messages) : null;
    if (!source || !handoff || submitting) return;
    if (!window.confirm(`用最新交接摘要在“${selectedProject?.display_name || selectedProject?.name || "当前项目"}”中新建并立即启动会话？\n\n原会话会保留，不会自动归档。`)) return;
    if (conversationMenuRef.current) conversationMenuRef.current.open = false;
    setError(""); setNotice(""); setSubmitting(true);
    let createdId = "";
    try {
      const created = await api.createConversation(source.project_id ?? undefined, false);
      createdId = created.conversation.id;
      await api.sendMessage(createdId, buildHandoffFirstTurn(handoff.summary), []);
      setSelectedModel(created.agentSelection.model); setReasoningEffort(created.agentSelection.reasoningEffort);
      await refreshList(false, source.project_id);
      selectedIdRef.current = createdId;
      setSelectedId(createdId);
      setNotice(handoff.truncated ? "新会话已启动；交接摘要已按 12000 字符上限截断。" : "新会话已带着交接摘要启动，原会话仍然保留。" );
    } catch (reason) {
      if (createdId) {
        await refreshList(false, source.project_id).catch(() => undefined);
        selectedIdRef.current = createdId;
        setSelectedId(createdId);
      }
      setError(reason instanceof Error ? reason.message : "交接会话启动失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function syncProject(project: Project) {
    if (!project.executor_id.startsWith("remote:") || project.executor_status !== "online" || syncingProjects[project.id]) return;
    setError(""); setNotice(`正在从 ${project.machine_name} 刷新本机任务…`);
    setSyncingProjects((current) => ({ ...current, [project.id]: true }));
    try {
      const result = await api.syncProject(project.id);
      await refreshList(true, project.id);
      if (detail?.conversation.project_id === project.id && selectedIdRef.current) await refreshDetail(selectedIdRef.current);
      const summary = `已扫描 ${result.scanned} 个任务：新增 ${result.created} 个，更新 ${result.updated} 个，导入 ${result.importedMessages} 条消息和 ${result.importedActivities} 条处理记录${result.running ? `，${result.running} 个仍在本机执行` : ""}${result.truncated ? "；任务较多，本次仅同步最近 500 个" : ""}。`;
      setNotice(summary);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "远程项目同步失败");
      setNotice("");
    } finally {
      setSyncingProjects((current) => ({ ...current, [project.id]: false }));
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
    if (!conversationId || file.id === "") return;
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

  async function persistVoiceDraft(conversationId: string | null, content: string, quoteExcerpt: string) {
    if (!conversationId) return;
    const selected = selectedIdRef.current === conversationId;
    const cached = draftCacheRef.current.get(conversationId);
    const cachedDraft = selected ? composerDraftRef.current : cached?.composerDraft ?? null;
    draftCacheRef.current.set(conversationId, { content, quoteExcerpt, composerDraft: cachedDraft });
    if (selected && !editingPendingRef.current) {
      inputRef.current = content;
      askAgentQuoteRef.current = quoteExcerpt;
      setInput(content);
      setAskAgentQuote(quoteExcerpt);
      setDraftSaveState("unsaved");
    }
    try {
      await persistComposerDraft(conversationId, content, quoteExcerpt);
    } catch (reason) {
      if (selectedIdRef.current === conversationId) setError(reason instanceof Error ? reason.message : "语音转写草稿保存失败");
    }
  }

  async function sendVoiceTranscription(conversationId: string | null, content: string, quoteExcerpt: string, voiceTranscriptionIds: string[]) {
    if (!conversationId || !content.trim()) return;
    const selected = selectedIdRef.current === conversationId;
    if (selected) {
      setError(""); setNotice(""); setSubmitting(true);
      if (!sending) setActivities([{ kind: "status", label: "正在提交语音任务" }]);
    }
    try {
      await draftSaveQueueRef.current;
      await persistComposerDraft(conversationId, content, quoteExcerpt);
      const result = await api.sendMessage(conversationId, content, [], quoteExcerpt, true, voiceTranscriptionIds);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      draftCacheRef.current.delete(conversationId);
      draftSyncedSignaturesRef.current.set(conversationId, composerDraftSignature("", ""));
      if (selectedIdRef.current === conversationId) {
        composerDraftRef.current = null;
        inputRef.current = "";
        askAgentQuoteRef.current = "";
        setComposerDraft(null); setInput(""); setAskAgentQuote(""); setFiles([]); setDraftSaveState("idle");
        if (result.needsInstruction) setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        else if (result.externalRunning) setNotice(result.guidance || "任务正在本机客户端中执行；刷新项目确认空闲后会自动开始。");
        else if (result.maintenance) setNotice(result.guidance || MAINTENANCE_QUEUE_GUIDANCE);
        await reconcile(conversationId);
      } else {
        await refreshList(false).catch(() => undefined);
      }
    } catch (reason) {
      if (selectedIdRef.current === conversationId) setError(reason instanceof Error ? reason.message : "语音任务发送失败");
      else setNotice("原会话的语音任务发送失败；切回该会话后可以从草稿重试。");
    } finally {
      if (selectedIdRef.current === conversationId) setSubmitting(false);
    }
  }

  async function send(message = input, voiceTranscriptionIds: string[] = []) {
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
        const created = await api.createConversation(activeProjectIdRef.current ?? undefined); id = created.conversation.id;
        setSelectedModel(created.agentSelection.model); setReasoningEffort(created.agentSelection.reasoningEffort);
        selectedIdRef.current = id; setSelectedId(id);
      }
      if (editingPending) {
        const result = await api.updatePendingPrompt(id, editingPending.id, message, files, removedEditingFileIds, askAgentQuote, voiceTranscriptionIds);
        if (result.needsInstruction) {
          const persisted = result.editingPrompt ?? result.pendingPrompt ?? editingPending;
          editingPendingRef.current = persisted; setEditingPending(persisted); setRemovedEditingFileIds([]);
          setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        } else {
          editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]);
          draftLoadedConversationRef.current = null;
        }
        if (result.maintenance) setNotice(result.guidance || MAINTENANCE_QUEUE_GUIDANCE);
      } else {
        if (useComposerDraft) {
          if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
          await draftSaveQueueRef.current;
          await persistComposerDraft(id, message, askAgentQuote);
        }
        const result = await api.sendMessage(id, message, useComposerDraft ? [] : files, askAgentQuote, useComposerDraft, voiceTranscriptionIds);
        if (result.needsInstruction) setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        else if (result.externalRunning) setNotice(result.guidance || "任务正在本机客户端中执行；刷新项目确认空闲后会自动开始。");
        else if (result.maintenance) setNotice(result.guidance || MAINTENANCE_QUEUE_GUIDANCE);
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

  async function deleteConversation(conversation: Conversation, retry = false) {
    if (!retry && !window.confirm(`删除“${conversation.title}”？\n\n会话会先立即隐藏并停止入队，然后清理远端线程、本机工作文件、结果文件和关联记录。操作完成后无法恢复。`)) return;
    setError("");
    try {
      await api.deleteConversation(conversation.id);
      setCleanupRetry(null);
      if (selectedId === conversation.id) {
        retainedConversationRef.current = null;
        setSelectedId(null);
      }
      await refreshList();
    } catch (reason) {
      setCleanupRetry(conversation);
      setError(reason instanceof Error ? reason.message : "会话已隐藏，但清理失败；可安全重试");
      if (selectedId === conversation.id) {
        retainedConversationRef.current = null;
        setSelectedId(null);
      }
      await refreshList().catch(() => undefined);
    }
  }

  async function archiveConversation(conversation: Conversation) {
    setTaskMenu(null);
    if (conversationMenuRef.current) conversationMenuRef.current.open = false;
    if (!window.confirm(`归档“${conversation.title}”？\n\n它会从侧边栏隐藏，但消息、附件、草稿和 rollout 都会继续保存在磁盘上。`)) return;
    setError("");
    try {
      const result = await api.archiveConversation(conversation.id);
      if (retainedConversationRef.current?.id === conversation.id) retainedConversationRef.current = null;
      setDetail((current) => current?.conversation.id === conversation.id ? { ...current, conversation: result.conversation } : current);
      await refreshList(false, conversation.project_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    }
  }

  async function restoreConversation(conversation: Conversation) {
    setTaskMenu(null);
    if (conversationMenuRef.current) conversationMenuRef.current.open = false;
    setError("");
    try {
      const result = await api.restoreConversation(conversation.id);
      if (selectedIdRef.current === conversation.id) retainedConversationRef.current = result.conversation;
      setDetail((current) => current?.conversation.id === conversation.id ? { ...current, conversation: result.conversation } : current);
      await refreshList(false, conversation.project_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复归档失败");
    }
  }

  async function renameConversation(conversation: Conversation) {
    const title = window.prompt("修改任务名称", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    await api.renameConversation(conversation.id, title); await refreshList(); if (selectedId === conversation.id) await refreshDetail(conversation.id);
  }

  async function toggleConversationPin(conversation: Conversation) {
    setError("");
    try {
      const result = await api.setConversationPinned(conversation.id, !conversation.pinned_at);
      setDetail((current) => current?.conversation.id === result.conversation.id
        ? { ...current, conversation: result.conversation }
        : current);
      await refreshList();
      if (conversationMenuRef.current) conversationMenuRef.current.open = false;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新置顶状态失败");
    }
  }

  async function refreshWakeView(conversation: Conversation) {
    await refreshList(false, conversation.project_id);
    if (selectedIdRef.current === conversation.id) await refreshDetail(conversation.id);
  }

  function openWakeDetails(conversation: Conversation) {
    setTaskMenu(null);
    if (conversationMenuRef.current) conversationMenuRef.current.open = false;
    setWakeDetailsConversation(conversation);
  }

  async function cancelWakePlan(plan: WakePlan) {
    const conversation = detail?.conversation;
    if (!conversation || conversation.id !== plan.conversation_id) return;
    setError("");
    try { await api.cancelWake(conversation.id, plan.id); await refreshWakeView(conversation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "取消等待失败"); }
  }

  async function postponeWakePlan(plan: WakePlan) {
    const conversation = detail?.conversation;
    if (!conversation || conversation.id !== plan.conversation_id) return;
    setError("");
    try { await api.rescheduleWake(conversation.id, plan.id, 30 * 60); await refreshWakeView(conversation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "调整等待时间失败"); }
  }

  async function triggerWakePlan(plan: WakePlan) {
    const conversation = detail?.conversation;
    if (!conversation || conversation.id !== plan.conversation_id) return;
    setError("");
    try { await api.triggerWake(conversation.id, plan.id); await refreshWakeView(conversation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "立即继续失败"); }
  }

  async function logout() { try { await api.logout(); } finally { onLogout(); } }

  async function persistAgentSelection(selection: { model: string; reasoningEffort: ReasoningEffort }) {
    const targetId = selectedIdRef.current;
    const targetProjectId = detail?.conversation.project_id ?? activeProjectIdRef.current;
    const targetExecutorId = projects.find((project) => project.id === targetProjectId)?.executor_id;
    const previous = { model: selectedModel, reasoningEffort };
    setSelectedModel(selection.model); setReasoningEffort(selection.reasoningEffort); setSelectionSaving(true); setError("");
    try {
      const result = await api.updateAgentSelection(selection, targetId ?? undefined, targetExecutorId);
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

  async function fetchRemoteMessageFile(messageId: string, sourcePath: string): Promise<WorkFile> {
    const conversationId = selectedIdRef.current;
    if (!conversationId) throw new Error("请先选择任务");
    setError("");
    const result = await api.fetchRemoteFile(conversationId, messageId, sourcePath);
    setDetail((current) => current?.conversation.id === conversationId ? {
      ...current,
      messages: current.messages.map((message) => message.id !== messageId || message.files.some((file) => file.id === result.file.id)
        ? message
        : { ...message, files: [...message.files, result.file] }),
    } : current);
    return result.file;
  }

  const filtered = conversations;
  const currentDetail = detail?.conversation.id === selectedId ? detail : null;
  const currentProject = currentDetail ? projects.find((project) => project.id === currentDetail.conversation.project_id) : undefined;
  const remoteFileFetchEnabled = Boolean(currentProject?.executor_id.startsWith("remote:"));
  const restoringConversationSelection = !conversationSelectionReady;
  const loadingConversation = restoringConversationSelection || Boolean(selectedId && !currentDetail);
  const projectConversations = Object.values(projectConversationPages).flatMap((page) => page.conversations);
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedId)
    ?? projectConversations.find((conversation) => conversation.id === selectedId)
    ?? currentDetail?.conversation
    ?? null;
  const latestHandoff = currentDetail ? latestContextHandoff(currentDetail.messages) : null;
  const selectedProject = selectedConversation?.project_id
    ? projects.find((project) => project.id === selectedConversation.project_id)
    : undefined;
  const workspaceTitle = selectedConversation?.title || "Codex Web";
  const workspaceSubtitle = selectedProject?.display_name || selectedProject?.name || "PERSONAL AI WORKSTATION";
  const projectMenuProject = projectMenu ? projects.find((project) => project.id === projectMenu.projectId) : undefined;
  const taskMenuConversation = taskMenu
    ? [...conversations, ...projectConversations, ...(currentDetail ? [currentDetail.conversation] : [])]
      .find((conversation) => conversation.id === taskMenu.conversationId)
    : undefined;
  const account = resolveAccountIdentity(session);
  const conversationRow = (conversation: Conversation, projectId?: string) => <div
    key={conversation.id}
    className={`conversation-row ${selectedId === conversation.id ? "active" : ""} ${conversation.pinned_at ? "pinned" : ""} ${conversation.has_unread_result ? "unread" : ""} ${taskMenu?.conversationId === conversation.id ? "menu-open" : ""} ${draggedConversation?.id === conversation.id ? "dragging" : ""} ${conversationDropTarget?.id === conversation.id ? `drop-${conversationDropTarget.placement}` : ""}`}
    draggable={Boolean(projectId && !query)}
    aria-grabbed={projectId ? draggedConversation?.id === conversation.id : undefined}
    onDragStart={projectId ? (event) => beginConversationDrag(event, conversation, projectId) : undefined}
    onDragOver={projectId ? (event) => conversationDragOver(event, conversation, projectId) : undefined}
    onDrop={projectId ? (event) => void dropConversation(event, conversation, projectId) : undefined}
    onDragEnd={projectId ? () => { setDraggedConversation(null); setConversationDropTarget(null); setConversationProjectDropTarget(null); } : undefined}
    data-conversation-id={projectId ? conversation.id : undefined}
    data-project-id={projectId}
    data-pinned={projectId ? String(Boolean(conversation.pinned_at)) : undefined}
  >
    {projectId && <span
      className="touch-drag-handle"
      aria-hidden="true"
      onPointerDown={(event) => beginTouchDrag(event, {
        kind: "conversation",
        sourceId: conversation.id,
        projectId,
        pinned: Boolean(conversation.pinned_at),
        title: conversation.title,
        projectMoveBlocked: Boolean(conversation.project_move_blocked),
      })}
      onPointerMove={moveTouchDrag}
      onPointerUp={endTouchDrag}
      onPointerCancel={cancelTouchDrag}
    ><GripVertical size={12} /></span>}
    <button className="conversation-select" onClick={() => projectId ? selectProjectConversation(projectId, conversation.id) : selectConversation(conversation)}>
      <span>{conversation.title}</span>
      {conversation.pinned_at && <Pin className="conversation-pin-icon" size={14} strokeWidth={2.4} role="img" aria-label="已置顶" />}
      {conversation.cold_storage_state === "restoring"
        ? <span className="conversation-cold-icon" role="img" aria-label="正在恢复历史" title="正在恢复历史"><LoaderCircle size={14} className="spin" aria-hidden="true" /></span>
        : conversation.cold_storage_state === "cold"
        ? <span className="conversation-cold-icon" role="img" aria-label="已冷存储" title="已冷存储"><FolderArchive size={14} aria-hidden="true" /></span>
        : conversation.status === "running" || conversation.external_status === "running"
        ? <LoaderCircle size={14} className="spin" role="img" aria-label="正在执行" />
        : Boolean(conversation.has_pending_work) && !conversation.active_wake_count
          ? <CircleDashed size={14} className="conversation-waiting" role="img" aria-label={maintenancePhase === "idle" ? "等待发送" : "等待维护结束后发送"} />
          : null}
    </button>
    {Boolean(conversation.active_wake_count) && conversation.status !== "running" && conversation.external_status !== "running" && <button
      type="button"
      className="conversation-wake-trigger"
      aria-label={`查看 ${conversation.title} 的自动续跑详情`}
      title={wakeMenuDescription(conversation)}
      onClick={() => openWakeDetails(conversation)}
    ><Clock size={14} /></button>}
    <div className="row-actions">
      <button type="button" className="task-menu-trigger" data-task-menu aria-label={`任务 ${conversation.title} 操作`} aria-haspopup="menu" aria-expanded={taskMenu?.conversationId === conversation.id} title="任务操作" onClick={(event) => toggleTaskMenu(conversation, event.currentTarget)}><MoreHorizontal size={15} /></button>
    </div>
  </div>;

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.matchMedia("(max-width: 720px)").matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth };
    document.documentElement.classList.add("sidebar-resizing");
  }

  function moveSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = sidebarResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setSidebarWidth(normalizeSidebarWidth(resize.startWidth + event.clientX - resize.startX));
  }

  function endSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    sidebarResizeRef.current = null;
    document.documentElement.classList.remove("sidebar-resizing");
  }

  function resizeSidebarWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!delta && event.key !== "Home") return;
    event.preventDefault();
    setSidebarWidth((width) => event.key === "Home" ? SIDEBAR_WIDTH_DEFAULT : normalizeSidebarWidth(width + delta));
  }

  return <div className="shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="sidebar-top">
        <div className="wordmark"><span className="brand-mark small"><Zap size={15} /></span><span className="brand-copy"><strong>Codex Web</strong><small>PERSONAL AI WORKSTATION</small></span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭"><X size={19} /></button>
      </div>
      <div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务" /><SearchVoiceInput query={query} projectId={activeProjectId} disabled={conversationListLoading} onTranscript={(text) => setQuery((current) => current ? `${current} ${text}` : text)} /></div>
      <div className="conversation-section">
        {session.projectMode && <div className="project-section">
          <div className="section-label project-label"><span>项目</span><button type="button" data-project-menu aria-label="项目操作" aria-haspopup="menu" aria-expanded={Boolean(projectSectionMenu)} title="项目操作" onClick={(event) => toggleProjectSectionMenu(event.currentTarget)}><MoreHorizontal size={15} /></button></div>
          <div className="sidebar-scroll-region"><div className="project-list" onScroll={() => { setProjectMenu(null); setProjectSectionMenu(null); setTaskMenu(null); }} onDragOver={projectListDragOver} onDrop={(event) => void dropProjectInList(event)}>
            {projects.map((project) => {
              const collapsed = Boolean(collapsedProjects[project.id]);
              const page = projectConversationPages[project.id];
              const conversationMoveCandidate = Boolean(draggedConversation && draggedConversation.projectId !== project.id);
              const conversationMoveReason = draggedConversation && conversationMoveCandidate
                ? conversationProjectMoveBlockReason(draggedConversation, project, projects)
                : null;
              const conversationProjectTarget = conversationProjectDropTarget?.projectId === project.id
                ? conversationProjectDropTarget
                : null;
              return <div
                key={project.id}
                className={`project-group ${draggedProjectId === project.id ? "dragging" : ""} ${projectDropTarget?.id === project.id ? `drop-${projectDropTarget.placement}` : ""} ${conversationProjectTarget ? `conversation-drop-${conversationProjectTarget.allowed ? "allowed" : "blocked"}` : ""}`}
                data-project-id={project.id}
                onDragOver={(event) => projectDragOver(event, project.id)}
                onDrop={(event) => void dropProject(event, project.id)}
              >
                <div
                  className={`project-row ${activeProjectId === project.id ? "active" : ""}`}
                  draggable
                  aria-grabbed={draggedProjectId === project.id}
                  onDragStart={(event) => beginProjectDrag(event, project.id)}
                  onDragEnd={() => { setDraggedProjectId(null); setProjectDropTarget(null); }}
                >
                  <span
                    className="touch-drag-handle"
                    aria-hidden="true"
                    onPointerDown={(event) => beginTouchDrag(event, { kind: "project", sourceId: project.id })}
                    onPointerMove={moveTouchDrag}
                    onPointerUp={endTouchDrag}
                    onPointerCancel={cancelTouchDrag}
                  ><GripVertical size={12} /></span>
                  <button type="button" className="project-select" onClick={() => toggleProject(project.id)} title={project.root_path} aria-expanded={!collapsed}>
                    {project.executor_id.startsWith("remote:")
                      ? (collapsed ? <Monitor size={16} /> : <MonitorUp size={16} />)
                      : (collapsed ? <Folder size={16} /> : <FolderOpen size={16} />)}
                    <span>{project.display_name || project.name}</span>
                    {conversationMoveCandidate && <small
                      className={`project-move-hint ${conversationMoveReason ? "blocked" : "allowed"}`}
                      title={conversationMoveReason ?? "可将任务移到这个项目"}
                    >{conversationMoveReason ? "不可移动" : "移到这里"}</small>}
                    {project.executor_status !== "online" && <i className="executor-offline-dot" title={`${project.machine_name} 已离线`} aria-label={`${project.machine_name} 已离线`} />}
                  </button>
                  <div className="project-actions">
                    <button type="button" data-project-menu aria-label={`项目 ${project.name} 操作`} aria-haspopup="menu" aria-expanded={projectMenu?.projectId === project.id} title="项目操作" onClick={(event) => toggleProjectMenu(project, event.currentTarget)}><MoreHorizontal size={15} /></button>
                    <button type="button" onClick={() => void newConversation(project.id)} aria-label={`在项目 ${project.name} 中新建对话`} title="在此项目中新建对话"><SquarePen size={14} /></button>
                  </div>
                </div>
                {!collapsed && <div className="project-conversations">
                  {page?.conversations.map((conversation) => conversationRow(conversation, project.id))}
                  {projectPageLoading[project.id] && <div className="list-loading"><LoaderCircle className="spin" size={14} /><span>正在加载…</span></div>}
                  {projectBodySearchLoading[project.id] && <div className="list-loading"><LoaderCircle className="spin" size={14} /><span>正在搜索正文…</span></div>}
                  {!projectPageLoading[project.id] && !projectBodySearchLoading[project.id] && page && page.conversations.length === 0 && <div className="project-empty">{query ? "没有匹配任务" : "还没有任务"}</div>}
                  {page?.hasMore && <button type="button" className="project-show-more" disabled={projectPageLoading[project.id]} onClick={() => void loadMoreProjectConversations(project.id)}>展开显示</button>}
                </div>}
              </div>;
            })}
          </div></div>
        </div>}
        {!session.projectMode && <>
          <div className="section-label"><span>任务</span><strong>{conversationTotal}</strong></div>
          <div className="sidebar-scroll-region"><div className="conversation-list" onScroll={handleConversationListScroll}>
            {filtered.map((conversation) => conversationRow(conversation))}
            {filtered.length === 0 && !conversationListLoading && !conversationBodySearchLoading && <div className="empty-list">{query ? "没有匹配任务" : "还没有任务"}</div>}
            {conversationListLoading && <div className="list-loading"><LoaderCircle className="spin" size={15} /><span>正在加载…</span></div>}
            {conversationBodySearchLoading && <div className="list-loading"><LoaderCircle className="spin" size={15} /><span>正在搜索正文…</span></div>}
            {!conversationHasMore && !conversationBodySearchLoading && filtered.length > 0 && <div className="list-end">已显示全部 {conversationTotal} 条</div>}
          </div></div>
        </>}
      </div>
      <div className="account-area" ref={accountAreaRef}>
        {accountSettingsOpen && <section className="account-settings" aria-label="个人设置">
          <div className="account-settings-heading"><Settings2 size={15} /><strong>个人设置</strong></div>
          <button className="account-settings-archive display-settings-trigger" type="button" aria-haspopup="dialog" aria-expanded={displaySettingsDialogOpen} onClick={() => { setAccountSettingsOpen(false); setDisplaySettingsDialogOpen(true); }}><Settings2 size={16} /><span>显示设置</span></button>
          {session.accountId === HOST_ROOT_ACCOUNT_ID && <button className="account-settings-archive" type="button" onClick={() => { setAccountSettingsOpen(false); setAccountAuthDialogOpen(true); }}><KeyRound size={16} /><span>Codex 账号管理</span></button>}
          <button className="account-settings-archive" type="button" onClick={() => { setAccountSettingsOpen(false); setPersonalMemoryDialogOpen(true); }}><BookOpen size={16} /><span>个人知识</span></button>
          <button className="account-settings-archive" type="button" onClick={() => { setAccountSettingsOpen(false); setVoiceLexiconDialogOpen(true); }}><Mic size={16} /><span>语音关键词</span></button>
          <button className="account-settings-archive" type="button" onClick={() => { setAccountSettingsOpen(false); setPublicSharesDialogOpen(true); }}><Share2 size={16} /><span>公开分享管理</span></button>
          <button className="account-settings-archive" type="button" onClick={() => { setAccountSettingsOpen(false); setArchivedDialogOpen(true); }}><Archive size={16} /><span>查看已归档的会话</span></button>
          <button className="account-settings-logout" type="button" onClick={() => void logout()}><LogOut size={16} /><span>退出登录</span></button>
        </section>}
        <div className="account-row">
          <button className="account-profile" type="button" aria-expanded={accountSettingsOpen} onClick={() => setAccountSettingsOpen((open) => !open)}>
            <span className="avatar" aria-label={`${account.displayName} 头像`}>{account.initials}</span><span className="account-copy"><strong>{account.displayName}</strong><small>私人工作站</small></span><Settings2 size={15} />
          </button>
        </div>
      </div>
      {displaySettingsDialogOpen && <DisplaySettingsDialog
        chatFontSize={chatFontSize}
        fontSizeSaving={fontSizeSaving}
        onChangeFontSize={(delta) => void changeChatFontSize(delta)}
        themePreference={themePreference}
        onThemePreferenceChange={onThemePreferenceChange}
        onClose={() => setDisplaySettingsDialogOpen(false)}
      />}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title="拖动调整侧边栏宽度，双击恢复默认"
        onPointerDown={beginSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={endSidebarResize}
        onPointerCancel={endSidebarResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
        onKeyDown={resizeSidebarWithKeyboard}
      />
    </aside>

    {projectSectionMenu && createPortal(<div
      className="project-menu-panel project-section-menu"
      data-project-menu
      role="menu"
      aria-label="项目操作"
      style={{ top: projectSectionMenu.top, left: projectSectionMenu.left }}
    >
      <button type="button" role="menuitem" onClick={() => { setProjectSectionMenu(null); setProjectDialogOpen(true); }}><Plus size={16} /><span>新建项目</span></button>
    </div>, document.body)}

    {projectMenu && projectMenuProject && createPortal(<div
      className="project-menu-panel"
      data-project-menu
      role="menu"
      aria-label={`项目 ${projectMenuProject.name} 操作`}
      style={{ top: projectMenu.top, left: projectMenu.left }}
    >
      {projectMenuProject.executor_id.startsWith("remote:") && <button
        type="button"
        role="menuitem"
        disabled={projectMenuProject.executor_status !== "online" || syncingProjects[projectMenuProject.id]}
        onClick={() => { setProjectMenu(null); void syncProject(projectMenuProject); }}
      ><RefreshCw size={16} className={syncingProjects[projectMenuProject.id] ? "spin" : ""} /><span>{syncingProjects[projectMenuProject.id] ? "正在刷新" : "刷新任务"}</span></button>}
      <button type="button" role="menuitem" disabled={projectMenuProject.executor_id !== "tenant-local"} title={projectMenuProject.executor_id === "tenant-local" ? "管理项目级技能" : "宿主项目和远端项目暂不支持网页项目技能管理"} onClick={() => { if (projectMenuProject.executor_id !== "tenant-local") return; setProjectMenu(null); setProjectSkillsDialogProject(projectMenuProject); }}><Pencil size={16} /><span>管理项目技能{projectMenuProject.executor_id !== "tenant-local" ? "（暂不支持）" : ""}</span></button>
      <button type="button" role="menuitem" onClick={() => { setProjectMenu(null); void renameProject(projectMenuProject); }}><Pencil size={16} /><span>改名</span></button>
      <button type="button" role="menuitem" className="danger" onClick={() => void archiveProject(projectMenuProject)}><Archive size={16} /><span>归档项目</span></button>
    </div>, document.body)}

    {taskMenu && taskMenuConversation && createPortal(<div
      className="task-menu-panel"
      data-task-menu
      role="menu"
      aria-label={`任务 ${taskMenuConversation.title} 操作`}
      style={{ top: taskMenu.top, left: taskMenu.left }}
    >
      <button type="button" role="menuitem" className={taskMenuConversation.pinned_at ? "active" : undefined} onClick={() => { setTaskMenu(null); void toggleConversationPin(taskMenuConversation); }}>{taskMenuConversation.pinned_at ? <PinOff size={16} /> : <Pin size={16} />}<span>{taskMenuConversation.pinned_at ? "取消置顶" : "置顶"}</span></button>
      <button type="button" role="menuitem" onClick={() => { setTaskMenu(null); void renameConversation(taskMenuConversation); }}><Pencil size={16} /><span>重命名</span></button>
      {taskMenuConversation.active_wake_count
        ? <button type="button" role="menuitem" className="wake-menu-item active" title="查看自动续跑详情" onClick={() => openWakeDetails(taskMenuConversation)}><Clock size={16} /><span className="menu-item-copy"><strong>已安排的任务</strong><small>{wakeMenuDescription(taskMenuConversation)}</small></span></button>
        : <button type="button" role="menuitem" disabled={Boolean(taskMenuConversation.archived_at)} onClick={() => { setTaskMenu(null); setWakeDialogConversation(taskMenuConversation); }}><Clock size={16} /><span>安排自动续跑</span></button>}
      <button type="button" role="menuitem" onClick={() => void archiveConversation(taskMenuConversation)}><Archive size={16} /><span>归档</span></button>
      <button type="button" role="menuitem" className="danger" onClick={() => { setTaskMenu(null); void deleteConversation(taskMenuConversation); }}><Trash2 size={16} /><span>删除</span></button>
    </div>, document.body)}

    {projectDialogOpen && <ProjectDialog onClose={() => setProjectDialogOpen(false)} onCreated={projectCreated} />}
    {projectSkillsDialogProject && <ProjectSkillsDialog project={projectSkillsDialogProject} onClose={() => setProjectSkillsDialogProject(null)} />}
    {wakeDialogConversation && <WakePlanDialog conversation={wakeDialogConversation} onClose={() => setWakeDialogConversation(null)} onCreated={(result) => {
      const conversation = wakeDialogConversation;
      setWakeDialogConversation(null);
      void refreshWakeView(conversation).then(() => {
        if (result.targetConversation && result.targetConversation.id !== conversation.id) {
          selectedIdRef.current = result.targetConversation.id;
          setSelectedId(result.targetConversation.id);
        }
      });
    }} />}
    {wakeDetailsConversation && <WakePlanDetailsDialog
      conversation={wakeDetailsConversation}
      onClose={() => setWakeDetailsConversation(null)}
      onChanged={() => refreshWakeView(wakeDetailsConversation)}
    />}
    {archivedDialogOpen && <ArchivedConversationsDialog
      onClose={() => setArchivedDialogOpen(false)}
      onSelect={(conversation) => { setArchivedDialogOpen(false); setAccountSettingsOpen(false); setSelectedId(conversation.id); }}
      onRestored={(conversation) => void refreshList(false, conversation.project_id).catch((reason) => setError(reason instanceof Error ? reason.message : "任务列表刷新失败"))}
    />}
    {personalMemoryDialogOpen && <PersonalMemoryDialog onClose={() => setPersonalMemoryDialogOpen(false)} />}
    {voiceLexiconDialogOpen && <VoiceLexiconDialog onClose={() => setVoiceLexiconDialogOpen(false)} />}
    {publicSharesDialogOpen && <PublicSharesDialog onClose={() => setPublicSharesDialogOpen(false)} />}
    {accountAuthDialogOpen && createPortal(<AccountAuthDialog onClose={() => setAccountAuthDialogOpen(false)} />, document.body)}

    <main className={`workspace ${currentDetail?.pendingPrompts.length ? "has-pending-queue" : ""}`}>
      <header className="workspace-header">
        <div className="workspace-header-start"><button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏"><Menu size={20} /></button><div className="wordmark workspace-context" title={`${workspaceTitle} · ${workspaceSubtitle}`}><span className="brand-mark small">{selectedProject?.executor_id.startsWith("remote:") ? <Monitor size={15} /> : selectedProject ? <Folder size={15} /> : <Zap size={14} />}</span><span className="brand-copy workspace-context-copy"><strong>{workspaceTitle}{maintenancePhase !== "idle" && <span className="maintenance-state" role="status" aria-live="polite" title={maintenanceStatus?.message ?? undefined}>（<span className="maintenance-label">{maintenanceStatusLabel(maintenancePhase, maintenanceStatus)}</span> <LoaderCircle className="spin" size={11} />）</span>}</strong><small>{workspaceSubtitle}</small></span></div>{maintenanceStatus?.deployment && <details className={`deployment-status deployment-status-${deploymentStatusTone(maintenanceStatus.deployment)}`} role="status"><summary title={maintenanceStatus.deployment.message}><span className="deployment-status-dot" aria-hidden="true" /><span className="deployment-status-copy"><strong>发布 {deploymentStageNumber(maintenanceStatus.deployment.phase)}/{DEPLOYMENT_STAGES.length}</strong><small>{deploymentPhaseLabel(maintenanceStatus.deployment)}</small></span>{deploymentStatusTone(maintenanceStatus.deployment) === "active" && <LoaderCircle className="spin" size={13} />}{maintenanceStatus.deployment.requestId !== null && <span className="deployment-request">#{maintenanceStatus.deployment.requestId}</span>}</summary><div className="deployment-status-panel"><div className="deployment-status-heading"><strong>{maintenanceStatus.deployment.message}</strong>{maintenanceStatus.deployment.targetSha && <code title={maintenanceStatus.deployment.targetSha}>{maintenanceStatus.deployment.targetSha.slice(0, 7)}</code>}</div><ol>{DEPLOYMENT_STAGES.map((stage, index) => { const current = deploymentStageNumber(maintenanceStatus.deployment!.phase); const history = maintenanceStatus.deployment!.phaseHistory ?? []; const visited = history.some((entry) => entry.phase === stage.phase); const done = maintenanceStatus.deployment!.phase === "deployed" || index + 1 < current || (visited && stage.phase !== maintenanceStatus.deployment!.phase); const failed = !done && ["failed", "conflict", "deferred"].includes(maintenanceStatus.deployment!.phase) && index + 1 === current; return <li key={stage.phase} className={`${done ? "done" : ""} ${failed ? "failed" : ""} ${!done && !failed && index + 1 === current ? "current" : ""}`}><span aria-hidden="true" />{stage.label}</li>; })}</ol>{maintenanceStatus.deployment.errorSummary && <p className="deployment-status-error">{maintenanceStatus.deployment.errorSummary}</p>}</div></details>}</div>
        <div className="workspace-header-actions">
          {currentDetail && shouldWarnAboutRollout(currentDetail.rolloutBytes) && <details className="rollout-warning" key={currentDetail.conversation.id} ref={rolloutWarningRef}>
            <summary className="icon-button" aria-label={`rollout 容量提醒：${formatRolloutBytes(currentDetail.rolloutBytes!)}`} title="rollout 容量提醒"><HardDrive size={17} /><span /></summary>
            <div className="rollout-warning-panel" role="status">
              <strong>rollout 已达到 {formatRolloutBytes(currentDetail.rolloutBytes!)}</strong>
              <p>超过 {formatRolloutBytes(ROLLOUT_WARNING_BYTES)} 提醒阈值。rollout 是 Codex 维护的本地会话记录；容量大表示会话历史和磁盘占用较重，并不代表每轮都会上传整个文件，也不能单独说明网络超时。</p>
            </div>
          </details>}
          <button className="icon-button" onClick={() => void newConversation()} aria-label="新建会话" title="新建会话"><SquarePen size={20} /></button>
          {selectedConversation ? <details className="conversation-menu" ref={conversationMenuRef}>
            <summary className="icon-button" aria-label="会话操作" title="会话操作"><MoreHorizontal size={21} /></summary>
            <div className="conversation-menu-panel" role="menu">
              <div className="conversation-menu-actions">{selectedConversation.archived_at
                ? <button role="menuitem" onClick={() => void restoreConversation(selectedConversation)}><RotateCcw size={17} /><span>恢复到侧边栏</span></button>
                : <>
                  <button role="menuitem" onClick={() => void toggleConversationPin(selectedConversation)}>{selectedConversation.pinned_at ? <PinOff size={17} /> : <Pin size={17} />}<span>{selectedConversation.pinned_at ? "取消置顶" : "置顶"}</span></button>
                  {selectedConversation.active_wake_count
                    ? <button role="menuitem" className="wake-menu-item active" title="查看自动续跑详情" onClick={() => openWakeDetails(selectedConversation)}><Clock size={17} /><span className="menu-item-copy"><strong>已安排的任务</strong><small>{wakeMenuDescription(selectedConversation)}</small></span></button>
                    : <button role="menuitem" onClick={() => { if (conversationMenuRef.current) conversationMenuRef.current.open = false; setWakeDialogConversation(selectedConversation); }}><Clock size={17} /><span>安排自动续跑</span></button>}
                  {latestHandoff
                    ? <button role="menuitem" disabled={submitting || sending} onClick={() => void createConversationFromHandoff()}><BookOpen size={17} /><span>用交接摘要新建会话</span></button>
                    : <button role="menuitem" disabled={submitting || sending || Boolean(selectedConversation.has_pending_work) || Boolean(selectedConversation.active_wake_count)} onClick={() => void requestContextHandoff()}><BookOpen size={17} /><span>生成交接摘要</span></button>}
                  <button role="menuitem" onClick={() => void archiveConversation(selectedConversation)}><Archive size={17} /><span>归档</span></button>
                </>}</div>
              <div className="conversation-menu-separator" role="separator" />
              <div className="conversation-menu-info" role="group" aria-label="会话容量信息">
                <div className="conversation-menu-info-row" title="Codex 在磁盘上维护的当前会话记录文件大小">
                  <HardDrive size={16} /><span><small>Rollout 文件</small><strong>{currentDetail ? currentDetail.rolloutBytes === null ? "暂无数据" : formatRolloutBytes(currentDetail.rolloutBytes) : "读取中…"}</strong></span>
                </div>
                <div className="conversation-menu-info-row" title="最近一次请求使用的输入上下文 / 当前模型上下文窗口">
                  <Bot size={16} /><span><small>Codex 上下文</small><strong>{currentDetail ? currentDetail.contextUsage ? formatContextUsage(currentDetail.contextUsage.inputTokens, currentDetail.contextUsage.modelContextWindow) : "暂无数据" : "读取中…"}</strong></span>
                </div>
                <div className="conversation-menu-info-row" title="当前 Codex 套餐周期的剩余额度">
                  <Gauge size={16} /><span><small>套餐额度</small><strong>{currentDetail ? currentDetail.packageQuota ? `${Math.round(currentDetail.packageQuota.remainingPercent)}%` : "暂无数据" : "读取中…"}</strong></span>
                </div>
              </div>
            </div>
          </details> : <button className="icon-button" aria-label="会话操作" title="请先选择会话" disabled><MoreHorizontal size={21} /></button>}
        </div>
      </header>
      {currentDetail ? <Chat detail={currentDetail} activities={activities} activitiesLoading={activitiesLoading} sending={sending} loadingOlderMessages={loadingOlderMessages} messagesRef={messagesRef} onMessagesScroll={handleMessagesScroll} onAskAgent={askAgentAbout} onFetchRemoteFile={fetchRemoteMessageFile} remoteFileFetchEnabled={remoteFileFetchEnabled} userInitials={account.initials} chatFontSize={chatFontSize} onCancelWake={cancelWakePlan} onPostponeWake={postponeWakePlan} onTriggerWake={triggerWakePlan} onEditWake={() => openWakeDetails(currentDetail.conversation)} />
        : loadingConversation ? <ConversationLoading restoring={restoringConversationSelection} />
        : <Welcome onSuggestion={(text) => setInput(text)} />}
      {error && <div className="toast"><span>{error}</span>{cleanupRetry && <button type="button" onClick={() => void deleteConversation(cleanupRetry, true)}>重试清理</button>}<button onClick={() => { setError(""); setCleanupRetry(null); }}><X size={16} /></button></div>}
      {notice && <div className="toast info" role="status"><span>{notice}</span><button onClick={() => setNotice("")}><X size={16} /></button></div>}
      {currentDetail?.conversation.archived_at && <div className="archived-conversation-banner"><Archive size={15} /><span>这是已归档会话，只读查看；消息、附件和 rollout 仍保存在原处。</span><button type="button" onClick={() => void restoreConversation(currentDetail.conversation)}>恢复</button></div>}
      {conversationSelectionReady && (!selectedId || !selectedConversation?.archived_at) && <Composer accountId={session.accountId ?? null} input={input} setInput={setInput} askAgentQuote={askAgentQuote} onClearAskAgentQuote={() => setAskAgentQuote("")} focusRequest={composerFocusRequest} files={files} setFiles={setFiles} draftFiles={composerDraft?.files ?? []} draftUploads={draftUploads} draftSaveState={draftSaveState} sending={sending} submitting={submitting} selectionSaving={selectionSaving}
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
        onVoiceActivityChange={(active) => { voiceInputActiveRef.current = active; setVoiceInputActive(active); }}
        onVoiceTranscript={(conversationId, content, quoteExcerpt) => { void persistVoiceDraft(conversationId, content, quoteExcerpt); }}
        onVoiceSendAfterTranscription={(conversationId, content, quoteExcerpt, voiceTranscriptionIds) => { void sendVoiceTranscription(conversationId, content, quoteExcerpt, voiceTranscriptionIds); }}
        onSend={(message, voiceTranscriptionIds) => void send(message, voiceTranscriptionIds)} onCancel={job && selectedId ? () => void api.cancelConversation(selectedId).then(() => reconcile(selectedId)) : undefined} />}
    </main>
  </div>;
}

function ConversationLoading({ restoring = false }: { restoring?: boolean }) {
  return <section className="conversation-loading" role="status" aria-live="polite"><LoaderCircle className="spin" size={23} /><span>{restoring ? "正在恢复上次任务…" : "正在加载任务…"}</span></section>;
}

function ArchivedConversationsDialog({ onClose, onSelect, onRestored }: {
  onClose: () => void;
  onSelect: (conversation: Conversation) => void;
  onRestored: (conversation: Conversation) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (offset = 0) => {
    setLoading(true); setError("");
    try {
      const page = await api.archivedConversations({ limit: 100, offset });
      setConversations((current) => offset ? [...current, ...page.conversations] : page.conversations);
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "已归档会话加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  async function restore(conversation: Conversation) {
    if (restoringId) return;
    setRestoringId(conversation.id); setError("");
    try {
      const result = await api.restoreConversation(conversation.id);
      setConversations((current) => current.filter((item) => item.id !== conversation.id));
      setTotal((current) => Math.max(0, current - 1));
      onRestored(result.conversation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复归档失败");
    } finally {
      setRestoringId(null);
    }
  }

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-dialog archived-dialog" role="dialog" aria-modal="true" aria-labelledby="archived-dialog-title">
      <header><div><h2 id="archived-dialog-title">已归档的会话</h2><p>共 {total} 条。归档只影响侧边栏显示，历史消息、附件、草稿和 rollout 均未删除。</p></div><button type="button" onClick={onClose} aria-label="关闭已归档会话"><X size={18} /></button></header>
      <div className="archived-conversation-list" aria-busy={loading}>
        {conversations.map((conversation) => <div className="archived-conversation-row" key={conversation.id}>
          <button type="button" className="archived-conversation-open" onClick={() => onSelect(conversation)}>
            <Archive size={16} /><span><strong>{conversation.title}</strong><small>归档于 {formatFullDateTime(conversation.archived_at!)}</small></span>
          </button>
          <button type="button" className="archived-conversation-restore" disabled={Boolean(restoringId)} onClick={() => void restore(conversation)} title="恢复到侧边栏" aria-label={`恢复 ${conversation.title}`}>
            {restoringId === conversation.id ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
          </button>
        </div>)}
        {!loading && conversations.length === 0 && <div className="archived-conversation-empty">还没有已归档会话</div>}
        {loading && conversations.length === 0 && <div className="archived-conversation-empty"><LoaderCircle className="spin" size={17} />正在加载…</div>}
      </div>
      {hasMore && <button type="button" className="archived-load-more" disabled={loading} onClick={() => void load(conversations.length)}>{loading ? "正在加载…" : "加载更多"}</button>}
      {error && <div className="project-dialog-error">{error}</div>}
    </section>
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
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setAgentOptions(null);
    setError("");
    void api.agentOptions({ conversationId: conversation.id }).then((options) => {
      if (!active) return;
      setAgentOptions(options);
      setModel(options.selection.model);
      setReasoningEffort(options.selection.reasoningEffort);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "续跑模型选项加载失败");
    });
    return () => { active = false; };
  }, [conversation.id]);

  const selectedModel = agentOptions?.models.find((option) => option.id === model);
  const effortOptions = agentOptions?.reasoningEfforts.filter((effort) => selectedModel?.reasoningEfforts.includes(effort.id)) ?? [];

  function changeModel(nextModel: string) {
    setModel(nextModel);
    const option = agentOptions?.models.find((item) => item.id === nextModel);
    if (!option?.reasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(option?.reasoningEfforts[0] ?? "");
    }
  }

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy, onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(delay);
    const multiplier = unit === "minutes" ? 60 : unit === "hours" ? 3600 : 86400;
    if (!Number.isFinite(amount) || amount <= 0 || !prompt.trim() || !model || !reasoningEffort) { setError("请填写有效的等待时间、续跑指令、模型和思考深度。"); return; }
    setBusy(true); setError("");
    try {
      const result = await api.createTimeWake(conversation.id, {
        delaySeconds: Math.round(amount * multiplier),
        label: label.trim(),
        prompt: prompt.trim(),
        newConversation,
        model,
        reasoningEffort,
      });
      onCreated(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "自动续跑安排失败");
      setBusy(false);
    }
  }

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="project-dialog wake-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="wake-plan-dialog-title" onSubmit={submit}>
      <header><div><h2 id="wake-plan-dialog-title">安排自动续跑</h2><p>“{conversation.title}”会在时间到达后{newConversation ? "在新会话中" : "回到原会话"}继续。每次触发一次；Codex 可在下一轮按需再次安排。</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={18} /></button></header>
      <div className="project-dialog-body wake-plan-fields">
        <label>等待时间<div className="wake-delay-row"><input type="number" min="1" step="0.1" value={delay} onChange={(event) => setDelay(event.target.value)} /><select value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></div></label>
        <label>显示名称<input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="例如：两小时后检查" /></label>
        <label className="wake-conversation-toggle"><input type="checkbox" checked={newConversation} onChange={(event) => setNewConversation(event.target.checked)} /><span><strong>新建会话继续</strong><small>{newConversation ? "安排时立即创建新会话，等待和结果都留在新会话。" : "保持关闭时，到点后接着当前会话继续。"}</small></span></label>
        <div className="wake-selection-row">
          <label>续跑模型<select value={model} disabled={!agentOptions} onChange={(event) => changeModel(event.target.value)}>{agentOptions?.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          <label>思考深度<select value={reasoningEffort} disabled={!agentOptions || effortOptions.length === 0} onChange={(event) => setReasoningEffort(event.target.value)}>{effortOptions.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}</select></label>
        </div>
        {agentOptions && <p className="wake-selection-summary">本次续跑：{selectedModel?.label ?? model} · {effortOptions.find((effort) => effort.id === reasoningEffort)?.label ?? reasoningEffort}</p>}
        <label>到点后交给 Codex 的指令<textarea value={prompt} maxLength={20_000} rows={6} onChange={(event) => setPrompt(event.target.value)} /></label>
        <p className="wake-plan-note"><Clock size={14} />等待不占用 Worker，也不会用 sleep 保持任务；到点后仍会遵守会话串行和机器容量。</p>
        {error && <div className="project-dialog-error">{error}</div>}
      </div>
      <footer><span /><div><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy || !agentOptions}>{busy ? <><LoaderCircle className="spin" size={15} />正在安排</> : "确认安排"}</button></div></footer>
    </form>
  </div>;
}

function wakeDeadlineInputValue(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function wakeDeadlineIso(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function WakePlanDetailsDialog({ conversation, onClose, onChanged }: { conversation: Conversation; onClose: () => void; onChanged: () => Promise<void> }) {
  const [plan, setPlan] = useState<WakePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"cancel" | "postpone" | "trigger" | "reschedule" | "save" | "">("");
  const [editingPrompts, setEditingPrompts] = useState(true);
  const [deadlineInput, setDeadlineInput] = useState("");
  const [successPrompt, setSuccessPrompt] = useState("");
  const [failurePrompt, setFailurePrompt] = useState("");
  const [timeoutPrompt, setTimeoutPrompt] = useState("");
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("");
  const [openSettingMenu, setOpenSettingMenu] = useState<"model" | "effort" | null>(null);
  const [error, setError] = useState("");

  function applyPlan(next: WakePlan | null) {
    setPlan(next);
    setDeadlineInput(wakeDeadlineInputValue(next?.deadline_at));
    setSuccessPrompt(next?.success_prompt ?? "");
    setFailurePrompt(next?.failure_prompt ?? "");
    setTimeoutPrompt(next?.timeout_prompt ?? "");
    setModel(next?.agent_model ?? "");
    setReasoningEffort(next?.reasoning_effort ?? "");
  }

  const promptDirty = Boolean(plan && editingPrompts && (
    successPrompt !== plan.success_prompt
    || (plan.mode === "event_or_deadline" && (failurePrompt !== plan.failure_prompt || timeoutPrompt !== plan.timeout_prompt))
    || model !== plan.agent_model
    || reasoningEffort !== plan.reasoning_effort
  ));
  const deadlineDirty = Boolean(plan && deadlineInput !== wakeDeadlineInputValue(plan.deadline_at));
  const dirty = promptDirty || deadlineDirty;

  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm("等待计划修改尚未保存，确定放弃修改并关闭吗？")) return;
    onClose();
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setAgentOptions(null);
    void Promise.all([api.activeWake(conversation.id), api.agentOptions({ conversationId: conversation.id })]).then(([wake, options]) => {
      if (!active) return;
      setAgentOptions(options);
      applyPlan(wake.wakePlan);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "等待详情读取失败");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [conversation.id]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") requestClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy, dirty, onClose]);

  async function run(kind: "cancel" | "postpone" | "trigger") {
    if (!plan || busy) return;
    if (dirty && !window.confirm("续跑修改尚未保存，继续此操作将放弃当前修改，确定继续吗？")) return;
    setBusy(kind); setError("");
    try {
      if (kind === "postpone") {
        const result = await api.rescheduleWake(conversation.id, plan.id, 30 * 60);
        applyPlan(result.wakePlan);
        await onChanged();
        return;
      }
      if (kind === "cancel") await api.cancelWake(conversation.id, plan.id);
      else await api.triggerWake(conversation.id, plan.id);
      await onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "等待计划操作失败");
    } finally {
      setBusy("");
    }
  }

  async function saveDeadline() {
    if (!plan || busy || !deadlineDirty) return;
    const deadlineAt = wakeDeadlineIso(deadlineInput);
    if (!deadlineAt) {
      setError("请输入有效的安排时间。");
      return;
    }
    setBusy("reschedule");
    setError("");
    try {
      const result = await api.rescheduleWakeAt(conversation.id, plan.id, deadlineAt);
      if (result.wakePlan.state !== "armed") {
        await onChanged();
        onClose();
        return;
      }
      setPlan(result.wakePlan);
      setDeadlineInput(wakeDeadlineInputValue(result.wakePlan.deadline_at));
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "安排时间保存失败");
    } finally {
      setBusy("");
    }
  }

  function cancelPromptEdit() {
    if (!plan || busy) return;
    setSuccessPrompt(plan.success_prompt);
    setFailurePrompt(plan.failure_prompt);
    setTimeoutPrompt(plan.timeout_prompt);
    setModel(plan.agent_model);
    setReasoningEffort(plan.reasoning_effort);
    setEditingPrompts(false);
    setOpenSettingMenu(null);
    setError("");
  }

  function changeModel(nextModel: string) {
    setModel(nextModel);
    const option = agentOptions?.models.find((item) => item.id === nextModel);
    if (option && !option.reasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(option.reasoningEfforts[0] ?? "");
    }
  }

  async function savePrompts() {
    if (!plan || busy) return;
    const prompts = plan.mode === "time"
      ? [successPrompt]
      : [successPrompt, failurePrompt, timeoutPrompt];
    if (prompts.some((prompt) => !prompt.trim() || prompt.trim().length > 20_000)) {
      setError("续跑提示词不能为空，且每段不能超过 20,000 个字符。");
      return;
    }
    setBusy("save");
    setError("");
    try {
      const result = await api.updateWakePrompts(conversation.id, plan.id, {
        revision: plan.revision,
        successPrompt: successPrompt.trim(),
        failurePrompt: plan.mode === "event_or_deadline" ? failurePrompt.trim() : undefined,
        timeoutPrompt: plan.mode === "event_or_deadline" ? timeoutPrompt.trim() : undefined,
        model,
        reasoningEffort,
      });
      setPlan(result.wakePlan);
      setSuccessPrompt(result.wakePlan.success_prompt);
      setFailurePrompt(result.wakePlan.failure_prompt);
      setTimeoutPrompt(result.wakePlan.timeout_prompt);
      setModel(result.wakePlan.agent_model);
      setReasoningEffort(result.wakePlan.reasoning_effort);
      await onChanged();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "续跑提示词保存失败";
      setError(message);
      if (/其他页面|已经触发|触发或取消/.test(message)) {
        try {
          const latest = await api.activeWake(conversation.id);
          applyPlan(latest.wakePlan);
        } catch { /* Keep the actionable save error visible. */ }
      }
    } finally {
      setBusy("");
    }
  }

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section className="project-dialog wake-plan-details-dialog" role="dialog" aria-modal="true" aria-labelledby="wake-plan-details-title">
      <header><div><h2 id="wake-plan-details-title">已安排的任务</h2><p>“{conversation.title}”当前的持久等待与自动续跑详情。</p></div><button type="button" onClick={requestClose} disabled={Boolean(busy)} aria-label="关闭等待详情"><X size={18} /></button></header>
      <div className="project-dialog-body wake-plan-details-body">
        {loading && <div className="wake-plan-details-state"><LoaderCircle className="spin" size={18} />正在读取等待详情…</div>}
        {!loading && !plan && !error && <div className="wake-plan-details-state"><Clock size={18} />这项等待刚刚已触发或取消。</div>}
        {plan && <article className="wake-plan-details-card">
          <div className="wake-plan-details-heading"><span><Clock size={18} /></span><div><strong>{plan.label}</strong><small>{wakePlanTypeTitle(plan.mode)}</small></div></div>
          <p>{wakePlanTypeDescription(plan)}</p>
          <dl>
            <div><dt>等待条件</dt><dd>{plan.mode === "event_or_deadline" ? "外部事件完成，或到达底线时间" : "到达安排的时间"}</dd></div>
            <div><dt>{plan.mode === "event_or_deadline" ? "底线时间" : "唤醒时间"}</dt><dd><div className="wake-plan-deadline-editor"><input type="datetime-local" step="1" aria-label={plan.mode === "event_or_deadline" ? "编辑底线时间" : "编辑唤醒时间"} value={deadlineInput} disabled={Boolean(busy)} onChange={(event) => setDeadlineInput(event.target.value)} /><button type="button" className="wake-plan-inline-save" disabled={Boolean(busy) || !deadlineDirty} onClick={() => void saveDeadline()}>{busy === "reschedule" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}保存时间</button></div><small className="wake-plan-deadline-hint">早于当前时间时，保存后立即继续。</small></dd></div>
            <div><dt>续跑位置</dt><dd>{plan.new_conversation ? "当前新对话（安排时已创建）" : "继续当前对话"}</dd></div>
            <div><dt>续跑模型</dt><dd>{editingPrompts ? <SettingMenu menuId="wake-plan-model-menu" className="model wake-plan-setting" label="模型" value={model} options={agentOptions?.models.map((option) => ({ id: option.id, label: option.label, description: option.description })) ?? []} placeholder="加载中" title="选择续跑模型" disabled={!agentOptions || Boolean(busy)} open={openSettingMenu === "model"} onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onOpenChange={(open) => setOpenSettingMenu(open ? "model" : openSettingMenu === "model" ? null : openSettingMenu)} onChange={changeModel} /> : plan.agent_model}</dd></div>
            <div><dt>思考深度</dt><dd>{editingPrompts ? <SettingMenu menuId="wake-plan-effort-menu" className="effort wake-plan-setting" label="思考" value={reasoningEffort} options={agentOptions?.reasoningEfforts.filter((effort) => agentOptions.models.find((option) => option.id === model)?.reasoningEfforts.includes(effort.id)).map((effort) => ({ id: effort.id, label: effort.label })) ?? []} placeholder="加载中" title="选择续跑思考深度" disabled={!agentOptions || Boolean(busy)} open={openSettingMenu === "effort"} onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onOpenChange={(open) => setOpenSettingMenu(open ? "effort" : openSettingMenu === "effort" ? null : openSettingMenu)} onChange={(value) => setReasoningEffort(value as ReasoningEffort)} /> : plan.reasoning_effort}</dd></div>
            <div><dt>安排时间</dt><dd><time dateTime={plan.created_at}>{formatFullDateTime(plan.created_at)}</time></dd></div>
            {plan.last_heartbeat_at && <div><dt>最近心跳</dt><dd><time dateTime={plan.last_heartbeat_at}>{formatFullDateTime(plan.last_heartbeat_at)}</time></dd></div>}
          </dl>
          {plan.last_event_summary && <div className="wake-plan-last-event"><strong>最近状态</strong><span>{plan.last_event_summary}</span></div>}
          <section className="wake-plan-prompts" aria-label="续跑提示词">
            <header><div><strong>续跑提示词</strong><span>{plan.mode === "event_or_deadline" ? "按完成、失败或超时原因选择对应指令" : "到达唤醒时间后交给 Codex 的指令"}</span></div>{!editingPrompts && <button type="button" disabled={Boolean(busy)} onClick={() => { setEditingPrompts(true); setError(""); }}><Pencil size={13} />编辑</button>}</header>
            {editingPrompts ? <div className="wake-plan-prompt-editor">
              <label><span>{plan.mode === "event_or_deadline" ? "成功提示词" : "续跑提示词"}</span><textarea rows={7} maxLength={20_000} value={successPrompt} onChange={(event) => setSuccessPrompt(event.target.value)} /><small>{successPrompt.length.toLocaleString()} / 20,000</small></label>
              {plan.mode === "event_or_deadline" && <>
                <label><span>失败提示词</span><textarea rows={7} maxLength={20_000} value={failurePrompt} onChange={(event) => setFailurePrompt(event.target.value)} /><small>{failurePrompt.length.toLocaleString()} / 20,000</small></label>
                <label><span>超时提示词</span><textarea rows={7} maxLength={20_000} value={timeoutPrompt} onChange={(event) => setTimeoutPrompt(event.target.value)} /><small>{timeoutPrompt.length.toLocaleString()} / 20,000</small></label>
              </>}
              <div className="wake-plan-prompt-actions"><button type="button" disabled={Boolean(busy)} onClick={cancelPromptEdit}>取消编辑</button><button type="button" className="primary-button" disabled={Boolean(busy) || !promptDirty} onClick={() => void savePrompts()}>{busy === "save" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存提示词</button></div>
            </div> : <div className="wake-plan-prompt-view">
              <div><strong>{plan.mode === "event_or_deadline" ? "成功" : "续跑"}</strong><pre>{plan.success_prompt}</pre></div>
              {plan.mode === "event_or_deadline" && <><div><strong>失败</strong><pre>{plan.failure_prompt}</pre></div><div><strong>超时</strong><pre>{plan.timeout_prompt}</pre></div></>}
            </div>}
          </section>
        </article>}
        {error && <div className="project-dialog-error">{error}</div>}
      </div>
      <footer><span />{plan ? <div className="wake-plan-details-actions"><button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void run("cancel")}>{busy === "cancel" ? <LoaderCircle className="spin" size={14} /> : null}取消等待</button><button type="button" disabled={Boolean(busy)} onClick={() => void run("postpone")}>{busy === "postpone" ? <LoaderCircle className="spin" size={14} /> : null}推迟 30 分钟</button><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void run("trigger")}>{busy === "trigger" ? <LoaderCircle className="spin" size={14} /> : null}立即继续</button></div> : <div><button type="button" onClick={onClose}>关闭</button></div>}</footer>
    </section>
  </div>;
}

function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  type RuntimeAction = "refresh" | "upgrade" | "worker";
  type RuntimeBusy = { action: RuntimeAction; executorId: string; requestId: number } | null;
  const [executors, setExecutors] = useState<Executor[]>([]);
  const [executorId, setExecutorId] = useState("");
  const [page, setPage] = useState<ProjectDirectoryPage | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(true);
  const [runtimeBusy, setRuntimeBusy] = useState<RuntimeBusy>(null);
  const [workerBootstrap, setWorkerBootstrap] = useState<RemoteWorkerBootstrap | null>(null);
  const [error, setError] = useState("");
  const nameTouchedRef = useRef(false);
  const runtimeRequestRef = useRef(0);
  const selectedExecutor = executors.find((executor) => executor.id === executorId) ?? null;
  const tenantLocal = selectedExecutor?.kind === "tenant_container";
  const selectedProjectDirectory = Boolean(page && (tenantLocal || page.parent));
  const selectedWorker = selectedExecutor?.worker ?? null;
  const workerUpdateState = selectedWorker?.update?.state ?? null;
  const workerUpdateActive = workerUpdateState === "queued" || workerUpdateState === "dispatching" || workerUpdateState === "updating";
  const workerCurrent = Boolean(selectedWorker && selectedWorker.installedVersion === selectedWorker.targetVersion && selectedWorker.installedRef === selectedWorker.targetRef);
  const selectedRuntimeBusy = runtimeBusy?.executorId === executorId ? runtimeBusy : null;

  const browse = useCallback(async (selectedExecutorId: string, directory = "", tenantRoot = false) => {
    if (!selectedExecutorId) return;
    setBusy(true); setError("");
    try {
      const result = await api.projectDirectories(selectedExecutorId, directory);
      setPage(result); setPathInput(result.directory);
      if (!nameTouchedRef.current) {
        if (tenantRoot && !result.parent) setName("");
        else {
          const parts = result.directory.replace(/\\/g, "/").split("/").filter(Boolean);
          setName(parts.at(-1)?.replace(/:$/, "") ?? "新项目");
        }
      }
    } catch (reason) { setPage(null); setError(reason instanceof Error ? reason.message : "文件夹读取失败"); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    api.executors().then(({ executors: available }) => {
      setExecutors(available);
      const initial = available.find((executor) => executor.status === "online") ?? available[0];
      if (!initial) { setError("当前没有可用机器"); setBusy(false); return; }
      setExecutorId(initial.id);
      if (initial.status === "online") void browse(initial.id, "", initial.kind === "tenant_container");
      else { setError(`${initial.machineName} 当前离线`); setBusy(false); }
    }).catch((reason) => { setError(reason instanceof Error ? reason.message : "机器列表读取失败"); setBusy(false); });
  }, [browse]);
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  useEffect(() => {
    if (!workerUpdateActive) return;
    const timer = window.setInterval(() => {
      void api.executors().then(({ executors: available }) => setExecutors(available)).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [workerUpdateActive]);
  function chooseExecutor(nextExecutorId: string) {
    if (nextExecutorId === NEW_REMOTE_WORKER_OPTION) {
      setPage(null); setPathInput(""); setError(""); setBusy(true); setRuntimeBusy(null);
      void api.createRemoteWorkerBootstrap().then((result) => setWorkerBootstrap(result)).catch((reason) => setError(reason instanceof Error ? reason.message : "Worker 安装包生成失败")).finally(() => setBusy(false));
      return;
    }
    const executor = executors.find((item) => item.id === nextExecutorId);
    setExecutorId(nextExecutorId); setPage(null); setPathInput(""); setError(""); setRuntimeBusy(null);
    void api.executors().then(({ executors: available }) => setExecutors(available)).catch(() => undefined);
    if (!executor) return;
    if (executor.status === "offline") { setBusy(false); setError(`${executor.machineName} 当前离线，连接恢复后即可浏览目录和创建项目。`); return; }
    void browse(nextExecutorId, "", executor.kind === "tenant_container");
  }

  async function createFolder() {
    if (!page || !executorId) return;
    const folderName = window.prompt("新文件夹名称")?.trim();
    if (!folderName) return;
    setBusy(true); setError("");
    try {
      const result = await api.createProjectDirectory(executorId, page.directory, folderName);
      setPage(result); setPathInput(result.directory); setName(folderName); nameTouchedRef.current = true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "文件夹创建失败"); }
    finally { setBusy(false); }
  }

  async function refreshRuntime() {
    const actionExecutorId = executorId;
    if (!actionExecutorId || selectedRuntimeBusy) return;
    const requestId = ++runtimeRequestRef.current;
    setRuntimeBusy({ action: "refresh", executorId: actionExecutorId, requestId }); setError("");
    try {
      const { runtime } = await api.refreshExecutorRuntime(actionExecutorId);
      setExecutors((current) => current.map((executor) => executor.id === actionExecutorId ? { ...executor, runtime } : executor));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Codex 信息刷新失败"); }
    finally { setRuntimeBusy((current) => current?.requestId === requestId ? null : current); }
  }

  async function upgradeCodex() {
    const actionExecutorId = executorId;
    if (!actionExecutorId || selectedRuntimeBusy) return;
    const requestId = ++runtimeRequestRef.current;
    setRuntimeBusy({ action: "upgrade", executorId: actionExecutorId, requestId }); setError("");
    try {
      const result = await api.upgradeExecutorCodex(actionExecutorId);
      setExecutors((current) => current.map((executor) => executor.id === actionExecutorId ? { ...executor, runtime: result.runtime } : executor));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Codex 升级失败"); }
    finally { setRuntimeBusy((current) => current?.requestId === requestId ? null : current); }
  }

  async function upgradeWorker() {
    const actionExecutorId = executorId;
    if (!actionExecutorId || selectedRuntimeBusy) return;
    const requestId = ++runtimeRequestRef.current;
    setRuntimeBusy({ action: "worker", executorId: actionExecutorId, requestId }); setError("");
    try {
      const result = await api.upgradeRemoteWorker(actionExecutorId);
      setExecutors((current) => current.map((executor) => executor.id === actionExecutorId ? result.executor : executor));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Worker 升级请求失败"); }
    finally { setRuntimeBusy((current) => current?.requestId === requestId ? null : current); }
  }

  async function createProject() {
    if (!page || !name.trim() || !executorId || busy) return;
    setBusy(true); setError("");
    try {
      let directory = page.directory;
      if (tenantLocal && !page.parent) {
        const existing = page.directories.find((candidate) => candidate.name === name.trim());
        directory = existing?.path ?? (await api.createProjectDirectory(executorId, page.directory, name.trim())).directory;
      }
      onCreated((await api.createProject(name.trim(), directory, executorId)).project);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "项目创建失败"); setBusy(false); }
  }

  if (workerBootstrap) return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-dialog worker-onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="worker-onboarding-title">
      <header><div><h2 id="worker-onboarding-title">新建远程 Worker</h2><p>下载对应系统的安装器，把这台电脑接入 Codex Web。</p></div><button type="button" onClick={onClose} aria-label="关闭 Worker 安装向导"><X size={18} /></button></header>
      <div className="project-dialog-body worker-onboarding-body">
        <div className="worker-onboarding-intro"><Monitor size={22} /><div><strong>安装后会自动完成连接配置</strong><span>安装器会准备 Node.js、安装或更新 Codex，并设置登录后自动启动。运行时只需输入这台电脑的显示名称。</span></div></div>
        <div className="worker-download-list">
          {workerBootstrap.platforms.map((platform) => <a key={platform.platform} className="worker-download-card" href={platform.url} download>
            <Download size={19} /><span><strong>下载 {platform.label} 安装器</strong><small>{platform.label === "Windows" ? "下载后右键选择“使用 PowerShell 运行”" : "下载后在终端运行 bash 安装器"}</small></span>
          </a>)}
        </div>
        <ol className="worker-onboarding-steps"><li>下载与你电脑匹配的安装器</li><li>运行安装器并输入机器名称</li><li>等待 Codex 和 Worker 配置完成，回到这里刷新节点</li></ol>
        {workerBootstrap.version && <small className="worker-onboarding-version">Worker 目标版本 {workerBootstrap.version}</small>}
        <div className="worker-onboarding-note">安装链接约 30 分钟有效，只能使用一次；不要转发给其他人。Worker 只发起到 Codex Web 的出站连接，不开放本机端口。</div>
      </div>
      <footer><button type="button" onClick={() => setWorkerBootstrap(null)}>返回机器选择</button><div><button type="button" onClick={onClose}>关闭</button></div></footer>
    </section>
  </div>;

  return <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <header><div><h2 id="project-dialog-title">创建项目</h2>{selectedExecutor && <p>{tenantLocal ? "输入项目名称即可创建。" : "选择执行机器和该机器上的文件夹。项目任务会由所选机器上的本地任务引擎执行。"}</p>}</div><button type="button" onClick={onClose} aria-label="关闭创建项目"><X size={18} /></button></header>
      <div className="project-dialog-body">
        {!tenantLocal && <label className="executor-field">执行机器
          <select value={executorId} disabled={busy && executors.length === 0} onChange={(event) => chooseExecutor(event.target.value)}>
            {executors.map((executor) => <option key={executor.id} value={executor.id}>{executor.machineName} · {executor.status === "online" ? "在线" : "离线"}</option>)}
            <option value={NEW_REMOTE_WORKER_OPTION}>＋新建远程 Worker</option>
          </select>
        </label>}
        {selectedExecutor && !tenantLocal && <div className="executor-runtime-card">
          <div><strong>当前版本 {selectedExecutor.runtime?.installedVersion ?? "待检测"}</strong><small>{selectedExecutor.runtime?.latestVersion ? `最新版本 ${selectedExecutor.runtime.latestVersion}` : "最新版本待检测"}</small></div>
          <div>
            <button type="button" disabled={selectedExecutor.status !== "online" || Boolean(selectedRuntimeBusy) || selectedExecutor.runtime?.updateState === "updating"} onClick={() => void refreshRuntime()}>{selectedRuntimeBusy?.action === "refresh" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}检查更新</button>
            <button type="button" disabled={selectedExecutor.status !== "online" || Boolean(selectedRuntimeBusy) || selectedExecutor.runtime?.updateState === "updating" || selectedExecutor.activeJobs > 0 || !selectedExecutor.runtime?.latestVersion || selectedExecutor.runtime.installedVersion === selectedExecutor.runtime.latestVersion} onClick={() => void upgradeCodex()}>{selectedRuntimeBusy?.action === "upgrade" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}升级 Codex</button>
          </div>
          {selectedExecutor.runtime?.updateError && <small className="runtime-error">{selectedExecutor.runtime.updateError}</small>}
        </div>}
        {selectedExecutor?.kind === "remote_worker" && selectedWorker && <div className="executor-runtime-card">
          <div><strong>当前版本 {selectedWorker.installedVersion}</strong><small>最新版本 {selectedWorker.targetVersion} · {
            !selectedWorker.updaterCapable ? "需最后一次手动引导，之后可由服务器更新"
            : workerUpdateState === "queued" ? "升级已排队，等待节点空闲"
            : workerUpdateState === "dispatching" ? "正在下发升级请求"
            : workerUpdateState === "updating" ? "节点正在拉取、测试并准备重启"
            : workerUpdateState === "succeeded" ? "已升级至最新版本"
            : workerUpdateState === "failed" ? "上次升级失败，节点已回滚"
            : workerCurrent ? "已是最新版本" : "可升级到最新版本"
          }</small><small>{formatRemoteWorkerCapacity(selectedExecutor.capacity)} · 当前运行 {selectedExecutor.activeJobs} · 以 Worker 本机配置为准</small></div>
          <div className="worker-card-actions"><button type="button" disabled={!selectedWorker.updaterCapable || workerCurrent || workerUpdateActive || Boolean(selectedRuntimeBusy)} onClick={() => void upgradeWorker()}>{selectedRuntimeBusy?.action === "worker" || workerUpdateActive ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}升级 Worker</button></div>
          {selectedWorker.update?.error && <small className="runtime-error">{selectedWorker.update.error}</small>}
        </div>}
        <label className="project-name-field">项目名称
          <input autoFocus value={name} maxLength={80} onChange={(event) => { nameTouchedRef.current = true; setName(event.target.value); }} placeholder="例如：网站维护" />
          {selectedExecutor && name.trim() && <small>侧栏显示为 {projectDisplayName(name.trim(), selectedExecutor.machineName, selectedExecutor.kind)}</small>}
        </label>
        {selectedExecutor && !tenantLocal && <>
          <div className="directory-toolbar">
            <button type="button" disabled={!page?.parent || busy} onClick={() => page?.parent && void browse(executorId, page.parent)} aria-label="返回上级文件夹" title="返回上级"><CornerUpLeft size={16} /></button>
            <input aria-label="机器文件夹路径" value={pathInput} placeholder="此电脑" disabled={selectedExecutor.status !== "online"} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void browse(executorId, pathInput); }} />
            <button type="button" disabled={busy || selectedExecutor.status !== "online"} onClick={() => void browse(executorId, pathInput)}>打开</button>
          </div>
          <div className="directory-list" aria-busy={busy}>
            {busy && !page ? <div className="directory-state"><LoaderCircle className="spin" size={18} />正在读取机器文件夹…</div> : page?.directories.map((directory) => <button type="button" key={directory.path} onClick={() => void browse(executorId, directory.path)}><FolderOpen size={17} /><span>{directory.name}</span></button>)}
            {!busy && page?.directories.length === 0 && <div className="directory-state">此文件夹没有子文件夹</div>}
            {!busy && !page && !error && <div className="directory-state">请选择在线机器</div>}
          </div>
        </>}
        {error && <div className="project-dialog-error">{error}</div>}
      </div>
      <footer>{selectedExecutor && !tenantLocal ? <button type="button" className="create-folder-button" disabled={!page || busy || selectedExecutor.status !== "online"} onClick={() => void createFolder()}><FolderOpen size={15} />新建文件夹</button> : <span />}<div><button type="button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={!selectedProjectDirectory || !name.trim() || busy || selectedExecutor?.status !== "online"} onClick={() => void createProject()}>{busy ? <LoaderCircle className="spin" size={16} /> : "创建项目"}</button></div></footer>
    </section>
  </div>;
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

function AssistantMarkdown({ content, files, citationFiles, messageId, remoteFileFetchEnabled, onFetchRemoteFile }: {
  content: string;
  files: WorkFile[];
  citationFiles: WorkFile[];
  messageId: string;
  remoteFileFetchEnabled: boolean;
  onFetchRemoteFile: (messageId: string, sourcePath: string) => Promise<WorkFile>;
}) {
  const sanitized = useMemo(() => sanitizeAgentMarkdown(content, citationFiles), [citationFiles, content]);
  const math = useAsyncMarkdownMath(sanitized);
  return <div className="markdown" data-agent-selectable="true" aria-busy={math.loading || undefined}><ReactMarkdown
    remarkPlugins={math.plugins ? [remarkGfm, math.plugins.remarkMath] : [remarkGfm]}
    rehypePlugins={math.plugins ? [[math.plugins.rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]] : []}
    urlTransform={(url) => isLocalMarkdownUrl(url) ? url : defaultUrlTransform(url)}
    components={{ a: ({ href, children }) => {
      const resolved = resolveMessageFileLink(href, files, remoteFileFetchEnabled);
      if (resolved.kind === "preview") return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
      if (resolved.kind === "raw") return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
      if (resolved.kind === "download") return <a href={resolved.href} download>{children}</a>;
      if (resolved.kind === "unavailable" && remoteFileFetchEnabled && resolved.path) return <RemoteFileInlineLink sourcePath={resolved.path} onFetch={() => onFetchRemoteFile(messageId, resolved.path!)}>{children}</RemoteFileInlineLink>;
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

function isErrorNoticeMessage(message: { role: string; content: string }): boolean {
  return message.role === "system"
    || (message.role === "assistant" && /(?:本轮已经开始执行，但随后连接中断|服务重启而中断)/.test(message.content));
}

function ErrorBubble({ content }: { content: string }) {
  return <div className="error-bubble" role="alert">
    <CircleAlert size={17} aria-hidden="true" />
    <div><strong>任务未完成</strong><p data-agent-selectable="true">{content}</p></div>
  </div>;
}

function Chat({ detail, activities, activitiesLoading, sending, loadingOlderMessages, messagesRef, onMessagesScroll, onAskAgent, onFetchRemoteFile, remoteFileFetchEnabled, userInitials, chatFontSize, onCancelWake, onPostponeWake, onTriggerWake, onEditWake }: { detail: ConversationDetail; activities: JobEvent[]; activitiesLoading: boolean; sending: boolean; loadingOlderMessages: boolean; messagesRef: React.RefObject<HTMLDivElement | null>; onMessagesScroll: (event: React.UIEvent<HTMLDivElement>) => void; onAskAgent: (selectedText: string) => void; onFetchRemoteFile: (messageId: string, sourcePath: string) => Promise<WorkFile>; remoteFileFetchEnabled: boolean; userInitials: string; chatFontSize: number; onCancelWake: (plan: WakePlan) => Promise<void>; onPostponeWake: (plan: WakePlan) => Promise<void>; onTriggerWake: (plan: WakePlan) => Promise<void>; onEditWake: () => void }) {
  const citationFiles = detail.messages.flatMap((message) => message.files);
  const latestJobError = detail.latestJob && ["failed", "interrupted"].includes(detail.latestJob.status)
    ? detail.latestJob.error?.trim() ?? ""
    : "";
  const hasPersistedErrorNotice = Boolean(latestJobError && detail.messages.some((message) => {
    if (!isErrorNoticeMessage(message)) return false;
    return message.content === latestJobError
      || message.content.includes(latestJobError)
      || latestJobError.includes(message.content);
  }));
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
        const horizontalInset = Math.min(56, (viewport.right - viewport.left) / 2);
        const left = Math.min(viewport.right - horizontalInset, Math.max(viewport.left + horizontalInset, rect.left + (rect.right - rect.left) / 2));
        const below = viewport.bottom - rect.bottom >= 54;
        const top = below
          ? Math.min(rect.bottom + 8, viewport.bottom - 44)
          : Math.max(rect.top - 8, viewport.top + 44);
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
  }, [detail.conversation.id, messagesRef]);

  function useSelectedText() {
    if (!askSelection) return;
    onAskAgent(askSelection.text);
    setAskSelection(null);
  }

  return <section ref={chatRef} className="chat"><ConversationMessageList
      messages={detail.messages}
      variant="main"
      containerRef={messagesRef}
      className="messages"
      onScroll={onMessagesScroll}
      style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}
      beforeMessages={detail.messagePage.hasMore ? <div className="history-loader" aria-live="polite">{loadingOlderMessages ? <><LoaderCircle className="spin" size={14} /><span>正在加载更早消息…</span></> : <span>向上滚动加载更早消息</span>}</div> : null}
      messageProps={(message) => {
        const errorNotice = isErrorNoticeMessage(message);
        const scheduledMessage = message.role === "user" && Boolean(message.is_scheduled);
        const remoteFiles = message.role === "assistant" && remoteFileFetchEnabled
          ? remoteMessageFileReferences(message.content, message.files, true)
          : [];
        return {
          className: errorNotice ? "error" : undefined,
          avatarClassName: scheduledMessage ? "scheduled" : undefined,
          avatar: errorNotice ? <CircleAlert size={16} /> : scheduledMessage ? <Clock size={15} /> : message.role === "assistant" ? <Zap size={15} /> : userInitials,
          name: errorNotice ? "任务错误" : scheduledMessage ? "定时任务" : message.role === "assistant" ? "Codex Web" : "你",
          timeLabel: formatMessageDateTime(message.created_at),
          timeTitle: formatFullDateTime(message.created_at),
          hideQuote: errorNotice,
          beforeContent: !errorNotice && message.role !== "assistant" && message.attachment_references.length > 0 ? <div className="message-reference" title={message.attachment_references.join("、")}><Paperclip size={14} /><span><strong>引用</strong>{message.attachment_references.join("、")}</span></div> : null,
          renderAssistant: () => errorNotice ? <ErrorBubble content={message.content} /> : <><AssistantMarkdown content={message.content} files={message.files} citationFiles={citationFiles} messageId={message.id} remoteFileFetchEnabled={remoteFileFetchEnabled} onFetchRemoteFile={onFetchRemoteFile} />{message.content && <AssistantCopyButton content={message.content} />}</>,
          renderUser: () => errorNotice ? <ErrorBubble content={message.content} /> : <p data-agent-selectable="true">{message.content}</p>,
          afterContent: !errorNotice && (message.files.length > 0 || remoteFiles.length > 0) ? <div className="file-grid">
            {message.files.map((file) => <FileCard key={file.id} file={file} />)}
            {remoteFiles.map((file) => <RemoteFileCard key={file.sourcePath} sourcePath={file.sourcePath} onFetch={() => onFetchRemoteFile(message.id, file.sourcePath)} />)}
          </div> : null,
        };
      }}
      afterMessages={<>
        {latestJobError && !hasPersistedErrorNotice && <article className="message system error" data-message-id={`job-error-${detail.latestJob?.id}`}>
          <div className="message-avatar"><CircleAlert size={16} /></div>
          <div className="message-body"><div className="message-meta"><span className="message-name">任务错误</span>{detail.latestJob?.updated_at && <time dateTime={detail.latestJob.updated_at} title={formatFullDateTime(detail.latestJob.updated_at)}>{formatMessageDateTime(detail.latestJob.updated_at)}</time>}</div><ErrorBubble content={latestJobError} /></div>
        </article>}
        {sending && <article className="message assistant running"><div className="message-avatar"><Zap size={15} /></div><div className="message-body"><div className="message-meta"><span className="message-name">Codex Web</span><span className="live-label">实时进度</span></div><ProcessPanel key={`${detail.conversation.id}:${detail.remoteTurnId ?? "job"}`} activities={activities} loading={activitiesLoading} /></div></article>}
        {detail.wakePlan && <WakePlanCard plan={detail.wakePlan} onCancel={onCancelWake} onPostpone={onPostponeWake} onTrigger={onTriggerWake} onEdit={onEditWake} />}
        <div />
      </>}
    />{askSelection && <button type="button" className={`ask-agent-selection ${askSelection.below ? "below" : "above"}`} style={{ left: askSelection.left, top: askSelection.top }} onPointerDown={(event) => { event.preventDefault(); useSelectedText(); }} onClick={(event) => { if (event.detail === 0) useSelectedText(); }}><Zap size={14} /><span>询问 Agent</span></button>}
  </section>;
}

function WakePlanCard({ plan, onCancel, onPostpone, onTrigger, onEdit }: { plan: WakePlan; onCancel: (plan: WakePlan) => Promise<void>; onPostpone: (plan: WakePlan) => Promise<void>; onTrigger: (plan: WakePlan) => Promise<void>; onEdit: () => void }) {
  const [busy, setBusy] = useState<"cancel" | "postpone" | "trigger" | "">("");
  const eventMode = plan.mode === "event_or_deadline";
  const run = async (kind: "cancel" | "postpone" | "trigger", action: (plan: WakePlan) => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try { await action(plan); } finally { setBusy(""); }
  };
  return <article className="wake-plan-card" role="status">
    <div className="wake-plan-icon"><Clock size={18} /></div>
    <div className="wake-plan-copy"><strong>{plan.label}</strong><span>{eventMode ? "等待外部事件；若未收到，截止时自动检查" : "等待时间到达后自动继续"}</span><time dateTime={plan.deadline_at}>最晚 {formatFullDateTime(plan.deadline_at)}</time>{eventMode && plan.last_heartbeat_at && <small>最近心跳：{formatFullDateTime(plan.last_heartbeat_at)}</small>}{plan.last_event_summary && <small>{plan.last_event_summary}</small>}</div>
    <div className="wake-plan-actions"><button type="button" disabled={Boolean(busy)} onClick={onEdit}><Pencil size={13} />编辑</button><button type="button" disabled={Boolean(busy)} onClick={() => void run("postpone", onPostpone)}>{busy === "postpone" ? <LoaderCircle className="spin" size={13} /> : null}推迟 30 分钟</button><button type="button" disabled={Boolean(busy)} onClick={() => void run("trigger", onTrigger)}>立即继续</button><button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void run("cancel", onCancel)}>取消等待</button></div>
  </article>;
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
    <div className="activity-title"><LoaderCircle className="spin" size={17} /><strong>{queued ? "正在排队" : retrying ? "正在自动重试" : "正在处理"}</strong><span>{queued ? (queueStatus?.label || (queueStatus?.jobsAhead ? `前面还有 ${queueStatus.jobsAhead} 个任务，完成后自动开始` : "即将自动开始")) : retrying ? latestStatus.label : "完成前持续保留，可随时引导"}</span></div>
    {plan?.items && <div className="process-plan"><div className="process-section-title"><strong>执行计划</strong><span>{completedPlanItems}/{plan.items.length}</span></div><ul>
      {plan.items.map((item, index) => <li className={item.completed ? "completed" : index === completedPlanItems ? "current" : ""} key={`${item.text}-${index}`}><span>{item.completed ? <Check size={12} /> : index === completedPlanItems ? <LoaderCircle className="spin" size={12} /> : index + 1}</span><p>{item.text}</p></li>)}
    </ul></div>}
    {subagents.agents.length > 0 && <SubagentPanel summary={subagents} />}
    <div className="process-section-title"><strong>工作记录</strong><span>{journal.length ? `${journal.length} 条 · 阶段反馈保留上限 5 条` : "实时更新"}</span></div>
    <div className="process-journal">{journal.length ? journal.map((activity, index) => isNarrativeActivity(activity)
      ? <ProcessJournalNote activity={activity} key={activity.seq ?? `${activity.kind}-${index}`} />
      : <div className="activity-line" key={activity.seq ?? `${activity.label}-${index}`}>
          {activity.kind === "error" ? <CircleAlert size={14} /> : activity.kind === "retry" ? <Clock size={14} /> : activity.label?.startsWith("正在") ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          <div><span>{activity.label}</span>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}
            {activity.kind === "file" && activity.files?.length ? <small>{activity.files.map((file) => file.split(/[\\/]/).at(-1)).join("、")}</small> : null}
            {["search", "tool", "error", "retry"].includes(activity.kind ?? "") && activity.detail ? <small>{activity.detail}</small> : null}
            {activity.kind === "command" && activity.detail ? <details className="technical-detail"><summary>{activity.actionCount && activity.actionCount > 1 ? `查看 ${activity.actionCount} 个技术步骤` : "查看技术细节"}</summary><code>{activity.groupedDetails?.join("\n\n") || activity.detail}</code></details> : null}
          </div>
        </div>) : <p className="process-journal-empty">正在建立执行方向…</p>}</div>
  </div>;
}

function SubagentPanel({ summary }: { summary: SubagentActivitySummary }) {
  const counts = [
    `${summary.agents.length} 个`,
    summary.active.length ? `${summary.active.length} 运行` : "",
    summary.completedCount ? `${summary.completedCount} 完成` : "",
    summary.failedCount ? `${summary.failedCount} 异常` : "",
  ].filter(Boolean).join(" · ");
  return <details className="subagent-panel">
    <summary><span className="subagent-summary-icon"><Bot size={13} /></span><strong>协作 Agent</strong><span>{counts}</span><ChevronDown size={13} /></summary>
    <div className="subagent-groups">
      {summary.active.length > 0 && <SubagentGroup label="Active" agents={summary.active} />}
      {summary.done.length > 0 && <SubagentGroup label="Done" agents={summary.done} />}
    </div>
  </details>;
}

function SubagentGroup({ label, agents }: { label: "Active" | "Done"; agents: SubagentView[] }) {
  return <section className="subagent-group"><header><strong>{label}</strong><span>{agents.length}</span></header><ul>
    {agents.map((agent) => <li className={`subagent-row ${agent.status}`} key={agent.id}>
      <span className="subagent-state-icon">{agent.status === "pending" || agent.status === "running"
        ? <LoaderCircle className="spin" size={13} />
        : agent.status === "completed" ? <Check size={13} /> : <X size={13} />}</span>
      <div><div className="subagent-row-title"><strong title={agent.path || agent.id}>{agent.name}</strong><span>{subagentStatusLabel(agent.status)}</span>{agent.updatedAt && <time dateTime={agent.updatedAt}>{formatActivityTime(agent.updatedAt)}</time>}</div>
        {agent.summary && <p>{agent.summary}</p>}
      </div>
    </li>)}
  </ul></section>;
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

function formatWakeMenuTime(value: string | null): string {
  if (!value) return "时间读取中";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

function wakePlanTypeTitle(mode: WakePlan["mode"]): string {
  return mode === "event_or_deadline" ? "等待事件或底线时间" : "仅等待时间";
}

function wakePlanTypeDescription(plan: WakePlan): string {
  return plan.mode === "event_or_deadline"
    ? `外部事件先完成时会立即续跑；如果一直没有收到事件，最晚在 ${formatFullDateTime(plan.deadline_at)} 自动唤醒 Codex 检查。`
    : `不等待外部事件；到 ${formatFullDateTime(plan.deadline_at)} 后自动把续跑指令放回本会话队列。`;
}

function wakeMenuDescription(conversation: Conversation): string {
  const deadline = formatWakeMenuTime(conversation.next_wake_at);
  if (conversation.active_wake_mode === "event_or_deadline") return `等待事件，最晚 ${deadline}`;
  if (conversation.active_wake_mode === "time") return `仅等待时间 · ${deadline}`;
  return `等待详情 · ${deadline}`;
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}

function triggerFileDownload(file: WorkFile) {
  const link = document.createElement("a");
  link.href = fileUrl(file, true);
  link.download = file.original_name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

function openFetchedFile(file: WorkFile) {
  const reader = fileReaderKind(file);
  const target = reader === "html" ? filePreviewUrl(file) : reader === "markdown" || isBrowserPreviewable(file) ? fileUrl(file) : "";
  if (target) window.location.assign(target);
  else triggerFileDownload(file);
}

function RemoteFileInlineLink({ sourcePath, onFetch, children }: { sourcePath: string; onFetch: () => Promise<WorkFile>; children: ReactNode }) {
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  async function fetchFile() {
    if (loading) return;
    setLoading(true);
    setFailure("");
    try { openFetchedFile(await onFetch()); }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : "文件获取失败"); }
    finally { setLoading(false); }
  }
  return <button type="button" className={`remote-inline-file-link ${failure ? "failed" : ""}`} disabled={loading} title={failure || sourcePath} onClick={() => void fetchFile()}>{children}</button>;
}

function RemoteFileCard({ sourcePath, onFetch }: { sourcePath: string; onFetch: () => Promise<WorkFile> }) {
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  const fileName = sourcePath.split(/[\\/]/).at(-1) || "远程文件";
  async function fetchFile(download: boolean) {
    if (loading) return;
    setLoading(true);
    setFailure("");
    try {
      const file = await onFetch();
      if (download) triggerFileDownload(file);
      else openFetchedFile(file);
    }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : "文件获取失败"); }
    finally { setLoading(false); }
  }
  const body = <><FileIcon size={20} /><span><strong>{fileName}</strong><small>{failure || (loading ? "正在从远程电脑获取…" : "远程文件 · 点击打开")}</small></span></>;
  return <div className={`file-card remote-file-card ${failure ? "failed" : ""}`} title={sourcePath}>
    <button type="button" className="remote-file-card-main" disabled={loading} onClick={() => void fetchFile(false)}>{body}</button>
    <button type="button" className="download-button" disabled={loading} title="下载" aria-label={`下载 ${fileName}`} onClick={() => void fetchFile(true)}>{loading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</button>
  </div>;
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

function Composer({ accountId, conversationId, input, setInput, askAgentQuote, onClearAskAgentQuote, focusRequest, files, setFiles, draftFiles, draftUploads, draftSaveState, sending, submitting, selectionSaving, pendingPrompts, editingPending, removedEditingFileIds, agentOptions, selectedModel, reasoningEffort, onModelChange, onReasoningChange, onReorderPending, onEditPending, onDeletePending, onSteerPending, pendingActionMode, waitingForWake, onCancelPendingEdit, onAddFiles, onCancelDraftUpload, onPauseDraftUpload, onResumeDraftUpload, onRemoveDraftFile, onClearDraft, onRemoveEditingFile, onRestoreEditingFile, onVoiceActivityChange, onSend, onVoiceTranscript, onVoiceSendAfterTranscription, onCancel }: {
  accountId: string | null;
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
  onVoiceActivityChange: (active: boolean) => void;
  onSend: (message?: string, voiceTranscriptionIds?: string[]) => void;
  onVoiceTranscript: (conversationId: string | null, content: string, quoteExcerpt: string, transcriptionId: string) => void;
  onVoiceSendAfterTranscription: (conversationId: string | null, content: string, quoteExcerpt: string, transcriptionIds: string[]) => void;
  onCancel?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteTimer = useRef<number | undefined>(undefined);
  const [pasteNotice, setPasteNotice] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [openSettingMenu, setOpenSettingMenu] = useState<"model" | "effort" | null>(null);
  const [settingMenuIntent, setSettingMenuIntent] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointerRef = useRef<{ pointerId: number; startX: number; startY: number; triggered: boolean } | null>(null);
  const [longPressArmed, setLongPressArmed] = useState(false);
  const handledFocusRequestRef = useRef(focusRequest);
  const conversationIdRef = useRef(conversationId);
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

  const voiceAttachmentNames = [
    ...(editingPending?.files ?? []).filter((file) => !removedEditingFileIds.includes(file.id)).map((file) => file.original_name),
    ...draftFiles.map((file) => file.original_name),
    ...draftUploads.map((file) => file.name),
    ...files.map((file) => file.name),
  ].slice(0, 12);
  const voice = useVoiceInput({
    accountId,
    persistDraft: true,
    draftScope: "main-composer",
    conversationId,
    draftText: input,
    quoteExcerpt: askAgentQuote,
    attachmentNames: voiceAttachmentNames,
    disabled: submitting || selectionSaving,
    maxDurationMs: 5 * 60 * 1000,
    unsupportedMessage: "当前浏览器不支持录音，请改用最新版 Chrome、Edge 或 Safari。",
    fileNamePrefix: "recording",
    onTranscript: (text, transcriptionId, context) => {
      const sourceConversationId = context?.conversationId ?? conversationIdRef.current;
      const existing = sourceConversationId === conversationIdRef.current ? inputRef.current : context?.draftText ?? "";
      const combined = existing ? `${existing}${/\s$/.test(existing) ? "" : "\n"}${text}` : text;
      if (sourceConversationId === conversationIdRef.current) {
        inputRef.current = combined;
        setInput(combined);
      }
      onVoiceTranscript(sourceConversationId, combined, context?.quoteExcerpt ?? askAgentQuote, transcriptionId);
    },
    onSendAfterTranscription: (text, ids, context) => onVoiceSendAfterTranscription(context?.conversationId ?? conversationIdRef.current, text, context?.quoteExcerpt ?? askAgentQuote, ids),
  });

  useEffect(() => {
    const previousConversationId = conversationIdRef.current;
    if (previousConversationId === conversationId) return;
    conversationIdRef.current = conversationId;
    if (voice.state === "recording") voice.finish(false);
  }, [conversationId, voice.finish, voice.state]);

  useEffect(() => {
    onVoiceActivityChange(voice.state !== "idle");
  }, [onVoiceActivityChange, voice.state]);

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
    return voice.state === "idle"
      && !submitting
      && !selectionSaving
      && !voice.notice
      && !voice.error
      && !inputRef.current.trim()
      && !askAgentQuote
      && filesRef.current.length === 0
      && draftFilesRef.current.length === 0
      && draftUploadsRef.current.length === 0
      && !editingPendingRef.current;
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
      if (!pointer || pointer.pointerId !== event.pointerId || !canArmLongPress()) {
        resetLongPress(event.pointerId);
        return;
      }
      pointer.triggered = true;
      if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      setLongPressArmed(false);
      void voice.start();
    }, COMPOSER_LONG_PRESS_DELAY_MS);
  }

  function moveLongPress(event: ReactPointerEvent<HTMLTextAreaElement>) {
    const pointer = longPressPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || pointer.triggered) return;
    const moved = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
    if (moved > COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX) resetLongPress(event.pointerId);
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

  useEffect(() => {
    if (!input.trim() && voice.transcriptionConversationId === conversationId) voice.clearTranscriptionIds();
  }, [conversationId, input, voice.clearTranscriptionIds, voice.transcriptionConversationId]);

  useEffect(() => {
    const cancel = () => resetLongPress();
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, []);

  useEffect(() => () => {
    window.clearTimeout(pasteTimer.current);
    resetLongPress();
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

  function startRecording() { return voice.start(); }
  function finishRecording(sendAfter: boolean) { voice.finish(sendAfter); }
  function cancelRecording() { voice.cancel(); }
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
  function currentVoiceTranscriptionIds() { return voice.transcriptionConversationId === conversationId ? voice.transcriptionIds : []; }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); voice.state === "recording" ? finishRecording(true) : onSend(undefined, currentVoiceTranscriptionIds()); } }
  const selectedModelOption = agentOptions?.models.find((model) => model.id === selectedModel);
  const effortOptions = agentOptions?.reasoningEfforts.filter((effort) => selectedModelOption?.reasoningEfforts.includes(effort.id)) ?? [];
  const modelOptions = agentOptions?.models.map((model) => ({ id: model.id, label: model.label, description: model.description })) ?? [];
  const hasRetainedEditingFile = Boolean(editingPending?.files.some((file) => !removedEditingFileIds.includes(file.id)));
  const composerExpanded = inputFocused
    || settingMenuIntent
    || Boolean(openSettingMenu)
    || Boolean(input.trim())
    || Boolean(askAgentQuote)
    || files.length > 0
    || draftFiles.length > 0
    || draftUploads.length > 0
    || hasRetainedEditingFile
    || Boolean(editingPending)
    || voice.state !== "idle"
    || Boolean(voice.pendingDraft)
    || voice.draftRestoring
    || Boolean(voice.draftStorageError)
    || Boolean(pasteNotice)
    || Boolean(voice.notice)
    || Boolean(voice.error);
  const compactWrap = !composerExpanded && pendingPrompts.length === 0;
  const primaryAction = chooseComposerPrimaryAction({
    running: Boolean(sending && onCancel),
    hasText: Boolean(input.trim() || askAgentQuote),
    hasAttachments: files.length > 0 || draftFiles.length > 0 || draftUploads.length > 0 || hasRetainedEditingFile,
    voiceActive: voice.state !== "idle",
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
  return <div className={`composer-wrap ${compactWrap ? "compact" : ""}`}>
    {pendingPrompts.length > 0 && <PendingQueue prompts={pendingPrompts} busy={submitting} actionMode={pendingActionMode} waitingForWake={waitingForWake}
      onReorder={onReorderPending} onEdit={onEditPending} onDelete={onDeletePending} onSteer={onSteerPending} />}
    {editingPending && <div className={`editing-pending-banner ${awaitingInstruction ? "awaiting-instruction" : ""}`}><span>{awaitingInstruction ? <Paperclip size={13} /> : <Pencil size={13} />}{awaitingInstruction ? `已上传 ${editingPending.files.length} 个文件，请输入具体操作` : "正在编辑待发送任务"}</span><button type="button" onClick={onCancelPendingEdit} disabled={submitting}><X size={14} />{awaitingInstruction ? "清除文件" : "取消编辑"}</button></div>}
    <div ref={composerRef} className={`composer ${composerExpanded ? "expanded" : "compact"}`}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !composerRef.current?.contains(next)) setInputFocused(false);
      }}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
    {askAgentQuote && <ConversationComposerReference className="ask-agent-reference" reference={{ excerpt: askAgentQuote, kind: "conversation" }} onRemove={onClearAskAgentQuote} />}
    {editingPending && editingPending.files.length > 0 && <div className="editing-pending-files">{editingPending.files.map((file) => {
      const removed = removedEditingFileIds.includes(file.id);
      return <span key={file.id} className={removed ? "removed" : ""}><FileIcon size={14} /><span className="attachment-chip-name">{file.original_name}</span><button type="button" onClick={() => removed ? onRestoreEditingFile(file.id) : onRemoveEditingFile(file.id)} aria-label={`${removed ? "恢复" : "移除"}附件 ${file.original_name}`} title={removed ? "恢复附件" : "移除附件"}>{removed ? <Plus size={13} /> : <X size={13} />}</button></span>;
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
    <textarea ref={textareaRef} className={longPressArmed ? "long-press-armed" : undefined} value={input} onFocus={() => setInputFocused(true)} onChange={(e) => setInput(e.target.value)} onKeyDown={keyDown} onPaste={pasted} onPointerDown={beginLongPress} onPointerMove={moveLongPress} onPointerUp={endLongPress} onPointerCancel={(event) => resetLongPress(event.pointerId)} onBlur={() => resetLongPress()} placeholder={voice.state === "recording" ? "可以继续输入文字；点击发送会先转写语音…" : awaitingInstruction ? "请输入要如何处理刚才上传的文件…" : editingPending ? "修改这条待发送任务…" : askAgentQuote ? "输入你想询问的问题…" : sending ? "继续输入，新任务会先进入待发送队列…" : "给 Agent 发送任务，或粘贴、拖入文件…"} rows={1} disabled={submitting || voice.state === "transcribing"} />
    <ConversationVoicePanel voice={voice} />
    <div className="composer-actions"><div className="composer-primary-actions"><button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={submitting} title="添加文件" aria-label="添加文件"><Paperclip size={17} /><span>添加文件</span></button><input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }} />
      <SettingMenu className="model" label="模型" value={selectedModel} options={modelOptions} placeholder="加载中" title={selectedModelOption?.description || "选择任务使用的模型"} disabled={submitting || selectionSaving || !agentOptions} open={openSettingMenu === "model"} onOpenIntent={() => setSettingMenuIntent(true)} onOpenIntentCancel={() => setSettingMenuIntent(false)} onOpenChange={(open) => {
        setOpenSettingMenu((current) => open ? "model" : current === "model" ? null : current);
      }} onChange={onModelChange} />
      <SettingMenu className="effort" label="思考" value={reasoningEffort} options={effortOptions} placeholder="加载中" title="选择模型的思考深度" disabled={submitting || selectionSaving || effortOptions.length === 0} open={openSettingMenu === "effort"} onOpenIntent={() => setSettingMenuIntent(true)} onOpenIntentCancel={() => setSettingMenuIntent(false)} onOpenChange={(open) => {
        setOpenSettingMenu((current) => open ? "effort" : current === "effort" ? null : current);
      }} onChange={(value) => onReasoningChange(value as ReasoningEffort)} />
    </div>
      <div className="composer-submit-actions">
        {voice.state === "idle" && <button type="button" className="mic-button" onClick={() => void startRecording()} disabled={submitting || selectionSaving} title="录音输入" aria-label="录音输入"><Mic size={18} /></button>}
        {primaryAction === "stop" && onCancel
          ? <button type="button" className="send-button stop" onClick={onCancel} title="停止当前显示的任务" aria-label="停止当前显示的任务"><Square size={15} fill="currentColor" /></button>
          : <button type="button" className="send-button" onClick={() => voice.state === "recording" ? finishRecording(true) : onSend(undefined, currentVoiceTranscriptionIds())} disabled={submitting || selectionSaving || draftUploads.length > 0 || voice.state === "transcribing" || (voice.state !== "recording" && !input.trim() && !askAgentQuote && files.length === 0 && draftFiles.length === 0 && !hasRetainedEditingFile)} title={voice.state === "recording" ? "识别语音并发送" : "发送"} aria-label={voice.state === "recording" ? "识别语音并发送" : "发送"}>{submitting || voice.state === "transcribing" ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button>}
      </div>
    </div>
  </div>{composerExpanded && <p className="composer-note"><span>{draftStatusLabel || pendingQueueGuidance}</span>{hasUnsentDraft && conversationId && <button type="button" onClick={onClearDraft} disabled={submitting || draftUploads.length > 0}>清空草稿</button>}</p>}</div>;
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
