export const BASE_PATH = "";

export type MaintenancePhase = "idle" | "preparing" | "active";
export type DeploymentPhase = "idle" | "queued" | "building" | "candidate_ready" | "waiting_for_jobs" | "promoting" | "health_check" | "deployed" | "superseded" | "conflict" | "deferred" | "failed";
export type DeploymentStatus = {
  requestId: number | null;
  targetSha: string | null;
  status: string;
  phase: DeploymentPhase;
  message: string;
  requestedAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorCode?: number | null;
  errorSummary?: string | null;
  phaseHistory?: Array<{ phase: DeploymentPhase; at: string }>;
};
export type Session = { authenticated: boolean; accountId?: string; username?: string; displayName?: string; csrfToken?: string; chatFontSize?: number; projectMode?: boolean; maintenance?: boolean; maintenancePhase?: MaintenancePhase };
export type SystemStatus = {
  instanceId: string;
  maintenance: boolean;
  maintenancePhase: MaintenancePhase;
  message: string | null;
  maintenanceWait: { runningJobs: number; taskTitle: string | null; lastActivityAt: string | null; stalled: boolean } | null;
  deployment: DeploymentStatus | null;
};
export type CodexAccount = {
  id: string;
  label: string;
  email: string | null;
  accountHint: string;
  active: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  quotaRemainingPercent?: number | null;
  quotaResetAt?: string | null;
  quotaUpdatedAt?: string | null;
};
export type CodexAccountLogin = {
  id: string;
  status: "starting" | "waiting_for_user" | "succeeded" | "failed" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  account: CodexAccount | null;
  createdAt: string;
  expiresAt: string;
};
export type CodexAccountsState = { accounts: CodexAccount[]; activeAccountId: string };
export type Conversation = {
  id: string; project_id: string | null; title: string; title_source: "default" | "ai" | "manual" | "legacy"; status: "idle" | "running"; external_status: "idle" | "running"; sync_origin: "codex_web" | "codex_app"; remote_updated_at: number; pinned_at: string | null; sidebar_order: number; has_unread_result: number; unread_anchor_message_id: string | null; has_pending_work: number; active_wake_count: number; next_wake_at: string | null; active_wake_mode: WakePlan["mode"] | null; active_wake_label: string | null; project_move_blocked: number; rollout_bytes: number | null; last_active_at: string; cold_storage_state: "local" | "uploading" | "remote_verified" | "evicting" | "cold" | "restoring" | "error"; cold_storage_generation: number; cold_storage_revision: number; cold_storage_manifest_sha256: string | null; cold_storage_archive_sha256: string | null; cold_storage_archive_bytes: number | null; cold_storage_remote_path: string | null; cold_storage_error: string | null; archived_at: string | null; created_at: string; updated_at: string;
};
export type Executor = {
  id: string;
  machineName: string;
  kind: "host_root" | "remote_worker" | "tenant_container";
  status: "online" | "offline" | "disabled";
  platform: string;
  capacity: number;
  activeJobs: number;
  lastSeenAt: string | null;
  runtime: ExecutorRuntimeStatus | null;
  securityBoundary: {
    mode: "danger_full_access" | "workspace_write";
    label: string;
    description: string;
  };
  retryCapability: {
    transparentBeforeStart: true;
    replayAfterStart: false;
    idempotencyReceipts: false;
  };
  codexAccountManagementCapable: boolean;
  worker: {
    installedVersion: string;
    installedRef: string | null;
    installedCommit: string | null;
    updaterCapable: boolean;
    capacityConfigurable: boolean;
    targetVersion: string;
    targetRef: string;
    update: {
      requestId: string;
      state: "queued" | "dispatching" | "updating" | "succeeded" | "failed";
      requestedAt: string;
      dispatchedAt: string | null;
      completedAt: string | null;
      error: string | null;
    } | null;
  } | null;
};
export type ExecutorRuntimeStatus = {
  installedVersion: string;
  latestVersion: string | null;
  versionCheckedAt: string | null;
  catalogUpdatedAt: string | null;
  updateState: "idle" | "checking" | "updating" | "failed";
  updateError: string | null;
  agentOptions: Omit<AgentOptions, "selection"> | null;
};
export type RemoteWorkerBootstrap = {
  version: string | null;
  platforms: Array<{ platform: "win32-x64" | "darwin-universal"; label: string; url: string; expiresAt: string }>;
};
export type Project = {
  id: string;
  name: string;
  root_path: string;
  executor_id: string;
  machine_name: string;
  executor_status: "online" | "offline" | "disabled";
  executor_last_seen_at: string | null;
  display_name: string;
  is_default: number;
  sort_order: number;
  sidebar_collapsed: number;
  archived_at: string | null;
  conversation_count: number;
  created_at: string;
  updated_at: string;
};
export type ProjectDirectoryPage = { directory: string; parent: string | null; directories: Array<{ name: string; path: string }> };
export type ProjectSkill = { name: string; description: string; enabled: boolean; updatedAt: string; size: number };
export type ProjectSkillDetail = ProjectSkill & { content: string };
export type ConversationPage = { conversations: Conversation[]; total: number; hasMore: boolean; nextOffset: number | null };
export type WorkFile = {
  id: string; original_name: string; relative_path: string; source_path?: string | null; mime_type: string; size: number; kind: "upload" | "output";
};
export type FileShareState = { enabled: boolean; publicUrl: string };
export type ManagedPublicShare = {
  id: string;
  fileId: string;
  fileName: string;
  documentKind: "markdown" | "html";
  mimeType: string;
  size: number;
  conversationId: string;
  conversationTitle: string;
  enabledAt: string | null;
  publicUrl: string;
};
export type FilePreviewConversation = Pick<Conversation, "id" | "title" | "status" | "external_status" | "has_unread_result" | "has_pending_work">;
export type FilePreviewMetadata = { file: WorkFile; share: FileShareState; conversation: FilePreviewConversation };
export type ReaderFormat = "markdown" | "html" | "pdf" | "epub";
export type ReaderCapability = "vertical-flow" | "pagination" | "text-selection" | "highlight" | "note" | "agent-ask" | "range-fetch" | "nearby-prefetch";
export type ReaderManifest = {
  source: { id: string; fileId: string; title: string; author: string | null; format: ReaderFormat };
  version: { id: string; versionNo: number; derivedKind: "original" | "normalized" | "ocr"; status: "ready" | "processing" | "failed" | "cold" | "restoring"; parserVersion: string; sourceBytes: number; lastAccessedAt: string; error: string | null };
  capabilities: ReaderCapability[];
  units: Array<{ id: string; ordinal: number; kind: "spine" | "page"; href: string; title: string | null; media_type: string; byte_size: number }>;
  endpoints: { bytes: string; manifest: string };
};
export type ReaderUnitResponse = { unit: { id: string; ordinal: number; href: string; title: string | null; mediaType: string }; content: string };
export type ReaderProgress = { user_id: string; version_id: string; unit_id: string | null; position_json: string; updated_at: string };
export type ReaderAnnotation = { id: string; user_id: string; version_id: string; unit_id: string | null; type: "highlight" | "note"; quote_text: string; note_text: string | null; color: string; locator_json: string; created_at: string; updated_at: string; deleted_at: string | null };
export type PublicFilePreview = {
  file: Pick<WorkFile, "id" | "original_name" | "mime_type" | "size" | "kind">;
  content: string;
};
export type Message = {
  id: string; role: "user" | "assistant" | "system"; content: string; quote_excerpt: string | null; is_scheduled?: number; attachment_references: string[]; created_at: string; files: WorkFile[];
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
export type Job = { id: string; status: string; conversation_id: string; error?: string | null; updated_at?: string; queuePosition?: number };
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
  last_event_kind: string | null;
  last_event_summary: string | null;
  created_at: string;
  updated_at: string;
};
export type WakeEvent = { wake_plan_id: string; event_id: string; kind: string; summary: string | null; accepted: number; created_at: string };
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
export type PersonalMemoryReviewAction = "accept" | "reject" | "correct" | "forget";
export type PersonalMemoryEvidence = {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  evidence_kind: "direct" | "inferred" | "correction" | "forget";
  evidence_date: string;
  source_excerpt: string;
  created_at: string;
};
export type PersonalMemoryEntry = {
  id: string;
  kind: "identity" | "preference" | "knowledge_level" | "current_focus" | "project_pointer";
  canonical_key: string;
  statement: string;
  scope: string;
  status: "candidate" | "active" | "conflicted" | "forgotten" | "stale";
  confidence: "explicit" | "high" | "medium" | "low";
  review_state: "unreviewed" | "accepted" | "rejected" | "corrected" | "forgotten";
  reviewed_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string | null;
  evidence_count: number;
  conversation_count: number;
  evidence_date_count: number;
  evidence: PersonalMemoryEvidence[];
};
export type PersonalMemoryManagedFile = {
  name: string;
  content: string;
  editable: boolean;
  updatedAt: string | null;
  maxCharacters: number;
};
export type PersonalMemoryManagement = {
  enabled: boolean;
  configured: boolean;
  revision: number;
  last_published_at: string | null;
  last_successful_run_at: string | null;
  pending: number;
  processed: number;
  active: number;
  candidates: number;
  conflicted: number;
  forgotten: number;
  failedAttempts: number;
  entries: PersonalMemoryEntry[];
  files: PersonalMemoryManagedFile[];
};
export type VoiceLexiconTerm = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  canonical_key: string;
  canonical_text: string;
  aliases: string[];
  term_kind: string;
  status: "candidate" | "active" | "conflicted" | "suppressed";
  pinned: boolean;
  usage_score: number;
  voice_opportunities: number;
  weighted_errors: number;
  reliable_error_rate: number;
  rank_index: number;
  evidence_count: number;
  error_evidence_count: number;
  last_used_at: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
};
export type VoiceLexiconRunSummary = {
  model: string;
  prompt_version: string;
  status: "succeeded" | "failed";
  candidate_count: number;
  created_at: string;
  completed_at: string;
};
export type VoiceLexiconManagement = {
  model: string;
  maxSelectedTerms: number;
  tokenBudget: number;
  batchThreshold: number;
  delayMs: number;
  activeCount: number;
  candidateCount: number;
  conflictedCount: number;
  suppressedCount: number;
  pending: number;
  submitted_pending: number;
  processing: number;
  processed: number;
  failed_attempts: number;
  run_count: number;
  successful_runs: number;
  failed_runs: number;
  lastRun: VoiceLexiconRunSummary | null;
  selectedTerms: VoiceLexiconTerm[];
  candidateTerms: VoiceLexiconTerm[];
};
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
export type SubagentEventState = {
  id: string;
  path?: string;
  status: SubagentStatus;
  summary?: string;
};
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
  conversationStatus: Conversation["status"];
  externalStatus: Conversation["external_status"];
  hasUnreadResult: boolean;
  hasPendingWork: boolean;
  rolloutBytes: number | null;
  contextUsage: { inputTokens: number; modelContextWindow: number | null; updatedAt: string | null } | null;
  packageQuota: { remainingPercent: number; updatedAt: string } | null;
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
  remoteTurnId: string | null;
  remoteActivities: JobEvent[];
};
export type ConversationRestorePending = { restoring: true; state: Conversation["cold_storage_state"]; conversation: Conversation };
export type ConversationActivation = { state: "local" | "restoring" | "error"; restoring: boolean; conversation: Conversation };
export type ConversationActivity = {
  conversationStatus: Conversation["status"];
  externalStatus: Conversation["external_status"];
  hasUnreadResult: boolean;
  hasPendingWork: boolean;
  activeJob: Job | null;
  latestJob: Job | null;
  jobEvents: JobEvent[];
  remoteTurnId: string | null;
  remoteActivities: JobEvent[];
};
export type MessagePage = { hasMore: boolean; nextCursor: string | null };
export type ConversationMessagesPage = { messages: Message[]; messagePage: MessagePage };
export type PendingMutationResponse = {
  job?: Job;
  pendingPrompt?: PendingPrompt | null;
  editingPrompt?: PendingPrompt | null;
  activeJob?: Job | null;
  queued?: boolean;
  maintenance?: boolean;
  maintenancePhase?: MaintenancePhase;
  needsInstruction?: boolean;
  guidance?: string;
  externalRunning?: boolean;
};
export type ProjectSyncResult = { ok: true; scanned: number; created: number; updated: number; importedMessages: number; importedActivities: number; running: number; truncated: boolean; syncedAt: string };

let csrfToken = "";
export function setCsrf(value?: string) { csrfToken = value ?? ""; }
export function resumableUploadEndpoint(): string { return `${BASE_PATH}/api/uploads`; }
export function resumableUploadHeaders(): Record<string, string> { return csrfToken ? { "X-CSRF-Token": csrfToken } : {}; }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiErrorStatus(reason: unknown, status: number): boolean {
  return reason instanceof ApiError && reason.status === status;
}

function waitForReaderRetry(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = window.setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isReaderRetryBody(value: unknown): value is { code?: string; restoring?: boolean; error?: string } {
  return Boolean(value && typeof value === "object" && !("source" in value) && !("unit" in value));
}

type RequestOptions = { allowStatuses?: readonly number[] };

async function request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  // Authenticated API responses are dynamic.  Do not let a browser or an
  // intermediary turn a fresh request into a conditional GET (304), which is
  // not a JSON API response and used to be surfaced as a loading error.
  const response = await fetch(`${BASE_PATH}/api${path}`, {
    ...init,
    cache: init.cache ?? "no-store",
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !options.allowStatuses?.includes(response.status)) throw new ApiError(body.error || `请求失败 (${response.status})`, response.status);
  return body as T;
}

export const api = {
  session: (signal?: AbortSignal) => request<Session>("/auth/session", { cache: "no-store", signal }),
  login: (username: string, password: string) => request<Session>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  systemStatus: () => request<SystemStatus>("/system/status"),
  codexAccounts: (executorId: string) => request<CodexAccountsState>(`/codex-accounts?executorId=${encodeURIComponent(executorId)}`),
  beginCodexAccountLogin: (executorId: string, label: string) => request<{ login: CodexAccountLogin }>("/codex-accounts/logins", { method: "POST", body: JSON.stringify({ executorId, label }) }),
  codexAccountLoginStatus: (executorId: string, loginId: string) => request<{ login: CodexAccountLogin }>(`/codex-accounts/logins/${encodeURIComponent(loginId)}?executorId=${encodeURIComponent(executorId)}`),
  cancelCodexAccountLogin: (executorId: string, loginId: string) => request<{ login: CodexAccountLogin }>(`/codex-accounts/logins/${encodeURIComponent(loginId)}?executorId=${encodeURIComponent(executorId)}`, { method: "DELETE" }),
  activateCodexAccount: (executorId: string, accountId: string) => request<CodexAccountsState>(`/codex-accounts/${encodeURIComponent(accountId)}/activate`, { method: "POST", body: JSON.stringify({ executorId }) }),
  deleteCodexAccount: (executorId: string, accountId: string) => request<CodexAccountsState>(`/codex-accounts/${encodeURIComponent(accountId)}?executorId=${encodeURIComponent(executorId)}`, { method: "DELETE" }),
  personalMemory: () => request<PersonalMemoryManagement>("/personal-memory"),
  voiceLexicon: () => request<VoiceLexiconManagement>("/voice-lexicon"),
  reviewPersonalMemory: (entryId: string, action: PersonalMemoryReviewAction, statement?: string) => request<PersonalMemoryManagement>(
    `/personal-memory/entries/${encodeURIComponent(entryId)}/review`,
    { method: "POST", body: JSON.stringify({ action, statement }) },
  ),
  updatePersonalMemoryFile: (fileName: string, content: string, expectedRevision: number) => request<PersonalMemoryManagement>(
    `/personal-memory/files/${encodeURIComponent(fileName)}`,
    { method: "PUT", body: JSON.stringify({ content, expectedRevision }) },
  ),
  projects: () => request<{ projects: Project[]; canManageProjects: boolean; defaultProjectId: string | null }>("/projects"),
  executors: () => request<{ executors: Executor[] }>("/executors"),
  projectDirectories: (executorId: string, path = "") => request<ProjectDirectoryPage>(
    `/executors/${encodeURIComponent(executorId)}/project-directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
  ),
  createProjectDirectory: (executorId: string, parent: string, name: string) => request<ProjectDirectoryPage>(
    `/executors/${encodeURIComponent(executorId)}/project-directories`,
    { method: "POST", body: JSON.stringify({ parent, name }) },
  ),
  createProject: (name: string, rootPath: string, executorId: string) => request<{ project: Project; restored?: boolean }>(
    "/projects", { method: "POST", body: JSON.stringify({ name, rootPath, executorId }) },
  ),
  renameProject: (id: string, name: string) => request<{ project: Project }>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  archiveProject: (id: string) => request<{ project: Project }>(`/projects/${id}/archive`, { method: "POST" }),
  reorderProjects: (projectIds: string[]) => request<{ ok: true }>("/projects/order", { method: "PUT", body: JSON.stringify({ projectIds }) }),
  updateProjectSidebarCollapsed: (id: string, collapsed: boolean) => request<{ project: Project }>(`/projects/${id}/sidebar-collapsed`, {
    method: "PUT", body: JSON.stringify({ collapsed }),
  }),
  syncProject: (id: string) => request<ProjectSyncResult>(`/projects/${id}/sync`, { method: "POST" }),
  projectSkills: (id: string) => request<{ supported: true; skills: ProjectSkill[] }>(`/projects/${encodeURIComponent(id)}/skills`),
  projectSkill: (id: string, name: string) => request<{ skill: ProjectSkillDetail }>(`/projects/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`),
  createProjectSkill: (id: string, name: string, content: string, enabled = true) => request<{ skill: ProjectSkillDetail }>(`/projects/${encodeURIComponent(id)}/skills`, { method: "POST", body: JSON.stringify({ name, content, enabled }) }),
  updateProjectSkill: (id: string, name: string, content: string) => request<{ skill: ProjectSkillDetail }>(`/projects/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ content }) }),
  setProjectSkillEnabled: (id: string, name: string, enabled: boolean) => request<{ skill: ProjectSkillDetail }>(`/projects/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
  deleteProjectSkill: (id: string, name: string) => request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  conversations: (options: { projectId?: string; query?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.query) params.set("query", options.query);
    params.set("limit", String(options.limit ?? 20));
    params.set("offset", String(options.offset ?? 0));
    return request<ConversationPage>(`/conversations?${params}`);
  },
  conversationBodyMatches: (options: { projectId?: string; query: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams({ query: options.query });
    if (options.projectId) params.set("projectId", options.projectId);
    params.set("limit", String(options.limit ?? 1));
    params.set("offset", String(options.offset ?? 0));
    return request<ConversationPage>(`/conversations/search-body?${params}`);
  },
  activateConversation: (id: string) => request<ConversationActivation>(`/conversations/${encodeURIComponent(id)}/activate`, { method: "POST" }),
  validateConversationSelection: (conversationId: string, projectId: string) => {
    const params = new URLSearchParams({ conversationId, projectId });
    return request<{ valid: boolean; conversationId: string | null; projectId: string | null }>(`/conversation-selection?${params}`);
  },
  archivedConversations: (options: { query?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.query) params.set("query", options.query);
    params.set("limit", String(options.limit ?? 100));
    params.set("offset", String(options.offset ?? 0));
    return request<ConversationPage>(`/conversations/archived?${params}`);
  },
  agentOptions: (options: { projectId?: string; executorId?: string; conversationId?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.executorId) params.set("executorId", options.executorId);
    if (options.conversationId) params.set("conversationId", options.conversationId);
    return request<AgentOptions>(`/agent-options${params.size ? `?${params}` : ""}`);
  },
  updateAgentSelection: (selection: AgentSelection, conversationId?: string, executorId?: string) => request<{ selection: AgentSelection }>(
    conversationId ? `/conversations/${conversationId}/agent-selection` : "/agent-selection",
    { method: "PUT", body: JSON.stringify({ ...selection, executorId }) },
  ),
  refreshExecutorRuntime: (executorId: string) => request<{ runtime: ExecutorRuntimeStatus }>(
    `/executors/${encodeURIComponent(executorId)}/runtime/refresh`, { method: "POST" },
  ),
  upgradeExecutorCodex: (executorId: string) => request<{ accepted: boolean; runtime: ExecutorRuntimeStatus }>(
    `/executors/${encodeURIComponent(executorId)}/codex/upgrade`, { method: "POST" },
  ),
  upgradeRemoteWorker: (executorId: string) => request<{ accepted: boolean; executor: Executor }>(
    `/executors/${encodeURIComponent(executorId)}/worker/upgrade`, { method: "POST" },
  ),
  createRemoteWorkerBootstrap: () => request<RemoteWorkerBootstrap>("/remote-worker-bootstrap", { method: "POST" }),
  updateChatFontSize: (chatFontSize: number) => request<{ chatFontSize: number }>("/user-settings/chat-font-size", {
    method: "PUT", body: JSON.stringify({ chatFontSize }),
  }),
  createConversation: (projectId?: string, reuseEmpty = true) => request<{ conversation: Conversation; agentSelection: AgentSelection; reused: boolean }>("/conversations", { method: "POST", body: JSON.stringify({ projectId, reuseEmpty }) }),
  conversation: (id: string, limit?: number) => request<ConversationDetail | ConversationRestorePending>(`/conversations/${id}${limit ? `?limit=${encodeURIComponent(String(limit))}` : ""}`),
  conversationActivity: (id: string) => request<ConversationActivity>(`/conversations/${id}/activity`),
  conversationMessages: (id: string, before: string, limit?: number) => request<ConversationMessagesPage>(
    `/conversations/${id}/messages?before=${encodeURIComponent(before)}${limit ? `&limit=${encodeURIComponent(String(limit))}` : ""}`,
  ),
  fetchRemoteFile: (conversationId: string, messageId: string, path: string) => request<{ file: WorkFile; alreadyFetched: boolean }>(
    `/conversations/${conversationId}/messages/${messageId}/remote-file`,
    { method: "POST", body: JSON.stringify({ path }) },
  ),
  renameConversation: (id: string, title: string) => request<{ conversation: Conversation }>(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  setConversationPinned: (id: string, pinned: boolean) => request<{ conversation: Conversation }>(`/conversations/${id}/pin`, { method: "PUT", body: JSON.stringify({ pinned }) }),
  moveConversation: (id: string, targetId: string, placement: "before" | "after") => request<{ ok: true }>(`/conversations/${id}/sidebar-position`, {
    method: "PUT", body: JSON.stringify({ targetId, placement }),
  }),
  moveConversationToProject: (id: string, projectId: string) => request<{ conversation: Conversation; fromProjectId: string; toProjectId: string; moved: boolean }>(`/conversations/${id}/project`, {
    method: "PUT", body: JSON.stringify({ projectId }),
  }),
  markConversationSeen: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/seen`, { method: "POST" }),
  archiveConversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/archive`, { method: "POST" }),
  restoreConversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/restore`, { method: "POST" }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  cancelConversation: (id: string) => request<{ ok: true }>(`/conversations/${id}/cancel`, { method: "POST" }),
  createTimeWake: (id: string, input: { delaySeconds: number; label?: string; prompt: string; newConversation: boolean; model: string; reasoningEffort: string }) => request<{
    wakePlan: WakePlan;
    targetConversation?: { id: string; title: string; projectId: string | null };
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
  rescheduleWakeAt: (conversationId: string, wakePlanId: string, deadlineAt: string) => request<{ wakePlan: WakePlan; triggered: boolean }>(
    `/conversations/${conversationId}/wake-plans/${wakePlanId}/reschedule`, { method: "POST", body: JSON.stringify({ deadlineAt }) },
  ),
  updateWakePrompts: (conversationId: string, wakePlanId: string, input: {
    revision: number;
    successPrompt: string;
    failurePrompt?: string;
    timeoutPrompt?: string;
    model?: string;
    reasoningEffort?: string;
  }) => request<{ wakePlan: WakePlan }>(
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
  sendMessage: (id: string, message: string, files: File[], quoteExcerpt = "", useComposerDraft = false, voiceTranscriptionIds: string[] = [], selection?: AgentSelection) => {
    const body = new FormData();
    body.set("message", message);
    body.set("quoteExcerpt", quoteExcerpt);
    if (useComposerDraft) body.set("useComposerDraft", "true");
    body.set("voiceTranscriptionIds", JSON.stringify(voiceTranscriptionIds));
    if (selection) {
      body.set("model", selection.model);
      body.set("reasoningEffort", selection.reasoningEffort);
    }
    files.forEach((file) => body.append("files", file));
    return request<PendingMutationResponse>(`/conversations/${id}/messages`, { method: "POST", body });
  },
  transcribeAudio: (audio: Blob, fileName: string, context: { conversationId?: string; projectId?: string; draftText?: string; attachmentNames?: string[]; purpose?: "composer" | "search"; clientRecordingId?: string } = {}) => {
    const body = new FormData();
    body.set("audio", audio, fileName);
    body.set("conversationId", context.conversationId ?? "");
    body.set("projectId", context.projectId ?? "");
    body.set("draftText", context.draftText ?? "");
    body.set("purpose", context.purpose ?? "composer");
    body.set("attachmentNames", JSON.stringify(context.attachmentNames ?? []));
    body.set("clientRecordingId", context.clientRecordingId ?? "");
    return request<{ text: string; transcriptionId: string }>("/transcriptions", { method: "POST", body });
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
  updatePendingPrompt: (conversationId: string, promptId: string, message: string, files: File[], removedFileIds: string[], quoteExcerpt = "", voiceTranscriptionIds: string[] = []) => {
    const body = new FormData();
    body.set("message", message);
    body.set("quoteExcerpt", quoteExcerpt);
    body.set("removedFileIds", JSON.stringify(removedFileIds));
    body.set("voiceTranscriptionIds", JSON.stringify(voiceTranscriptionIds));
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
  readerFileManifest: async (id: string, signal?: AbortSignal): Promise<ReaderManifest> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const body = await request<ReaderManifest | { code?: string; restoring?: boolean; error?: string }>(
        `/reader/files/${encodeURIComponent(id)}/manifest`, { signal }, { allowStatuses: [202] },
      );
      if (body && typeof body === "object" && "source" in body && body.source?.format) return body as ReaderManifest;
      if (isReaderRetryBody(body) && (body.restoring || body.code === "READER_RESTORE_IN_PROGRESS")) {
        await waitForReaderRetry(signal, 1_000);
        continue;
      }
      throw new ApiError("阅读资源清单无效。", 202);
    }
    throw new ApiError("阅读资源仍在恢复，请稍后重试。", 202);
  },
  readerManifest: async (versionId: string, signal?: AbortSignal): Promise<ReaderManifest> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const body = await request<ReaderManifest | { code?: string; restoring?: boolean; error?: string }>(
        `/reader/versions/${encodeURIComponent(versionId)}/manifest`, { signal }, { allowStatuses: [202] },
      );
      if (body && typeof body === "object" && "source" in body && body.source?.format) return body as ReaderManifest;
      if (isReaderRetryBody(body) && (body.restoring || body.code === "READER_RESTORE_IN_PROGRESS")) {
        await waitForReaderRetry(signal, 1_000);
        continue;
      }
      throw new ApiError("阅读资源清单无效。", 202);
    }
    throw new ApiError("阅读资源仍在恢复，请稍后重试。", 202);
  },
  readerUnit: async (versionId: string, unitId: string, signal?: AbortSignal): Promise<ReaderUnitResponse> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const body = await request<ReaderUnitResponse | { code?: string; restoring?: boolean; error?: string }>(
        `/reader/versions/${encodeURIComponent(versionId)}/units/${encodeURIComponent(unitId)}`, { signal }, { allowStatuses: [202] },
      );
      if (body && typeof body === "object" && "unit" in body && "content" in body) return body as ReaderUnitResponse;
      if (isReaderRetryBody(body) && (body.restoring || body.code === "READER_RESTORE_IN_PROGRESS")) {
        await waitForReaderRetry(signal, 1_000);
        continue;
      }
      throw new ApiError("阅读单元暂不可用。", 202);
    }
    throw new ApiError("阅读单元仍在处理中，请稍后重试。", 202);
  },
  readerProgress: (versionId: string, signal?: AbortSignal) => request<{ progress: ReaderProgress | null }>(
    `/reader/versions/${encodeURIComponent(versionId)}/progress`, { signal },
  ),
  saveReaderProgress: (versionId: string, unitId: string | null, position: Record<string, unknown>) => request<{ progress: ReaderProgress }>(
    `/reader/versions/${encodeURIComponent(versionId)}/progress`, { method: "PUT", body: JSON.stringify({ unitId, position }) },
  ),
  readerAnnotations: (versionId: string, signal?: AbortSignal) => request<{ annotations: ReaderAnnotation[] }>(
    `/reader/versions/${encodeURIComponent(versionId)}/annotations`, { signal },
  ),
  createReaderAnnotation: (versionId: string, input: { unitId: string | null; type: "highlight" | "note"; quoteText: string; noteText?: string | null; color?: string; locator: Record<string, unknown> }) => request<{ annotation: ReaderAnnotation }>(
    `/reader/versions/${encodeURIComponent(versionId)}/annotations`, { method: "POST", body: JSON.stringify(input) },
  ),
  updateReaderAnnotation: (id: string, input: { noteText?: string; color?: string }) => request<{ annotation: ReaderAnnotation }>(
    `/reader/annotations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) },
  ),
  deleteReaderAnnotation: (id: string) => request<void>(`/reader/annotations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  enableFileShare: (id: string) => request<{ share: FileShareState }>(
    `/files/${encodeURIComponent(id)}/share`, { method: "POST" },
  ),
  disableFileShare: (id: string) => request<{ share: FileShareState }>(
    `/files/${encodeURIComponent(id)}/share`, { method: "DELETE" },
  ),
  publicShares: () => request<{ shares: ManagedPublicShare[] }>("/public-shares"),
  publicFilePreview: (id: string, viewId: string, signal?: AbortSignal) => request<PublicFilePreview>(
    `/files/${encodeURIComponent(id)}/preview/public`, { signal, headers: { "X-Codex-View-ID": viewId } },
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
