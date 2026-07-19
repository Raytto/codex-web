import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env") });

export type AppConfig = {
  host: string;
  port: number;
  basePath: string;
  username: string;
  displayName: string;
  passwordHash: string;
  sessionSecret: string;
  sessionTtlHours: number;
  projectRoot: string;
  dataRoot: string;
  workspaceRoot: string;
  tenantRoot: string;
  pythonRuntimeRoot: string;
  pythonVersion: string;
  codexWindowsSandbox: "elevated" | "unelevated";
  containerized: boolean;
  codexHome: string;
  codexModel?: string;
  queueAutoStart: boolean;
  tenantWorkerIsolation: boolean;
  publicBaseUrl: string;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  dashscopeModel: string;
  transcriptionPollMs: number;
  transcriptionTimeoutMs: number;
};

function normalizeBasePath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.PORT ?? 37821),
    basePath: overrides.basePath ?? normalizeBasePath(process.env.BASE_PATH ?? "/codex-web"),
    username: overrides.username ?? process.env.APP_USERNAME ?? "owner",
    displayName: overrides.displayName ?? process.env.APP_DISPLAY_NAME ?? "Owner",
    passwordHash: overrides.passwordHash ?? process.env.APP_PASSWORD_HASH ?? "",
    sessionSecret: overrides.sessionSecret ?? process.env.SESSION_SECRET ?? "",
    sessionTtlHours: overrides.sessionTtlHours ?? Number(process.env.SESSION_TTL_HOURS ?? 168),
    projectRoot,
    dataRoot: overrides.dataRoot ?? (process.env.DATA_ROOT || path.join(projectRoot, "data")),
    workspaceRoot: overrides.workspaceRoot ?? (process.env.WORKSPACE_ROOT || path.join(projectRoot, "workspaces")),
    tenantRoot: overrides.tenantRoot ?? (process.env.TENANT_ROOT || path.join(projectRoot, "tenants")),
    pythonRuntimeRoot: overrides.pythonRuntimeRoot ?? (process.env.PYTHON_RUNTIME_ROOT || path.join(projectRoot, "data", "python")),
    pythonVersion: overrides.pythonVersion ?? (process.env.PYTHON_VERSION || "3.12"),
    codexWindowsSandbox: overrides.codexWindowsSandbox ?? (process.env.CODEX_WINDOWS_SANDBOX === "unelevated" ? "unelevated" : "elevated"),
    containerized: overrides.containerized ?? process.env.CONTAINERIZED === "true",
    codexHome: overrides.codexHome ?? (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    codexModel: overrides.codexModel ?? (process.env.CODEX_MODEL || undefined),
    queueAutoStart: overrides.queueAutoStart ?? process.env.QUEUE_AUTO_START !== "false",
    tenantWorkerIsolation: overrides.tenantWorkerIsolation ?? process.env.TENANT_WORKER_ISOLATION === "true",
    publicBaseUrl: overrides.publicBaseUrl ?? (process.env.PUBLIC_BASE_URL || ""),
    dashscopeApiKey: overrides.dashscopeApiKey ?? (process.env.DASHSCOPE_API_KEY || ""),
    dashscopeBaseUrl: (overrides.dashscopeBaseUrl ?? process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, ""),
    dashscopeModel: overrides.dashscopeModel ?? (process.env.DASHSCOPE_ASR_MODEL || "qwen3.5-omni-plus"),
    transcriptionPollMs: overrides.transcriptionPollMs ?? Number(process.env.TRANSCRIPTION_POLL_MS ?? 2000),
    transcriptionTimeoutMs: overrides.transcriptionTimeoutMs ?? Number(process.env.TRANSCRIPTION_TIMEOUT_MS ?? 120000),
  };
}

export function assertProductionConfig(config: AppConfig): void {
  if (!config.passwordHash.startsWith("$2")) {
    throw new Error("APP_PASSWORD_HASH is missing or invalid");
  }
  if (config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  const loopback = config.host === "127.0.0.1" || config.host === "::1";
  const containerBind = config.containerized && config.host === "0.0.0.0";
  if (!loopback && !containerBind) {
    throw new Error("The service must bind to loopback, or 0.0.0.0 only inside the hardened container");
  }
}
