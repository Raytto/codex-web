export const BASE_PATH = "/codex-web";

export type Session = { authenticated: boolean; username?: string; displayName?: string; csrfToken?: string; chatFontSize?: number; voiceEnabled?: boolean };
export type Conversation = {
  id: string; title: string; title_source: "default" | "ai" | "manual" | "legacy"; status: "idle" | "running"; has_unread_result: number; unread_anchor_message_id: string | null; has_pending_work: number; active_wake_count: number; next_wake_at: string | null; active_wake_mode: WakePlan["mode"] | null; active_wake_label: string | null; rollout_bytes: number | null; archived_at: string | null; created_at: string; updated_at: string;
};
export type WorkFile = {
  id: string; original_name: string; relative_path: string; mime_type: string; size: number; kind: "upload" | "output";
};
export type FileShareState = { enabled: boolean; publicUrl: string };
export type FilePreviewMetadata = { file: WorkFile; share: FileShareState };
export type PublicFilePreview = {
  file: Pick<WorkFile, "id" | "original_name" | "mime_type" | "size" | "kind">;
  content: string;
};
export type Message = {
  id: string; role: "user" | "assistant" | "system"; content: string; quote_excerpt: string | null; is_scheduled?: number; created_at: string; files: WorkFile[];
};
export type PendingPrompt = {
  id: string;
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  agent_model: string;
  reasoning_effort: string;
  position: number;
  status: "queued" | "editing";
  files: WorkFile[];
  created_at: string;
  updated_at: string;
};
export type ComposerDraft = {
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  files: WorkFile[];
  created_at: string;
  updated_at: string;
};
export type WakePlan = {
  id: string;
  conversation_id: string;
  created_by_job_id: string | null;
  mode: "time" | "event_or_deadline";
  state: "armed" | "triggered" | "cancelled";
  revision: number;
  label: string;
  run_id: string | null;
  deadline_at: string;
  success_prompt: string;
  failure_prompt: string;
  timeout_prompt: string;
  agent_model: string;
  reasoning_effort: string;
  new_conversation: number;
  target_conversation_id: string | null;
  trigger_cause: "success" | "failure" | "deadline" | "manual" | null;
  triggered_at: string | null;
  cancelled_at: string | null;
  pending_prompt_id: string | null;
  job_id: string | null;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  last_event_kind: "success" | "failure" | "deadline" | "manual" | "heartbeat" | null;
  last_event_summary: string | null;
  created_at: string;
  updated_at: string;
};
export type WakeEvent = { wake_plan_id: string; event_id: string; kind: string; summary: string | null; accepted: number; created_at: string };
export type Job = { id: string; status: string; conversation_id: string; error?: string | null; updated_at?: string; queuePosition?: number };
// The online Codex catalog is authoritative. Keep this open so a newer CLI can
// expose a new reasoning level without requiring a front-end release first.
export type ReasoningEffort = string;
export type AgentModelOption = { id: string; label: string; description: string; reasoningEfforts: ReasoningEffort[] };
export type AgentOptions = {
  models: AgentModelOption[];
  reasoningEfforts: Array<{ id: ReasoningEffort; label: string }>;
  defaults: { model: string; reasoningEffort: ReasoningEffort };
  selection: AgentSelection;
};
export type AgentSelection = { model: string; reasoningEffort: ReasoningEffort };
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
export type SubagentEventState = { id: string; path?: string; status: SubagentStatus; summary?: string };
export type JobEvent = {
  seq?: number;
  type?: string;
  created_at?: string;
  kind?: "status" | "reasoning" | "update" | "command" | "file" | "search" | "tool" | "todo" | "error" | "retry" | string;
  label?: string;
  detail?: string;
  files?: string[];
  items?: Array<{ text: string; completed: boolean }>;
  status?: string;
  queuePosition?: number;
  jobsAhead?: number;
  message?: string;
  agents?: SubagentEventState[];
};
export type ConversationDetail = {
  conversation: Conversation;
  agentSelection: AgentSelection;
  messages: Message[];
  messagePage: MessagePage;
  pendingPrompts: PendingPrompt[];
  editingPrompt: PendingPrompt | null;
  composerDraft: ComposerDraft | null;
  wakePlan: WakePlan | null;
  wakeEvents: WakeEvent[];
  activeJob: Job | null;
  latestJob: Job | null;
  jobEvents: JobEvent[];
  rolloutBytes: number | null;
  contextUsage: { inputTokens: number; modelContextWindow: number | null; updatedAt: string | null } | null;
  packageQuota: { remainingPercent: number; updatedAt: string } | null;
};
export type ConversationActivity = {
  activeJob: Job | null;
  latestJob: Job | null;
  jobEvents: JobEvent[];
};
export type MessagePage = { hasMore: boolean; nextCursor: string | null };
export type ConversationMessagesPage = { messages: Message[]; messagePage: MessagePage };
export type PendingMutationResponse = {
  job?: Job;
  pendingPrompt?: PendingPrompt | null;
  editingPrompt?: PendingPrompt | null;
  activeJob?: Job | null;
  queued?: boolean;
  needsInstruction?: boolean;
  guidance?: string;
};

let csrfToken = "";
export function setCsrf(value?: string) { csrfToken = value ?? ""; }
export function resumableUploadEndpoint(): string { return `${BASE_PATH}/api/uploads`; }
export function resumableUploadHeaders(): Record<string, string> { return csrfToken ? { "X-CSRF-Token": csrfToken } : {}; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`${BASE_PATH}/api${path}`, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}

export const api = {
  session: (signal?: AbortSignal) => request<Session>("/auth/session", { cache: "no-store", signal }),
  login: (username: string, password: string) => request<Session>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  conversations: (query = "") => request<{ conversations: Conversation[] }>(`/conversations${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  archivedConversations: (query = "") => request<{ conversations: Conversation[] }>(`/conversations/archived${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  agentOptions: (options: { conversationId?: string } = {}) => request<AgentOptions>(`/agent-options${options.conversationId ? `?conversationId=${encodeURIComponent(options.conversationId)}` : ""}`),
  updateAgentSelection: (selection: AgentSelection, conversationId?: string) => request<{ selection: AgentSelection }>(
    conversationId ? `/conversations/${conversationId}/agent-selection` : "/agent-selection",
    { method: "PUT", body: JSON.stringify(selection) },
  ),
  updateChatFontSize: (chatFontSize: number) => request<{ chatFontSize: number }>("/user-settings/chat-font-size", {
    method: "PUT", body: JSON.stringify({ chatFontSize }),
  }),
  createConversation: (reuseEmpty = true) => request<{ conversation: Conversation; agentSelection: AgentSelection; reused: boolean }>("/conversations", {
    method: "POST", body: JSON.stringify({ reuseEmpty }),
  }),
  conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  conversationActivity: (id: string) => request<ConversationActivity>(`/conversations/${id}/activity`),
  conversationMessages: (id: string, before: string) => request<ConversationMessagesPage>(
    `/conversations/${id}/messages?before=${encodeURIComponent(before)}`,
  ),
  renameConversation: (id: string, title: string) => request<{ conversation: Conversation }>(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  markConversationSeen: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/seen`, { method: "POST" }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  archiveConversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/archive`, { method: "POST" }),
  restoreConversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/restore`, { method: "POST" }),
  cancelConversation: (id: string) => request<{ ok: true }>(`/conversations/${id}/cancel`, { method: "POST" }),
  createTimeWake: (id: string, input: { delaySeconds: number; label?: string; prompt: string; newConversation: boolean; model: string; reasoningEffort: string }) => request<{
    wakePlan: WakePlan;
    targetConversation?: Conversation;
  }>(
    `/conversations/${id}/wake-plans`, { method: "POST", body: JSON.stringify(input) },
  ),
  activeWake: (id: string) => request<{ wakePlan: WakePlan | null }>(`/conversations/${id}/wake-plans/active`),
  cancelWake: (conversationId: string, wakePlanId: string) => request<{ wakePlan: WakePlan }>(
    `/conversations/${conversationId}/wake-plans/${wakePlanId}/cancel`, { method: "POST" },
  ),
  rescheduleWake: (conversationId: string, wakePlanId: string, delaySeconds: number) => request<{ wakePlan: WakePlan }>(
    `/conversations/${conversationId}/wake-plans/${wakePlanId}/reschedule`, { method: "POST", body: JSON.stringify({ delaySeconds }) },
  ),
  updateWakePrompts: (conversationId: string, wakePlanId: string, input: { revision: number; successPrompt: string; failurePrompt?: string; timeoutPrompt?: string }) => request<{ wakePlan: WakePlan }>(
    `/conversations/${conversationId}/wake-plans/${wakePlanId}/prompts`, { method: "PATCH", body: JSON.stringify(input) },
  ),
  triggerWake: (conversationId: string, wakePlanId: string) => request<{ status: string; wakePlan: WakePlan }>(
    `/conversations/${conversationId}/wake-plans/${wakePlanId}/trigger`, { method: "POST" },
  ),
  saveConversationDraft: (id: string, content: string, quoteExcerpt = "", keepalive = false) => request<{ composerDraft: ComposerDraft | null }>(
    `/conversations/${id}/draft`,
    { method: "PUT", body: JSON.stringify({ content, quoteExcerpt }), keepalive },
  ),
  uploadConversationDraftFiles: (id: string, files: File[], signal?: AbortSignal) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return request<{ composerDraft: ComposerDraft; uploadedFiles: WorkFile[] }>(
      `/conversations/${id}/draft/files`, { method: "POST", body, signal },
    );
  },
  resumableUploadResult: (uploadUrl: string) => {
    const id = new URL(uploadUrl, window.location.href).pathname.split("/").filter(Boolean).at(-1) ?? "";
    return request<{ composerDraft: ComposerDraft; uploadedFiles: WorkFile[] }>(`/uploads/${encodeURIComponent(id)}/result`);
  },
  deleteConversationDraftFile: (id: string, fileId: string) => request<{ composerDraft: ComposerDraft | null }>(
    `/conversations/${id}/draft/files/${fileId}`, { method: "DELETE" },
  ),
  deleteConversationDraft: (id: string) => request<void>(`/conversations/${id}/draft`, { method: "DELETE" }),
  sendMessage: (id: string, message: string, files: File[], quoteExcerpt = "", useComposerDraft = false) => {
    const body = new FormData();
    body.set("message", message);
    body.set("quoteExcerpt", quoteExcerpt);
    if (useComposerDraft) body.set("useComposerDraft", "true");
    files.forEach((file) => body.append("files", file));
    return request<PendingMutationResponse>(`/conversations/${id}/messages`, { method: "POST", body });
  },
  transcribeAudio: (audio: Blob, fileName: string, context: { conversationId?: string; draftText?: string; attachmentNames?: string[] } = {}) => {
    const body = new FormData();
    body.set("audio", audio, fileName);
    body.set("conversationId", context.conversationId ?? "");
    body.set("draftText", context.draftText ?? "");
    body.set("attachmentNames", JSON.stringify(context.attachmentNames ?? []));
    return request<{ text: string }>("/transcriptions", { method: "POST", body });
  },
  reorderPendingPrompts: (conversationId: string, ids: string[]) => request<{ pendingPrompts: PendingPrompt[] }>(
    `/conversations/${conversationId}/pending-prompts/order`,
    { method: "PUT", body: JSON.stringify({ ids }) },
  ),
  editPendingPrompt: (conversationId: string, promptId: string) => request<{ editingPrompt: PendingPrompt }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/edit`, { method: "POST" },
  ),
  restorePendingPrompt: (conversationId: string, promptId: string) => request<{ pendingPrompt: PendingPrompt | null; activeJob: Job | null }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/restore`, { method: "POST" },
  ),
  updatePendingPrompt: (conversationId: string, promptId: string, message: string, files: File[], removedFileIds: string[], quoteExcerpt = "") => {
    const body = new FormData();
    body.set("message", message);
    body.set("quoteExcerpt", quoteExcerpt);
    body.set("removedFileIds", JSON.stringify(removedFileIds));
    files.forEach((file) => body.append("files", file));
    return request<PendingMutationResponse>(
      `/conversations/${conversationId}/pending-prompts/${promptId}`, { method: "PUT", body },
    );
  },
  deletePendingPrompt: (conversationId: string, promptId: string) => request<void>(
    `/conversations/${conversationId}/pending-prompts/${promptId}`, { method: "DELETE" },
  ),
  steerPendingPrompt: (conversationId: string, promptId: string) => request<{ ok: true; mode: "steer" | "insert"; turnId?: string; job?: Job }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/steer`, { method: "POST" },
  ),
  cancelJob: (id: string) => request<{ ok: true }>(`/jobs/${id}/cancel`, { method: "POST" }),
  filePreview: (id: string, signal?: AbortSignal) => request<FilePreviewMetadata>(
    `/files/${encodeURIComponent(id)}/preview`, { signal },
  ),
  enableFileShare: (id: string) => request<{ share: FileShareState }>(
    `/files/${encodeURIComponent(id)}/share`, { method: "POST" },
  ),
  disableFileShare: (id: string) => request<{ share: FileShareState }>(
    `/files/${encodeURIComponent(id)}/share`, { method: "DELETE" },
  ),
  publicFilePreview: (id: string, viewId: string, signal?: AbortSignal) => request<PublicFilePreview>(
    `/files/${encodeURIComponent(id)}/preview/public`, { signal, headers: { "X-Codex-Web-View-ID": viewId } },
  ),
  verifyPublicFileShare: async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`${BASE_PATH}/api/files/${encodeURIComponent(id)}/preview/public`, {
      method: "HEAD", credentials: "same-origin", cache: "no-store", signal,
    });
    if (!response.ok) throw new Error("公开分享已关闭或文件不存在。");
  },
  fileText: async (file: WorkFile, signal?: AbortSignal) => {
    const response = await fetch(fileUrl(file), { credentials: "same-origin", signal });
    const body = await response.text();
    if (!response.ok) {
      let message = `文件读取失败 (${response.status})`;
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch { /* A non-JSON error body keeps the generic status message. */ }
      throw new Error(message);
    }
    return body.replace(/^\uFEFF/, "");
  },
};

export function fileUrl(file: WorkFile, download = false): string {
  return `${BASE_PATH}/api/files/${file.id}${download ? "?download=1" : ""}`;
}

export function fileThumbnailUrl(file: WorkFile): string {
  return `${BASE_PATH}/api/files/${file.id}/thumbnail`;
}
