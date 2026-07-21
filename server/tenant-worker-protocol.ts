import type { AgentSelection } from "./model-options.js";
import type { OptionalAgentCapabilities } from "./optional-capabilities.js";

export type TenantWorkerRunRequest = {
  jobId: string;
  userId: string;
  conversationId: string;
  projectRoot: string;
  pythonRuntimeRoot: string;
  tenantRoot: string;
  workspace: string;
  runtimeRoot: string;
  codexHome: string;
  library: string;
  codexThreadId: string | null;
  effectivePrompt: string;
  imagePaths: string[];
  outputSchema?: Record<string, unknown>;
  selection: AgentSelection;
  networkAccessEnabled: boolean;
  webSearchMode: "cached" | "live";
  codexWindowsSandbox: "elevated" | "unelevated";
  optionalCapabilities: OptionalAgentCapabilities;
};

export type TenantWorkerEvent =
  | { type: "thread_started"; threadId: string }
  | { type: "progress"; payload: unknown }
  | { type: "steer_completed"; requestId: string; turnId: string }
  | { type: "steer_failed"; requestId: string; message: string }
  | { type: "completed"; finalResponse: string }
  | { type: "failed"; message: string; cancelled?: boolean };

export type WebToSupervisorMessage =
  | { kind: "tenant_run"; jobId: string; userId: string; request: TenantWorkerRunRequest }
  | { kind: "tenant_steer"; jobId: string; requestId: string; prompt: string; imagePaths: string[] }
  | { kind: "tenant_cancel"; jobId: string };

export type SupervisorToWebMessage =
  | { kind: "tenant_event"; jobId: string; event: TenantWorkerEvent }
  | { kind: "tenant_worker_exit"; jobId: string; message: string };

export type TenantWorkerInput =
  | { type: "run"; request: TenantWorkerRunRequest }
  | { type: "steer"; requestId: string; prompt: string; imagePaths: string[] }
  | { type: "cancel" };
