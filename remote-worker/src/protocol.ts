export const PROTOCOL_VERSION = 5;
export type AgentModelOption = { id: string; label: string; description: string; reasoningEfforts: string[] };
export type AgentOptions = { models: AgentModelOption[]; reasoningEfforts: Array<{ id: string; label: string }>; defaults: { model: string; reasoningEffort: string } };
export type RuntimeStatus = { installedVersion: string; latestVersion: string | null; versionCheckedAt: string | null; catalogUpdatedAt: string | null; agentOptions: AgentOptions | null };
export type WorkerUpdateResult = { requestId: string; targetVersion: string; targetRef: string; ok: boolean; installedVersion: string; installedRef: string | null; installedCommit: string | null; message?: string };
export type ContextUsage = { threadId: string; inputTokens: number; modelContextWindow: number | null };
export type CodexQuotaUsage = { remainingPercent: number; resetAt?: string | null };
export type CodexAccountView = { id: string; label: string; email: string | null; accountHint: string; active: boolean; createdAt: string; lastUsedAt: string | null; quotaRemainingPercent?: number | null; quotaResetAt?: string | null; quotaUpdatedAt?: string | null };
export type CodexAccountsState = { accounts: CodexAccountView[]; activeAccountId: string };
export type CodexAccountLoginView = { id: string; status: "starting" | "waiting_for_user" | "succeeded" | "failed" | "cancelled"; verificationUrl: string | null; userCode: string | null; error: string | null; account: CodexAccountView | null; createdAt: string; expiresAt: string };

export type ProjectFsResult = { directory: string; parent: string | null; directories: Array<{ name: string; path: string }>; virtualRoot?: boolean };
export type Attachment = { id: string; name: string; mimeType: string; size: number; downloadPath: string };
export type AccountSkillFile = { path: string; contentBase64: string; executable?: true };
export type AccountSkill = { name: string; files: AccountSkillFile[] };
export type AccountSkillBundle = { version: 1; revision: string; skills: AccountSkill[] };
export type RunRequest = {
  jobId: string;
  conversationId: string;
  projectRoot: string;
  codexThreadId: string | null;
  prompt: string;
  attachments: Attachment[];
  transferToken: string;
  selection: { model: string; reasoningEffort: string };
  optionalCapabilities: Record<string, boolean>;
  accountSkills?: AccountSkillBundle;
  automation?: { token: string; dynamicTool?: true };
  turnContext?: { version: 1; userPrompt: string; interruptedContext?: string; imageInput: "preload" | "path_only" | "none" };
};
export type WorkerEvent =
  | { type: "thread_started"; threadId: string }
  | { type: "context_usage"; usage: ContextUsage }
  | { type: "quota_usage"; usage: CodexQuotaUsage }
  | { type: "progress"; payload: unknown }
  | { type: "steer_completed"; requestId: string; turnId: string }
  | { type: "steer_failed"; requestId: string; message: string }
  | { type: "completed"; finalResponse: string; omittedArtifacts?: Array<{
    path: string;
    reason: "count_limit" | "outside_project" | "missing" | "not_file" | "too_large" | "manifest_limit";
  }> }
  | { type: "failed"; message: string; cancelled?: boolean };
export type ThreadTranscriptItem = { turnId: string; itemId: string; role: "user" | "assistant"; content: string; createdAt: string };
export type ThreadActivity = {
  turnId: string;
  itemId: string;
  kind: "reasoning" | "update" | "command" | "file" | "search" | "tool" | "agent";
  label: string;
  detail?: string;
  files?: string[];
  agents?: Array<{
    id: string;
    path?: string;
    status: "pending" | "running" | "completed" | "failed" | "interrupted";
    summary?: string;
  }>;
  createdAt: string;
};
export type ThreadSnapshot = {
  id: string;
  name: string;
  nameSource: "explicit" | "preview" | "fallback";
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running";
  rolloutBytes?: number | null;
  messages: ThreadTranscriptItem[];
  activities: ThreadActivity[];
};
export type ServerMessage =
  | { type: "authenticated"; workerId: string; heartbeatIntervalMs: number }
  | { type: "project_watch"; projects: Array<{ id: string; rootPath: string }> }
  | { type: "request_failed"; requestId?: string; message: string }
  | { type: "project_fs"; requestId: string; action: "list" | "create" | "validate" | "initialize"; path: string; name?: string; content?: string }
  | { type: "run"; request: RunRequest }
  | { type: "steer"; jobId: string; requestId: string; prompt: string; attachments: Attachment[]; transferToken: string; turnContext?: { version: 1; userPrompt: string; imageInput: "preload" | "path_only" | "none" } }
  | { type: "cancel"; jobId: string }
  | { type: "thread_rename"; requestId: string; threadId: string; name: string }
  | { type: "thread_archive"; requestId: string; threadId: string }
  | { type: "thread_sync"; requestId: string; projectRoot: string; cursor: string | null; limit: number }
  | { type: "file_fetch"; requestId: string; projectRoot: string; path: string; transferToken: string }
  | { type: "title_agent"; requestId: string; prompt: string; timeoutMs: number }
  | { type: "runtime_refresh"; requestId: string; checkLatest: boolean }
  | { type: "codex_upgrade"; requestId: string; version: string }
  | { type: "worker_update"; requestId: string; targetVersion: string; targetRef: string }
  | { type: "worker_update_result_ack"; requestId: string }
  | { type: "worker_config"; requestId: string; capacity: number }
  | { type: "codex_accounts"; requestId: string; action: "list" | "login_start" | "login_status" | "login_cancel" | "activate" | "delete"; label?: string; loginId?: string; accountId?: string }
  | { type: "heartbeat_ack"; at: string };
export type WorkerMessage =
  | { type: "hello"; protocolVersion: number; workerId: string; machineName: string; enrollmentToken: string; platform: string; workerVersion: string; workerRelease: string | null; workerCommit: string | null; capabilities: { workerUpdate: boolean; waitAutomation: boolean; capacityConfig: boolean; dynamicWaitTool?: boolean; agentTurnContext?: boolean; accountSkills?: boolean; titleAgent?: boolean; codexAccounts?: boolean }; codexVersion: string; capacity: number }
  | { type: "heartbeat"; activeJobs: string[] }
  | { type: "quota_usage"; usage: CodexQuotaUsage; accountId?: string }
  | { type: "thread_activity"; projectId: string; thread: ThreadSnapshot }
  | ({ type: "project_fs_result"; requestId: string } & ProjectFsResult)
  | { type: "request_failed"; requestId?: string; message: string }
  | { type: "event"; jobId: string; event: WorkerEvent }
  | { type: "thread_rename_result"; requestId: string; ok: boolean; message?: string }
  | { type: "file_fetch_result"; requestId: string; ok: boolean; message?: string }
  | { type: "title_agent_result"; requestId: string; ok: boolean; output?: string; message?: string }
  | ({ type: "runtime_status"; requestId?: string } & RuntimeStatus)
  | { type: "codex_upgrade_result"; requestId: string; ok: boolean; message?: string; runtime?: RuntimeStatus }
  | { type: "worker_update_ack"; requestId: string; accepted: boolean; message?: string }
  | ({ type: "worker_update_result" } & WorkerUpdateResult)
  | { type: "worker_config_result"; requestId: string; ok: boolean; capacity?: number; message?: string }
  | { type: "codex_accounts_result"; requestId: string; ok: boolean; state?: CodexAccountsState; login?: CodexAccountLoginView; restart?: boolean; message?: string }
  | { type: "thread_sync_result"; requestId: string; threads: ThreadSnapshot[]; nextCursor: string | null };
