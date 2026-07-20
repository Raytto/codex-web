import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type Dispatch, type FormEvent, type KeyboardEvent, type SetStateAction } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp, Bot, Check, ChevronDown, Download, File as FileIcon, FileImage, FileText, FolderOpen,
  CornerUpLeft, GripVertical, LoaderCircle, LogOut, Menu, Mic, Minus, Monitor, Moon, MoreHorizontal, Paperclip, Pencil, Plus, Search, Settings2, Square, Sun,
  Trash2, X, Zap,
} from "lucide-react";
import { api, BASE_PATH, fileUrl, setCsrf, type AgentOptions, type Conversation, type ConversationDetail, type Job, type JobEvent, type PendingPrompt, type ReasoningEffort, type Session, type WorkFile } from "./api";
import { isBrowserPreviewable, isLocalMarkdownUrl, resolveMessageFileLink } from "./file-links";
import { sanitizeAgentMarkdown } from "./agent-content";
import { chooseComposerPrimaryAction } from "./composer-action";
import { chooseSelectedConversation, mergeJobEvents } from "./recovery";
import { resolveAccountIdentity } from "./account-identity";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "./chat-font-size";
import { applyThemePreference, readStoredThemePreference, THEME_PREFERENCE_KEY, type ThemePreference } from "./theme";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection } from "./ask-agent-selection";
import { mergeMessagePages, preservePrependedScrollTop } from "./message-history";
import { resolveScrollFollow } from "./scroll-follow";
import { buildProcessJournal, isNarrativeActivity } from "./process-journal";

const SELECTED_CONVERSATION_KEY = "codex-web:selected-conversation";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    api.session().then((value) => { setCsrf(value.csrfToken); setSession(value); }).finally(() => setLoading(false));
  }, []);
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

  if (loading) return <div className="boot"><div className="brand-mark"><Zap size={20} /></div><LoaderCircle className="spin" /></div>;
  if (!session?.authenticated) return <Login onLogin={(value) => { setCsrf(value.csrfToken); setSession(value); }} />;
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

function Workspace({ session, onLogout, themePreference, onThemePreferenceChange }: { session: Session; onLogout: () => void; themePreference: ThemePreference; onThemePreferenceChange: (preference: ThemePreference) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => window.localStorage.getItem(SELECTED_CONVERSATION_KEY));
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [askAgentQuote, setAskAgentQuote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [editingPending, setEditingPending] = useState<PendingPrompt | null>(null);
  const [removedEditingFileIds, setRemovedEditingFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [activities, setActivities] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [chatFontSize, setChatFontSize] = useState(() => normalizeChatFontSize(session.chatFontSize, CHAT_FONT_SIZE_DEFAULT));
  const [fontSizeSaving, setFontSizeSaving] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const prependScrollRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const connectedJobRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const editingPendingRef = useRef<PendingPrompt | null>(editingPending);
  const lastEventIdRef = useRef(0);
  selectedIdRef.current = selectedId;
  editingPendingRef.current = editingPending;

  function askAgentAbout(selectedText: string) {
    const normalized = normalizeAskAgentSelection(selectedText);
    if (!normalized) return;
    setAskAgentQuote(normalized.slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1));
    setComposerFocusRequest((request) => request + 1);
  }

  const refreshList = useCallback(async () => {
    const result = await api.conversations(); setConversations(result.conversations); return result.conversations;
  }, []);
  const refreshDetail = useCallback(async (id: string) => {
    const result = await api.conversation(id);
    if (selectedIdRef.current !== id) return result;
    setDetail((current) => current?.conversation.id === id
      ? {
          ...result,
          messages: mergeMessagePages(current.messages, result.messages),
          messagePage: current.messagePage,
        }
      : result);
    setSelectedModel(result.agentSelection.model);
    setReasoningEffort(result.agentSelection.reasoningEffort);
    setJob(result.activeJob);
    setSending(Boolean(result.activeJob));
    setActivities(result.jobEvents);
    if (result.editingPrompt && editingPendingRef.current?.id !== result.editingPrompt.id) {
      setEditingPending(result.editingPrompt);
      setRemovedEditingFileIds([]);
      setFiles([]);
      setInput(result.editingPrompt.content);
      setAskAgentQuote(result.editingPrompt.quote_excerpt ?? "");
    }
    if (!result.editingPrompt && editingPendingRef.current) {
      setEditingPending(null);
      setRemovedEditingFileIds([]);
    }
    lastEventIdRef.current = result.jobEvents.at(-1)?.seq ?? 0;
    if (result.latestJob?.status === "failed") setError(result.jobEvents.findLast((event) => event.message)?.message || "任务处理失败");
    return result;
  }, []);

  useEffect(() => {
    void refreshList().then((items) => {
      const next = chooseSelectedConversation(selectedIdRef.current, items);
      if (next !== selectedIdRef.current) setSelectedId(next);
    });
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
    setLoadingOlderMessages(false);
    if (!selectedId) {
      window.localStorage.removeItem(SELECTED_CONVERSATION_KEY);
      eventSourceRef.current?.close(); connectedJobRef.current = null;
      setDetail(null); setJob(null); setSending(false); setActivities([]);
      setEditingPending(null); setRemovedEditingFileIds([]); setAskAgentQuote("");
      if (agentOptions) {
        setSelectedModel(agentOptions.selection.model);
        setReasoningEffort(agentOptions.selection.reasoningEffort);
      }
      return;
    }
    window.localStorage.setItem(SELECTED_CONVERSATION_KEY, selectedId);
    eventSourceRef.current?.close(); connectedJobRef.current = null; setActivities([]);
    editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]); setInput(""); setAskAgentQuote(""); setFiles([]);
    void reconcile(selectedId);
    setSidebarOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  useEffect(() => {
    const resume = () => { if (selectedIdRef.current) void reconcile(selectedIdRef.current); };
    const visible = () => { if (document.visibilityState === "visible") resume(); };
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
  }, []);
  useLayoutEffect(() => {
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
    if (connectedJobRef.current === activeJob.id && eventSourceRef.current?.readyState !== EventSource.CLOSED) return;
    eventSourceRef.current?.close();
    connectedJobRef.current = activeJob.id;
    setJob(activeJob); setSending(true);
    const after = lastEventIdRef.current;
    const source = new EventSource(`${BASE_PATH}/api/jobs/${activeJob.id}/events${after ? `?after=${after}` : ""}`);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      if (eventSourceRef.current !== source || selectedIdRef.current !== activeJob.conversation_id) return;
      const data = JSON.parse(event.data) as JobEvent;
      const seq = Number(event.lastEventId || data.seq || 0);
      const stored = { ...data, seq };
      if (seq) lastEventIdRef.current = Math.max(lastEventIdRef.current, seq);
      if (data.type && ["status", "progress"].includes(data.type)) setActivities((previous) => mergeJobEvents(previous, [stored]));
      if (data.type && ["done", "failed"].includes(data.type)) {
        source.close(); connectedJobRef.current = null;
        if (data.type === "failed") setError(data.message || "任务处理失败");
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
      if (value.activeJob) connectJob(value.activeJob);
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
    setError(""); const result = await api.createConversation();
    setSelectedModel(result.agentSelection.model); setReasoningEffort(result.agentSelection.reasoningEffort);
    await refreshList(); setSelectedId(result.conversation.id);
  }

  async function send(message = input) {
    const hasRetainedEditingFile = Boolean(editingPending?.files.some((file) => !removedEditingFileIds.includes(file.id)));
    if ((!message.trim() && !askAgentQuote && files.length === 0 && !hasRetainedEditingFile) || submitting || selectionSaving) return;
    setError(""); setNotice(""); setSubmitting(true);
    if (!sending) setActivities([{ kind: "status", label: files.length ? "正在上传并准备文件" : "正在提交任务" }]);
    try {
      let id = selectedId;
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
        }
      } else {
        const result = await api.sendMessage(id, message, files, askAgentQuote);
        if (result.needsInstruction) setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
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
      const result = await api.editPendingPrompt(selectedId, prompt.id);
      editingPendingRef.current = result.editingPrompt;
      setEditingPending(result.editingPrompt); setRemovedEditingFileIds([]); setFiles([]); setAskAgentQuote(result.editingPrompt.quote_excerpt ?? ""); setInput(result.editingPrompt.content);
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
    if (!selectedId || submitting || job?.status !== "running") return;
    setSubmitting(true); setError("");
    try { await api.steerPendingPrompt(selectedId, prompt.id); await reconcile(selectedId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "引导当前任务失败"); }
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

  const filtered = useMemo(() => conversations.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [conversations, query]);
  const currentDetail = detail?.conversation.id === selectedId ? detail : null;
  const loadingConversation = Boolean(selectedId && !currentDetail);
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
        <div className="conversation-list">
          {filtered.map((conversation) => <div key={conversation.id} className={`conversation-row ${selectedId === conversation.id ? "active" : ""}`}>
            <button className="conversation-select" onClick={() => setSelectedId(conversation.id)}>
              <FolderOpen size={16} /><span>{conversation.title}</span>{conversation.status === "running" && <LoaderCircle size={14} className="spin" />}
            </button>
            <div className="row-actions">
              <button aria-label="重命名" onClick={() => void renameConversation(conversation)}><Pencil size={14} /></button>
              <button aria-label="删除" onClick={() => void deleteConversation(conversation)}><Trash2 size={14} /></button>
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
        </section>}
        <div className="account-row">
          <button className="account-profile" type="button" aria-expanded={accountSettingsOpen} onClick={() => setAccountSettingsOpen((open) => !open)}>
            <span className="avatar" aria-label={`${account.displayName} 头像`}>{account.initials}</span><span className="account-copy"><strong>{account.displayName}</strong><small>自托管工作站</small></span><Settings2 size={15} />
          </button>
          <button className="icon-button" onClick={() => void logout()} title="退出登录"><LogOut size={17} /></button>
        </div>
      </div>
    </aside>

    <main className="workspace">
      <header className="mobile-header"><button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏"><Menu size={20} /></button><div className="wordmark"><span className="brand-mark small"><Zap size={14} /></span><span className="brand-copy"><strong>Codex Web</strong><small>SELF-HOSTED CODEX WORKSTATION</small></span></div></header>
      {currentDetail ? <Chat detail={currentDetail} activities={activities} sending={sending} loadingOlderMessages={loadingOlderMessages} messagesRef={messagesRef} onMessagesScroll={handleMessagesScroll} onAskAgent={askAgentAbout} userInitials={account.initials} chatFontSize={chatFontSize} />
        : loadingConversation ? <ConversationLoading />
        : <Welcome onSuggestion={(text) => setInput(text)} />}
      {error && <div className="toast"><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
      {notice && <div className="toast info" role="status"><span>{notice}</span><button onClick={() => setNotice("")}><X size={16} /></button></div>}
      {(!selectedId || currentDetail) && <Composer key={selectedId ?? "new-conversation"} input={input} setInput={setInput} askAgentQuote={askAgentQuote} onClearAskAgentQuote={() => setAskAgentQuote("")} focusRequest={composerFocusRequest} files={files} setFiles={setFiles} sending={sending} submitting={submitting} selectionSaving={selectionSaving} voiceEnabled={Boolean(session.voiceEnabled)}
        conversationId={selectedId}
        pendingPrompts={currentDetail?.pendingPrompts ?? []} editingPending={editingPending} removedEditingFileIds={removedEditingFileIds}
        agentOptions={agentOptions} selectedModel={selectedModel} reasoningEffort={reasoningEffort}
        onModelChange={changeModel} onReasoningChange={changeReasoning}
        onReorderPending={(ordered) => void reorderPendingPrompts(ordered)} onEditPending={(prompt) => void beginPendingEdit(prompt)}
        onDeletePending={(prompt) => void deletePendingPrompt(prompt)} onSteerPending={(prompt) => void steerPendingPrompt(prompt)}
        canSteer={job?.status === "running"} onCancelPendingEdit={() => void cancelPendingEdit()}
        onRemoveEditingFile={(fileId) => setRemovedEditingFileIds((current) => [...current, fileId])}
        onRestoreEditingFile={(fileId) => setRemovedEditingFileIds((current) => current.filter((id) => id !== fileId))}
        onSend={(message) => void send(message)} onCancel={job && selectedId ? () => void api.cancelConversation(selectedId).then(() => reconcile(selectedId)) : undefined} />}
    </main>
  </div>;
}

function ConversationLoading() {
  return <section className="conversation-loading" role="status" aria-live="polite"><LoaderCircle className="spin" size={23} /><span>正在加载任务…</span></section>;
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

function Chat({ detail, activities, sending, loadingOlderMessages, messagesRef, onMessagesScroll, onAskAgent, userInitials, chatFontSize }: { detail: ConversationDetail; activities: JobEvent[]; sending: boolean; loadingOlderMessages: boolean; messagesRef: React.RefObject<HTMLDivElement | null>; onMessagesScroll: (event: React.UIEvent<HTMLDivElement>) => void; onAskAgent: (selectedText: string) => void; userInitials: string; chatFontSize: number }) {
  const citationFiles = detail.messages.flatMap((message) => message.files);
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
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) return clear();
        const horizontalInset = 72;
        const left = Math.min(window.innerWidth - horizontalInset, Math.max(horizontalInset, rect.left + rect.width / 2));
        const below = window.innerHeight - rect.bottom >= 64;
        setAskSelection({ text, left, top: below ? rect.bottom + 10 : rect.top - 10, below });
      });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", clear);
    const messages = messagesRef.current;
    messages?.addEventListener("scroll", clear, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", clear);
      messages?.removeEventListener("scroll", clear);
    };
  }, [detail.conversation.id]);

  function useSelectedText() {
    if (!askSelection) return;
    onAskAgent(askSelection.text);
    setAskSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  return <section ref={chatRef} className="chat"><div className="chat-header"><div><span className="chat-kicker">CODEX WEB <i>/</i> AI 工作台</span><h1>{detail.conversation.title}</h1></div><div className="chat-header-actions"><span className="message-count">已加载 {detail.messages.length} 条</span><button className="icon-button" aria-label="更多"><MoreHorizontal size={20} /></button></div></div>
    <div ref={messagesRef} className="messages" onScroll={onMessagesScroll} style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}>
      {detail.messagePage.hasMore && <div className="history-loader" aria-live="polite">{loadingOlderMessages ? <><LoaderCircle className="spin" size={14} /><span>正在加载更早消息…</span></> : <span>向上滚动加载更早消息</span>}</div>}
      {detail.messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
        <div className="message-avatar">{message.role === "assistant" ? <Zap size={15} /> : userInitials}</div>
        <div className="message-body">
          <div className="message-meta"><span className="message-name">{message.role === "assistant" ? "Codex Web" : "你"}</span><time dateTime={message.created_at} title={formatFullDateTime(message.created_at)}>{formatMessageDateTime(message.created_at)}</time></div>
          {message.role === "assistant" ? <div className="markdown" data-agent-selectable="true"><ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => isLocalMarkdownUrl(url) ? url : defaultUrlTransform(url)}
            components={{ a: ({ href, children }) => {
              const resolved = resolveMessageFileLink(href, message.files);
              if (resolved.kind === "download") return <a href={resolved.href} download>{children}</a>;
              if (resolved.kind === "unavailable") return <span className="unavailable-file-link" title="该本机文件未登记为此消息的附件">{children}（不可下载）</span>;
              return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
            } }}
          >{sanitizeAgentMarkdown(message.content, citationFiles)}</ReactMarkdown></div> : <>
            {message.quote_excerpt && <div className="message-reference" title={message.quote_excerpt}><CornerUpLeft size={14} /><span><strong>引用</strong>{message.quote_excerpt}</span></div>}
            {message.content && <p data-agent-selectable="true">{message.content}</p>}
          </>}
          {message.files.length > 0 && <div className="file-grid">{message.files.map((file) => <FileCard key={file.id} file={file} />)}</div>}
        </div>
      </article>)}
      {sending && <article className="message assistant running"><div className="message-avatar"><Zap size={15} /></div><div className="message-body"><div className="message-meta"><span className="message-name">Codex Web</span><span className="live-label">实时进度</span></div><ProcessPanel activities={activities} /></div></article>}
      <div />
    </div>{askSelection && <button type="button" className={`ask-agent-selection ${askSelection.below ? "below" : "above"}`} style={{ left: askSelection.left, top: askSelection.top }} onPointerDown={(event) => { event.preventDefault(); useSelectedText(); }} onClick={(event) => { if (event.detail === 0) useSelectedText(); }}><Zap size={14} /><span>询问 Agent</span></button>}
  </section>;
}

function ProcessPanel({ activities }: { activities: JobEvent[] }) {
  const latestStatus = activities.findLast((item) => item.type === "status" || item.kind === "status");
  const queueStatus = activities.findLast((activity) => activity.status === "queued");
  const queued = Boolean(queueStatus) && !activities.some((activity) => activity.status === "running");
  const retrying = !queued && latestStatus?.status === "retrying";
  const plan = activities.findLast((activity) => activity.kind === "todo" && Boolean(activity.items?.length));
  const journal = buildProcessJournal(activities);
  const completedPlanItems = plan?.items?.filter((item) => item.completed).length ?? 0;
  return <div className="activity-card" role="status" aria-live="polite">
    <div className="activity-title"><LoaderCircle className="spin" size={17} /><strong>{queued ? "正在排队" : retrying ? "正在自动重试" : "正在处理"}</strong><span>{queued ? (queueStatus?.jobsAhead ? `前面还有 ${queueStatus.jobsAhead} 个任务，完成后自动开始` : "即将自动开始") : retrying ? latestStatus.label : "完成前持续保留，可随时引导"}</span></div>
    {plan?.items && <div className="process-plan"><div className="process-section-title"><strong>执行计划</strong><span>{completedPlanItems}/{plan.items.length}</span></div><ul>
      {plan.items.map((item, index) => <li className={item.completed ? "completed" : index === completedPlanItems ? "current" : ""} key={`${item.text}-${index}`}><span>{item.completed ? <Check size={12} /> : index === completedPlanItems ? <LoaderCircle className="spin" size={12} /> : index + 1}</span><p>{item.text}</p></li>)}
    </ul></div>}
    <div className="process-section-title"><strong>工作记录</strong><span>{journal.length ? `${journal.length} 条 · 全程保留` : "实时更新"}</span></div>
    <div className="process-journal">{journal.length ? journal.map((activity, index) => isNarrativeActivity(activity)
      ? <section className="process-journal-note" key={activity.seq ?? `${activity.kind}-${index}`}>
          <header><Bot size={14} /><strong>{activity.kind === "reasoning" ? "重要思路" : "阶段反馈"}</strong>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}</header>
          <div className="process-note-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{activity.detail}</ReactMarkdown></div>
        </section>
      : <div className="activity-line" key={activity.seq ?? `${activity.label}-${index}`}>
          {activity.label?.startsWith("正在") ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          <div><span>{activity.label}</span>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}
            {activity.kind === "file" && activity.files?.length ? <small>{activity.files.map((file) => file.split(/[\\/]/).at(-1)).join("、")}</small> : null}
            {["search", "tool"].includes(activity.kind ?? "") && activity.detail ? <small>{activity.detail}</small> : null}
            {activity.kind === "command" && activity.detail ? <details className="technical-detail"><summary>{activity.actionCount && activity.actionCount > 1 ? `查看 ${activity.actionCount} 个技术步骤` : "查看技术细节"}</summary><code>{activity.groupedDetails?.join("\n\n") || activity.detail}</code></details> : null}
          </div>
        </div>) : <p className="process-journal-empty">正在建立执行方向…</p>}</div>
  </div>;
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
  const icon = file.mime_type.startsWith("image/") ? <FileImage size={20} /> : <FileIcon size={20} />;
  const previewable = isBrowserPreviewable(file);
  const body = <>{icon}<span><strong>{file.original_name}</strong><small>{formatSize(file.size)} · {file.kind === "output" ? "结果文件" : "上传文件"}</small></span></>;
  return <div className="file-card">
    {previewable
      ? <a href={fileUrl(file)} target="_blank" rel="noreferrer">{body}</a>
      : <a href={fileUrl(file, true)} download={file.original_name}>{body}</a>}
    <a className="download-button" href={fileUrl(file, true)} download={file.original_name} title="下载"><Download size={16} /></a>
  </div>;
}

function PendingQueue({ prompts, busy, canSteer, onReorder, onEdit, onDelete, onSteer }: {
  prompts: PendingPrompt[];
  busy: boolean;
  canSteer: boolean;
  onReorder: (ordered: PendingPrompt[]) => void;
  onEdit: (prompt: PendingPrompt) => void;
  onDelete: (prompt: PendingPrompt) => void;
  onSteer: (prompt: PendingPrompt) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  function dropOn(targetId: string) {
    if (!draggingId || draggingId === targetId) return setDraggingId(null);
    const sourceIndex = prompts.findIndex((prompt) => prompt.id === draggingId);
    const targetIndex = prompts.findIndex((prompt) => prompt.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return setDraggingId(null);
    const ordered = [...prompts];
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    setDraggingId(null);
    onReorder(ordered);
  }
  return <section className="pending-queue" aria-label="待发送任务队列">
    <div className="pending-queue-heading"><strong>待发送</strong><span>{prompts.length} 个任务 · 当前任务完成后依次发送</span></div>
    <div className="pending-queue-list">
      {prompts.map((prompt) => <article key={prompt.id} className={`pending-queue-item ${draggingId === prompt.id ? "dragging" : ""}`}
        onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => dropOn(prompt.id)}>
        <button type="button" className="pending-drag-handle" draggable={!busy}
          onDragStart={(event) => { setDraggingId(prompt.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => setDraggingId(null)} title="拖动调整顺序" aria-label="拖动调整顺序"><GripVertical size={17} /></button>
        <div className="pending-queue-copy" title={prompt.content || prompt.quote_excerpt || prompt.files.map((file) => file.original_name).join("、")}>
          <span>{prompt.content || prompt.quote_excerpt || prompt.files.map((file) => file.original_name).join("、") || "附件任务"}</span>
          {prompt.quote_excerpt && <small><CornerUpLeft size={11} />含引用</small>}
          {prompt.files.length > 0 && <small><Paperclip size={11} />{prompt.files.length} 个附件</small>}
        </div>
        <div className="pending-queue-actions">
          <button type="button" className="steer-action" disabled={busy || !canSteer} onClick={() => onSteer(prompt)} title={canSteer ? "立即引导当前任务" : "当前任务开始运行后可引导"}><CornerUpLeft size={14} /><span>引导</span></button>
          <button type="button" disabled={busy} onClick={() => onEdit(prompt)} title="编辑"><Pencil size={14} /></button>
          <button type="button" disabled={busy} onClick={() => onDelete(prompt)} title="删除"><Trash2 size={14} /></button>
        </div>
      </article>)}
    </div>
  </section>;
}

function Composer({ conversationId, input, setInput, askAgentQuote, onClearAskAgentQuote, focusRequest, files, setFiles, sending, submitting, selectionSaving, voiceEnabled, pendingPrompts, editingPending, removedEditingFileIds, agentOptions, selectedModel, reasoningEffort, onModelChange, onReasoningChange, onReorderPending, onEditPending, onDeletePending, onSteerPending, canSteer, onCancelPendingEdit, onRemoveEditingFile, onRestoreEditingFile, onSend, onCancel }: {
  conversationId: string | null;
  input: string;
  setInput: (value: string) => void;
  askAgentQuote: string;
  onClearAskAgentQuote: () => void;
  focusRequest: number;
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
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
  canSteer: boolean;
  onCancelPendingEdit: () => void;
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
  const handledFocusRequestRef = useRef(focusRequest);
  const inputRef = useRef(input);
  const filesRef = useRef(files);
  const editingPendingRef = useRef(editingPending);
  const removedEditingFileIdsRef = useRef(removedEditingFileIds);
  const onSendRef = useRef(onSend);
  inputRef.current = input;
  filesRef.current = files;
  editingPendingRef.current = editingPending;
  removedEditingFileIdsRef.current = removedEditingFileIds;
  onSendRef.current = onSend;

  useEffect(() => () => {
    window.clearTimeout(pasteTimer.current);
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
        setVoiceError("录音中断，请检查麦克风权限后重试。"); releaseAudio(); setVoiceState("idle");
      };
      recorder.onstop = () => void processRecording(recorder.mimeType || mimeType || "audio/webm");
      recorder.start(250);
      setVoiceElapsed(0); setVoiceState("recording");
      const startedAt = Date.now();
      durationTimerRef.current = window.setInterval(() => setVoiceElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
      recordingLimitRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          sendAfterTranscriptionRef.current = false;
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
    setVoiceState("idle"); setVoiceElapsed(0);
  }

  async function processRecording(mimeType: string) {
    releaseAudio(); recorderRef.current = null;
    if (discardRecordingRef.current) { chunksRef.current = []; return; }
    const blob = new Blob(chunksRef.current, { type: mimeType }); chunksRef.current = [];
    if (blob.size === 0) { setVoiceError("没有录到声音，请重新录制。"); setVoiceState("idle"); return; }
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "webm";
    try {
      const retainedNames = (editingPendingRef.current?.files ?? [])
        .filter((file) => !removedEditingFileIdsRef.current.includes(file.id))
        .map((file) => file.original_name);
      const attachmentNames = [...retainedNames, ...filesRef.current.map((file) => file.name)].slice(0, 12);
      const result = await api.transcribeAudio(blob, `recording.${extension}`, {
        conversationId: conversationId ?? undefined,
        draftText: inputRef.current,
        attachmentNames,
      });
      const existing = inputRef.current;
      const combined = existing ? `${existing}${/\s$/.test(existing) ? "" : "\n"}${result.text}` : result.text;
      inputRef.current = combined; setInput(combined); setVoiceState("idle"); setVoiceElapsed(0);
      if (sendAfterTranscriptionRef.current) onSendRef.current(combined);
    } catch (reason) {
      setVoiceError(reason instanceof Error ? reason.message : "语音识别失败，请重试。");
      setVoiceState("idle");
    } finally { sendAfterTranscriptionRef.current = false; }
  }
  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((previous) => [...previous, ...incoming].slice(0, 12));
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
    const available = Math.max(0, 12 - files.length);
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
    hasAttachments: files.length > 0 || hasRetainedEditingFile,
    voiceActive: voiceState !== "idle",
  });
  const awaitingInstruction = Boolean(editingPending && !editingPending.content.trim() && !editingPending.quote_excerpt);
  return <div className="composer-wrap">
    {pendingPrompts.length > 0 && <PendingQueue prompts={pendingPrompts} busy={submitting} canSteer={canSteer}
      onReorder={onReorderPending} onEdit={onEditPending} onDelete={onDeletePending} onSteer={onSteerPending} />}
    {editingPending && <div className={`editing-pending-banner ${awaitingInstruction ? "awaiting-instruction" : ""}`}><span>{awaitingInstruction ? <Paperclip size={13} /> : <Pencil size={13} />}{awaitingInstruction ? `已上传 ${editingPending.files.length} 个文件，请输入具体操作` : "正在编辑待发送任务"}</span><button type="button" onClick={onCancelPendingEdit} disabled={submitting}><X size={14} />{awaitingInstruction ? "清除文件" : "取消编辑"}</button></div>}
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
    {askAgentQuote && <div className="ask-agent-reference" title={askAgentQuote}><CornerUpLeft size={15} /><span>{askAgentQuote}</span><button type="button" onClick={onClearAskAgentQuote} aria-label="移除引用" title="移除引用"><X size={14} /></button></div>}
    {editingPending && editingPending.files.length > 0 && <div className="editing-pending-files">{editingPending.files.map((file) => {
      const removed = removedEditingFileIds.includes(file.id);
      return <span key={file.id} className={removed ? "removed" : ""}><FileIcon size={14} />{file.original_name}<button type="button" onClick={() => removed ? onRestoreEditingFile(file.id) : onRemoveEditingFile(file.id)} title={removed ? "恢复附件" : "移除附件"}>{removed ? <Plus size={13} /> : <X size={13} />}</button></span>;
    })}</div>}
    {files.length > 0 && <div className="pending-files">{files.map((file, index) => <span key={`${file.name}-${index}`}><FileIcon size={14} />{file.name}<button onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={13} /></button></span>)}</div>}
    {pasteNotice && <div className="paste-notice" role="status" aria-live="polite"><Check size={14} />{pasteNotice}</div>}
    {voiceError && <div className="voice-error" role="alert"><span>{voiceError}</span><button type="button" onClick={() => setVoiceError("")}><X size={13} /></button></div>}
    <textarea ref={textareaRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={keyDown} onPaste={pasted} placeholder={voiceState === "recording" ? "可以继续输入文字；点击发送会先转写语音…" : awaitingInstruction ? "请输入要如何处理刚才上传的文件…" : editingPending ? "修改这条待发送任务…" : askAgentQuote ? "输入你想询问的问题…" : sending ? "继续输入，新任务会先进入待发送队列…" : "给 Agent 发送任务，或粘贴、拖入文件…"} rows={1} disabled={submitting || voiceState === "transcribing"} />
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
          : <button type="button" className="send-button" onClick={() => voiceState === "recording" ? finishRecording(true) : onSend()} disabled={submitting || selectionSaving || voiceState === "transcribing" || (voiceState !== "recording" && !input.trim() && !askAgentQuote && files.length === 0 && !hasRetainedEditingFile)} title={voiceState === "recording" ? "识别语音并发送" : "发送"} aria-label={voiceState === "recording" ? "识别语音并发送" : "发送"}>{submitting || voiceState === "transcribing" ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button>}
      </div>
    </div>
  </div><p className="composer-note">任务运行中，新内容会先进入待发送队列；也可选择“引导”立即调整当前任务。</p></div>;
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
