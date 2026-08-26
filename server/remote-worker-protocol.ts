import type { AgentOptions, AgentSelection } from "./model-options.js";
import type { OptionalAgentCapabilities } from "./optional-capabilities.js";
import type { CodexQuotaUsage } from "./app-server-turn.js";
import type { TenantWorkerEvent } from "./tenant-worker-protocol.js";
import type { AccountSkillBundle } from "./account-skills.js";
import type { CodexAccountLoginView, CodexAccountView } from "./codex-account-manager.js";

export const REMOTE_WORKER_PROTOCOL_VERSION = 5;
export const HOST_EXECUTOR_ID = "local-host";
export const remoteExecutorId = (workerId: string) => `remote:${workerId}`;
export const workerIdFromExecutor = (executorId: string) => executorId.startsWith("remote:") ? executorId.slice(7) : null;

export type RemoteProjectDirectory = { name: string; path: string };
export type RemoteProjectFsResult = {
  directory: string;
  parent: string | null;
  directories: RemoteProjectDirectory[];
  virtualRoot?: boolean;
};

export type RemoteAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  downloadPath: string;
};

export type RemoteRunRequest = {
  jobId: string;
  conversationId: string;
  projectRoot: string;
  codexThreadId: string | null;
  prompt: string;
  attachments: RemoteAttachment[];
  transferToken: string;
  selection: AgentSelection;
  optionalCapabilities: OptionalAgentCapabilities;
  accountSkills?: AccountSkillBundle;
  automation?: { token: string; dynamicTool?: true };
  turnContext?: {
    version: 1;
    userPrompt: string;
    interruptedContext?: string;
    imageInput: "preload" | "path_only" | "none";
  };
};

export type RemoteArtifact = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
};

export type RemoteFetchedArtifact = RemoteArtifact & {
  sourcePath: string;
};

export type RemoteThreadTranscriptItem = {
  turnId: string;
  itemId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type RemoteThreadActivity = {
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

export type RemoteThreadSnapshot = {
  id: string;
  name: string;
  nameSource?: "explicit" | "preview" | "fallback";
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running";
  rolloutBytes?: number | null;
  messages: RemoteThreadTranscriptItem[];
  activities: RemoteThreadActivity[];
};

export type RemoteThreadSyncPage = {
  threads: RemoteThreadSnapshot[];
  nextCursor: string | null;
};

export type RemoteRuntimeStatus = {
  installedVersion: string;
  latestVersion: string | null;
  versionCheckedAt: string | null;
  catalogUpdatedAt: string | null;
  agentOptions: AgentOptions | null;
};

export type RemoteWorkerUpdateResult = {
  requestId: string;
  targetVersion: string;
  targetRef: string;
  ok: boolean;
  installedVersion: string;
  installedRef: string | null;
  installedCommit: string | null;
  message?: string;
};
export type RemoteCodexAccountsState = { accounts: CodexAccountView[]; activeAccountId: string };

export type ServerToRemoteWorker =
  | { type: "authenticated"; workerId: string; heartbeatIntervalMs: number }
  | { type: "project_watch"; projects: Array<{ id: string; rootPath: string }> }
  | { type: "request_failed"; requestId?: string; message: string }
  | { type: "project_fs"; requestId: string; action: "list" | "create" | "validate" | "initialize"; path: string; name?: string; content?: string }
  | { type: "run"; request: RemoteRunRequest }
  | { type: "steer"; jobId: string; requestId: string; prompt: string; attachments: RemoteAttachment[]; transferToken: string; turnContext?: { version: 1; userPrompt: string; imageInput: "preload" | "path_only" | "none" } }
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

export type RemoteWorkerToServer =
  | { type: "hello"; protocolVersion: number; workerId: string; machineName: string; enrollmentToken: string; platform: string; workerVersion: string; workerRelease?: string | null; workerCommit?: string | null; capabilities?: { workerUpdate?: boolean; waitAutomation?: boolean; capacityConfig?: boolean; dynamicWaitTool?: boolean; agentTurnContext?: boolean; accountSkills?: boolean; titleAgent?: boolean; codexAccounts?: boolean }; codexVersion: string; capacity: number }
  | { type: "heartbeat"; activeJobs: string[] }
  | { type: "quota_usage"; usage: CodexQuotaUsage; accountId?: string }
  | { type: "thread_activity"; projectId: string; thread: RemoteThreadSnapshot }
  | ({ type: "project_fs_result"; requestId: string } & RemoteProjectFsResult)
  | { type: "request_failed"; requestId?: string; message: string }
  | { type: "event"; jobId: string; event: TenantWorkerEvent }
  | { type: "artifact_uploaded"; jobId: string; artifact: RemoteArtifact }
  | { type: "thread_rename_result"; requestId: string; ok: boolean; message?: string }
  | { type: "file_fetch_result"; requestId: string; ok: boolean; message?: string }
  | { type: "title_agent_result"; requestId: string; ok: boolean; output?: string; message?: string }
  | ({ type: "runtime_status"; requestId?: string } & RemoteRuntimeStatus)
  | { type: "codex_upgrade_result"; requestId: string; ok: boolean; message?: string; runtime?: RemoteRuntimeStatus }
  | { type: "worker_update_ack"; requestId: string; accepted: boolean; message?: string }
  | ({ type: "worker_update_result" } & RemoteWorkerUpdateResult)
  | { type: "worker_config_result"; requestId: string; ok: boolean; capacity?: number; message?: string }
  | { type: "codex_accounts_result"; requestId: string; ok: boolean; state?: RemoteCodexAccountsState; login?: CodexAccountLoginView; restart?: boolean; message?: string }
  | ({ type: "thread_sync_result"; requestId: string } & RemoteThreadSyncPage);
