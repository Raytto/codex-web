import type { GeminiAccountRequest, GeminiAccountResult } from "../remote-worker/src/gemini-account-types.js";
import type { TaskMemoryErrorCode, TaskMemoryScopeResult, TenantMemoryTarget } from "./task-memory.js";
import type { ResetConsumption } from "../remote-worker/src/codex-reset-consumer.js";
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
  workflowEpoch?: number;
  userId: string;
  conversationId: string;
  projectRoot: string;
  codexThreadId: string | null;
  agentSessionId?: string | null;
  agentAccountId?: string;
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
  | { type: "workflow_verify"; requestId: string; userId: string; evidence: unknown }
  | ({ type: "gemini_accounts"; requestId: string; userId: string } & GeminiAccountRequest)
  | { type: "memory_scope_attach"; requestId: string; target: TenantMemoryTarget }
  | { type: "memory_scope_finish"; requestId: string; userId: string; token: string }
  | { type: "project_skills"; requestId: string; userId: string; projectId: string; action: import("./project-skills.js").ProjectSkillAction; name?: string; content?: string; enabled?: boolean }
  | { type: "node_transfer"; requestId: string; userId: string; spec: import("../remote-worker/src/node-transfer-types.js").TransferSpec }
  | { type: "run"; request: HostRootRunRequest }
  | { type: "steer"; requestId: string; prompt: string; imageRelativePaths: string[] }
  | { type: "cancel" }
  | { type: "delete_conversation_records"; requestId: string; userId: string; conversationId: string }
  | { type: "delete_thread"; requestId: string; userId: string; threadId: string }
  | { type: "thread_rollout_size"; requestId: string; userId: string; threadId: string }
  | { type: "restore_cold_conversation"; requestId: string; userId: string; conversationId: string; threadId?:string }
  | { type: "restore_storage_file"; requestId: string; userId: string; fileId: string }
  | { type: "restore_storage_native"; requestId: string; userId: string; unitId: string }
  | { type: "restore_storage_item"; requestId: string; userId: string; itemId: string }
  | { type: "read_storage_events"; requestId: string; userId: string; input: import('./storage-event-reader.js').EventReadRequest }
  | { type: "restore_reader_version"; requestId: string; userId: string; versionId: string }
  | { type: "remove_reader_resources"; requestId: string; userId: string; conversationId: string }
  | { type: "project_fs"; requestId: string; userId: string; action: "list" | "create" | "validate" | "initialize"; path: string; name?: string; content?: string }
  | { type: "runtime_status"; requestId: string; userId: string; checkLatest: boolean }
  | { type: "cleanup_runtimes"; requestId: string; userId: string; targets: HostJobRuntimeTarget[] }
  | { type: "voice_review"; requestId: string; request: CodexVoiceReviewRequest }
  | { type: "title_agent"; requestId: string; request: ConversationTitleAgentRequest }
  | { type: "codex_upgrade"; requestId: string; userId: string; version: string }
  | { type: "codex_account_reset"; requestId: string; userId: string; accountId: string; attemptId: string; autoExpiresAt?: string }
  | { type: "codex_accounts_list"; requestId: string; userId: string; refreshUsage?: boolean }
  | { type: "codex_account_login_start"; requestId: string; userId: string; label: string }
  | { type: "codex_account_login_status"; requestId: string; userId: string; loginId: string }
  | { type: "codex_account_login_cancel"; requestId: string; userId: string; loginId: string }
  | { type: "codex_account_activate"; requestId: string; userId: string; accountId: string }
  | { type: "codex_account_delete"; requestId: string; userId: string; accountId: string };

export type HostRootServerMessage =
  | { type: "workflow_verify_result"; requestId: string; verified: true }
  | ({ type: "gemini_accounts_result"; requestId: string } & GeminiAccountResult)
  | { type: "memory_scope_ready"; requestId: string }
  | { type: "memory_scope_result"; requestId: string; result: TaskMemoryScopeResult }
  | { type: "project_skills_result"; requestId: string; result: import("./project-skills.js").ProjectSkillResult }
  | { type: "node_transfer_started"; requestId: string }
  | { type: "event"; jobId: string; event: TenantWorkerEvent }
  | { type: "delete_thread_result"; requestId: string; removed: number }
  | { type: "thread_rollout_size_result"; requestId: string; bytes: number | null }
  | { type: "restore_cold_conversation_result"; requestId: string; conversationId: string; restored: boolean }
  | { type: "restore_storage_result"; requestId: string; restored: boolean }
  | { type: "storage_events_result"; requestId: string; result: import('./storage-event-reader.js').EventHistoryPage & {retryAfterSeconds?:number} }
  | { type: "restore_reader_version_result"; requestId: string; versionId: string; restored: boolean }
  | { type: "remove_reader_resources_result"; requestId: string; conversationId: string; removed: boolean }
  | ({ type: "project_fs_result"; requestId: string } & HostProjectFsResult)
  | ({ type: "runtime_status_result"; requestId: string } & ExecutorRuntimeStatus)
  | ({ type: "cleanup_runtimes_result"; requestId: string } & HostRuntimeCleanupResult)
  | { type: "voice_review_result"; requestId: string; output: string }
  | { type: "title_agent_result"; requestId: string; output: string }
  | ({ type: "codex_upgrade_result"; requestId: string; accepted: boolean } & ExecutorRuntimeStatus)
  | { type: "codex_account_reset_result"; requestId: string; result: ResetConsumption }
  | { type: "codex_accounts_result"; requestId: string; accounts: CodexAccountView[]; activeAccountId: string }
  | { type: "codex_account_login_result"; requestId: string; login: CodexAccountLoginView }
  | { type: "request_failed"; requestId?: string; message: string; resourceCode?: TaskMemoryErrorCode };

export type HostRootExecutionRequest = HostRootRunRequest & {
  workspace: string;
  runtimeRoot: string;
  knowledgeRoot: string;
  codexHome: string;
  threadInstructions: string;
  antigravityRuntime?: import("../remote-worker/src/gemini-accounts.js").GeminiRuntime;
  imagePaths: string[];
};

export type HostRootJobInput =
  | { type: "run"; request: HostRootExecutionRequest }
  | { type: "steer"; requestId: string; prompt: string; imagePaths: string[] }
  | { type: "cancel" };
