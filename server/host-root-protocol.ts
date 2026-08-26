import type { AgentSelection, ExecutorRuntimeStatus } from "./model-options.js";
import type { OptionalAgentCapabilities } from "./optional-capabilities.js";
import type { TenantWorkerEvent } from "./tenant-worker-protocol.js";
import type { CodexEgressKind } from "./codex-egress.js";
import type { AccountSkillBundle } from "./account-skills.js";
import type { CodexVoiceReviewRequest } from "./codex-voice-review.js";
import type { ConversationTitleAgentRequest } from "./conversation-title.js";
import type { CodexAccountLoginView, CodexAccountView } from "./codex-account-manager.js";

export type HostRootRunRequest = {
  jobId: string;
  userId: string;
  conversationId: string;
  projectRoot: string;
  codexThreadId: string | null;
  effectivePrompt: string;
  imageRelativePaths: string[];
  outputSchema?: Record<string, unknown>;
  selection: AgentSelection;
  optionalCapabilities: OptionalAgentCapabilities;
  accountSkills: AccountSkillBundle;
  automation?: { baseUrl: string; token: string; receiptDirectory: string };
  codexEgressKind?: CodexEgressKind;
};

export type HostProjectDirectory = { name: string; path: string };
export type HostJobRuntimeTarget = { conversationId: string; jobId: string };
export type HostRuntimeCleanupResult = {
  removed: number;
  absent: number;
  failed: Array<{ jobId: string; message: string }>;
};
export type HostProjectFsResult = {
  directory: string;
  parent: string | null;
  directories: HostProjectDirectory[];
};

export type HostRootClientMessage =
  | { type: "run"; request: HostRootRunRequest }
  | { type: "steer"; requestId: string; prompt: string; imageRelativePaths: string[] }
  | { type: "cancel" }
  | { type: "delete_thread"; requestId: string; userId: string; threadId: string }
  | { type: "thread_rollout_size"; requestId: string; userId: string; threadId: string }
  | { type: "restore_cold_conversation"; requestId: string; userId: string; conversationId: string }
  | { type: "project_fs"; requestId: string; userId: string; action: "list" | "create" | "validate" | "initialize"; path: string; name?: string; content?: string }
  | { type: "runtime_status"; requestId: string; userId: string; checkLatest: boolean }
  | { type: "cleanup_runtimes"; requestId: string; userId: string; targets: HostJobRuntimeTarget[] }
  | { type: "voice_review"; requestId: string; request: CodexVoiceReviewRequest }
  | { type: "title_agent"; requestId: string; request: ConversationTitleAgentRequest }
  | { type: "codex_upgrade"; requestId: string; userId: string; version: string }
  | { type: "codex_accounts_list"; requestId: string; userId: string }
  | { type: "codex_account_login_start"; requestId: string; userId: string; label: string }
  | { type: "codex_account_login_status"; requestId: string; userId: string; loginId: string }
  | { type: "codex_account_login_cancel"; requestId: string; userId: string; loginId: string }
  | { type: "codex_account_activate"; requestId: string; userId: string; accountId: string }
  | { type: "codex_account_delete"; requestId: string; userId: string; accountId: string };

export type HostRootServerMessage =
  | { type: "event"; jobId: string; event: TenantWorkerEvent }
  | { type: "delete_thread_result"; requestId: string; removed: number }
  | { type: "thread_rollout_size_result"; requestId: string; bytes: number | null }
  | { type: "restore_cold_conversation_result"; requestId: string; conversationId: string; restored: boolean }
  | ({ type: "project_fs_result"; requestId: string } & HostProjectFsResult)
  | ({ type: "runtime_status_result"; requestId: string } & ExecutorRuntimeStatus)
  | ({ type: "cleanup_runtimes_result"; requestId: string } & HostRuntimeCleanupResult)
  | { type: "voice_review_result"; requestId: string; output: string }
  | { type: "title_agent_result"; requestId: string; output: string }
  | ({ type: "codex_upgrade_result"; requestId: string; accepted: boolean } & ExecutorRuntimeStatus)
  | { type: "codex_accounts_result"; requestId: string; accounts: CodexAccountView[]; activeAccountId: string }
  | { type: "codex_account_login_result"; requestId: string; login: CodexAccountLoginView }
  | { type: "request_failed"; requestId?: string; message: string };

export type HostRootExecutionRequest = HostRootRunRequest & {
  workspace: string;
  runtimeRoot: string;
  knowledgeRoot: string;
  codexHome: string;
  threadInstructions: string;
  imagePaths: string[];
};

export type HostRootJobInput =
  | { type: "run"; request: HostRootExecutionRequest }
  | { type: "steer"; requestId: string; prompt: string; imagePaths: string[] }
  | { type: "cancel" };
