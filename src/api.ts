export const BASE_PATH = "/codex-web";

export type Session = { authenticated: boolean; username?: string; displayName?: string; csrfToken?: string; chatFontSize?: number; voiceEnabled?: boolean };
export type Conversation = {
  id: string; title: string; title_source: "default" | "ai" | "manual" | "legacy"; status: "idle" | "running"; created_at: string; updated_at: string;
};
export type WorkFile = {
  id: string; original_name: string; relative_path: string; mime_type: string; size: number; kind: "upload" | "output";
};
export type Message = {
  id: string; role: "user" | "assistant" | "system"; content: string; created_at: string; files: WorkFile[];
};
export type PendingPrompt = {
  id: string;
  conversation_id: string;
  content: string;
  agent_model: string;
  reasoning_effort: string;
  position: number;
  status: "queued" | "editing";
  files: WorkFile[];
  created_at: string;
  updated_at: string;
};
export type Job = { id: string; status: string; conversation_id: string; queuePosition?: number };
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
export type JobEvent = {
  seq?: number;
  type?: string;
  created_at?: string;
  kind?: "status" | "reasoning" | "update" | "command" | "file" | "search" | "tool" | "todo" | "error" | string;
  label?: string;
  detail?: string;
  files?: string[];
  items?: Array<{ text: string; completed: boolean }>;
  status?: string;
  queuePosition?: number;
  jobsAhead?: number;
  message?: string;
};
export type ConversationDetail = {
  conversation: Conversation;
  agentSelection: AgentSelection;
  messages: Message[];
  pendingPrompts: PendingPrompt[];
  editingPrompt: PendingPrompt | null;
  activeJob: Job | null;
  latestJob: Job | null;
  jobEvents: JobEvent[];
};
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
  session: () => request<Session>("/auth/session"),
  login: (username: string, password: string) => request<Session>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  conversations: () => request<{ conversations: Conversation[] }>("/conversations"),
  agentOptions: () => request<AgentOptions>("/agent-options"),
  updateAgentSelection: (selection: AgentSelection, conversationId?: string) => request<{ selection: AgentSelection }>(
    conversationId ? `/conversations/${conversationId}/agent-selection` : "/agent-selection",
    { method: "PUT", body: JSON.stringify(selection) },
  ),
  updateChatFontSize: (chatFontSize: number) => request<{ chatFontSize: number }>("/user-settings/chat-font-size", {
    method: "PUT", body: JSON.stringify({ chatFontSize }),
  }),
  createConversation: () => request<{ conversation: Conversation; agentSelection: AgentSelection }>("/conversations", { method: "POST" }),
  conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  renameConversation: (id: string, title: string) => request<{ conversation: Conversation }>(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  cancelConversation: (id: string) => request<{ ok: true }>(`/conversations/${id}/cancel`, { method: "POST" }),
  sendMessage: (id: string, message: string, files: File[]) => {
    const body = new FormData();
    body.set("message", message);
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
  updatePendingPrompt: (conversationId: string, promptId: string, message: string, files: File[], removedFileIds: string[]) => {
    const body = new FormData();
    body.set("message", message);
    body.set("removedFileIds", JSON.stringify(removedFileIds));
    files.forEach((file) => body.append("files", file));
    return request<PendingMutationResponse>(
      `/conversations/${conversationId}/pending-prompts/${promptId}`, { method: "PUT", body },
    );
  },
  deletePendingPrompt: (conversationId: string, promptId: string) => request<void>(
    `/conversations/${conversationId}/pending-prompts/${promptId}`, { method: "DELETE" },
  ),
  steerPendingPrompt: (conversationId: string, promptId: string) => request<{ ok: true; turnId: string }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/steer`, { method: "POST" },
  ),
  cancelJob: (id: string) => request<{ ok: true }>(`/jobs/${id}/cancel`, { method: "POST" }),
};

export function fileUrl(file: WorkFile, download = false): string {
  return `${BASE_PATH}/api/files/${file.id}${download ? "?download=1" : ""}`;
}
