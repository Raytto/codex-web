import type { AgentSelection } from "./model-options.js";
import type { OptionalAgentCapabilities } from "./optional-capabilities.js";
import type { JobRuntimeCleanupTarget } from "./python-runtime.js";
import type { CodexEgressKind } from "./codex-egress.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";
import type { CodexVoiceReviewRequest } from "./codex-voice-review.js";
import type { ConversationTitleAgentRequest } from "./conversation-title.js";

export type TenantWorkerRunRequest = {
  jobId: string;
  userId: string;
  conversationId: string;
  projectRoot: string;
  projectDirectory: string;
  pythonRuntimeRoot: string;
  tenantRoot: string;
  workspace: string;
  runtimeRoot: string;
  codexHome: string;
  codexThreadId: string | null;
  effectivePrompt: string;
  imagePaths: string[];
  outputSchema?: Record<string, unknown>;
  selection: AgentSelection;
  networkAccessEnabled: boolean;
  webSearchMode: "cached" | "live";
  codexWindowsSandbox: "elevated" | "unelevated";
  optionalCapabilities: OptionalAgentCapabilities;
  automation?: { baseUrl: string; token: string; receiptDirectory: string };
  codexEgressKind?: CodexEgressKind;
};

export type TenantWorkerEvent =
  | { type: "auth_ready" }
  | { type: "thread_started"; threadId: string }
  | { type: "context_usage"; usage: ContextTokenUsage }
  | { type: "quota_usage"; usage: CodexQuotaUsage }
  | { type: "progress"; payload: unknown }
  | { type: "steer_completed"; requestId: string; turnId: string }
  | { type: "steer_failed"; requestId: string; message: string }
  | { type: "completed"; finalResponse: string; omittedArtifacts?: Array<{
    path: string;
    reason: "count_limit" | "outside_project" | "missing" | "not_file" | "too_large" | "manifest_limit";
  }> }
  | { type: "failed"; message: string; cancelled?: boolean };

export type WebToSupervisorMessage =
  | { kind: "tenant_run"; jobId: string; userId: string; request: TenantWorkerRunRequest }
  | { kind: "tenant_steer"; jobId: string; requestId: string; prompt: string; imagePaths: string[] }
  | { kind: "tenant_cancel"; jobId: string }
  | { kind: "tenant_runtime_cleanup"; requestId: string; targets: JobRuntimeCleanupTarget[] }
  | { kind: "tenant_voice_review"; requestId: string; request: CodexVoiceReviewRequest }
  | { kind: "tenant_title_agent"; requestId: string; request: ConversationTitleAgentRequest };

export type SupervisorToWebMessage =
  | { kind: "tenant_event"; jobId: string; event: TenantWorkerEvent }
  | { kind: "tenant_worker_exit"; jobId: string; message: string }
  | {
    kind: "tenant_runtime_cleanup_result";
    requestId: string;
    removed: number;
    absent: number;
    failed: Array<{ jobId: string; message: string }>;
  }
  | { kind: "tenant_voice_review_result"; requestId: string; output?: string; error?: string }
  | { kind: "tenant_title_agent_result"; requestId: string; output?: string; error?: string };

export type TenantWorkerInput =
  | { type: "run"; request: TenantWorkerRunRequest }
  | { type: "steer"; requestId: string; prompt: string; imagePaths: string[] }
  | { type: "cancel" };
