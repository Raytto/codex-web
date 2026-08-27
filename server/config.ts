import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import {
  READER_V1_MAX_CONCURRENT_READS,
  READER_V1_MAX_FILE_BYTES,
  READER_V1_MAX_RANGE_BYTES,
  READER_V1_RETENTION_DAYS,
} from "./reader-policy.js";

export {
  READER_V1_MAX_CONCURRENT_READS,
  READER_V1_MAX_FILE_BYTES,
  READER_V1_MAX_RANGE_BYTES,
  READER_V1_RETENTION_DAYS,
} from "./reader-policy.js";

dotenv.config({ path: path.join(process.cwd(), ".env") });

export type AppConfig = {
  host: string;
  port: number;
  basePath: string;
  username: string;
  passwordHash: string;
  deployStatusFile: string;
  sessionSecret: string;
  sessionTtlHours: number;
  projectRoot: string;
  dataRoot: string;
  tenantRoot: string;
  pythonRuntimeRoot: string;
  pythonVersion: string;
  codexWindowsSandbox: "elevated" | "unelevated";
  containerized: boolean;
  codexHome: string;
  codexModel?: string;
  queueAutoStart: boolean;
  maxGlobalRunningJobs: number;
  maxRunningJobsPerUser: number;
  maxRunningJobsPerExecutor: number;
  maxUploadFileBytes: number;
  maxStoredBytesPerUser: number;
  /** Online reader guardrails.  These are independent from attachment quota. */
  readerMaxFileBytes: number;
  readerMaxConcurrentReads: number;
  readerRangeMaxBytes: number;
  readerRetentionDays: number;
  minimumFreeDiskBytes: number;
  resumableUploadChunkBytes: number;
  resumableUploadExpiryHours: number;
  tenantWorkerIsolation: boolean;
  hostRootSocketPath: string;
  hostTenantRoot: string;
  hostKnowledgeRoot: string;
  hostRootCodexHome: string;
  remoteWorkerEnrollmentToken: string;
  remoteWorkerReleaseRoot: string;
  publicBaseUrl: string;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  dashscopeModel: string;
  personalMemoryApiKey: string;
  personalMemoryBaseUrl: string;
  personalMemoryModel: string;
  personalMemoryTimeoutMs: number;
  personalMemoryPollMs: number;
  personalMemoryDelayMs: number;
  personalMemoryBatchSize: number;
  transcriptionPollMs: number;
  transcriptionTimeoutMs: number;
  transcriptionContextTokenBudget: number;
  transcriptionContextMaxImages: number;
  transcriptionContextMaxImageBytes: number;
  voiceLexiconTimeoutMs: number;
  voiceLexiconPollMs: number;
  voiceLexiconDelayMs: number;
  voiceLexiconBatchThreshold: number;
  voiceLexiconBatchSize: number;
  voiceLexiconMaxTerms: number;
  voiceLexiconTokenBudget: number;
};

function normalizeBasePath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.PORT ?? 37821),
    basePath: overrides.basePath ?? normalizeBasePath(process.env.BASE_PATH ?? ""),
    username: overrides.username ?? process.env.APP_USERNAME ?? "owner",
    passwordHash: overrides.passwordHash ?? process.env.APP_PASSWORD_HASH ?? "",
    deployStatusFile: overrides.deployStatusFile ?? (process.env.CODEX_WEB_DEPLOY_STATUS_FILE || path.join(projectRoot, "deploy-status", "status.json")),
    sessionSecret: overrides.sessionSecret ?? process.env.SESSION_SECRET ?? "",
    sessionTtlHours: overrides.sessionTtlHours ?? Number(process.env.SESSION_TTL_HOURS ?? 336),
    projectRoot,
    dataRoot: overrides.dataRoot ?? (process.env.DATA_ROOT || path.join(projectRoot, "data")),
    tenantRoot: overrides.tenantRoot ?? (process.env.TENANT_ROOT || path.join(projectRoot, "tenants")),
    pythonRuntimeRoot: overrides.pythonRuntimeRoot ?? (process.env.PYTHON_RUNTIME_ROOT || path.join(projectRoot, "data", "python")),
    pythonVersion: overrides.pythonVersion ?? (process.env.PYTHON_VERSION || "3.12"),
    codexWindowsSandbox: overrides.codexWindowsSandbox ?? (process.env.CODEX_WINDOWS_SANDBOX === "unelevated" ? "unelevated" : "elevated"),
    containerized: overrides.containerized ?? process.env.CONTAINERIZED === "true",
    codexHome: overrides.codexHome ?? (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    codexModel: overrides.codexModel ?? (process.env.CODEX_MODEL || undefined),
    queueAutoStart: overrides.queueAutoStart ?? process.env.QUEUE_AUTO_START !== "false",
    maxGlobalRunningJobs: boundedInteger(overrides.maxGlobalRunningJobs ?? process.env.MAX_GLOBAL_RUNNING_JOBS, 8, 1, 64),
    maxRunningJobsPerUser: boundedInteger(overrides.maxRunningJobsPerUser ?? process.env.MAX_RUNNING_JOBS_PER_USER, 3, 1, 32),
    maxRunningJobsPerExecutor: boundedInteger(overrides.maxRunningJobsPerExecutor ?? process.env.MAX_RUNNING_JOBS_PER_EXECUTOR, 4, 1, 32),
    maxUploadFileBytes: boundedInteger(overrides.maxUploadFileBytes ?? process.env.MAX_UPLOAD_FILE_BYTES, 2 * 1024 * 1024 * 1024, 1 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
    maxStoredBytesPerUser: boundedInteger(overrides.maxStoredBytesPerUser ?? process.env.MAX_STORED_BYTES_PER_USER, 20 * 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
    readerMaxFileBytes: boundedInteger(overrides.readerMaxFileBytes ?? process.env.READER_MAX_FILE_BYTES, READER_V1_MAX_FILE_BYTES, 1 * 1024 * 1024, READER_V1_MAX_FILE_BYTES),
    readerMaxConcurrentReads: boundedInteger(overrides.readerMaxConcurrentReads ?? process.env.READER_MAX_CONCURRENT_READS, READER_V1_MAX_CONCURRENT_READS, 1, READER_V1_MAX_CONCURRENT_READS),
    readerRangeMaxBytes: boundedInteger(overrides.readerRangeMaxBytes ?? process.env.READER_RANGE_MAX_BYTES, READER_V1_MAX_RANGE_BYTES, 64 * 1024, READER_V1_MAX_RANGE_BYTES),
    readerRetentionDays: boundedInteger(overrides.readerRetentionDays ?? process.env.READER_RETENTION_DAYS, READER_V1_RETENTION_DAYS, 1, READER_V1_RETENTION_DAYS),
    minimumFreeDiskBytes: boundedInteger(overrides.minimumFreeDiskBytes ?? process.env.MINIMUM_FREE_DISK_BYTES, 2 * 1024 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER),
    resumableUploadChunkBytes: boundedInteger(overrides.resumableUploadChunkBytes ?? process.env.RESUMABLE_UPLOAD_CHUNK_BYTES, 8 * 1024 * 1024, 1 * 1024 * 1024, 32 * 1024 * 1024),
    resumableUploadExpiryHours: boundedInteger(overrides.resumableUploadExpiryHours ?? process.env.RESUMABLE_UPLOAD_EXPIRY_HOURS, 72, 1, 24 * 30),
    tenantWorkerIsolation: overrides.tenantWorkerIsolation ?? process.env.TENANT_WORKER_ISOLATION === "true",
    hostRootSocketPath: overrides.hostRootSocketPath ?? (process.env.CODEX_WEB_HOST_SOCKET_PATH || ""),
    hostTenantRoot: overrides.hostTenantRoot ?? (process.env.CODEX_WEB_HOST_TENANT_ROOT || path.join(projectRoot, "host", "tenants")),
    hostKnowledgeRoot: overrides.hostKnowledgeRoot ?? (process.env.CODEX_WEB_KNOWLEDGE_ROOT || path.join(projectRoot, "host", "knowledge")),
    hostRootCodexHome: overrides.hostRootCodexHome ?? (process.env.CODEX_WEB_CODEX_HOME || path.join(projectRoot, "host", "codex-home")),
    remoteWorkerEnrollmentToken: overrides.remoteWorkerEnrollmentToken ?? (process.env.REMOTE_WORKER_ENROLLMENT_TOKEN || ""),
    remoteWorkerReleaseRoot: overrides.remoteWorkerReleaseRoot ?? (process.env.REMOTE_WORKER_RELEASE_ROOT || path.join(projectRoot, "worker-release")),
    publicBaseUrl: overrides.publicBaseUrl ?? (process.env.PUBLIC_BASE_URL || ""),
    dashscopeApiKey: overrides.dashscopeApiKey ?? (process.env.DASHSCOPE_API_KEY || ""),
    dashscopeBaseUrl: (overrides.dashscopeBaseUrl ?? process.env.DASHSCOPE_BASE_URL ?? "").replace(/\/$/, ""),
    dashscopeModel: overrides.dashscopeModel ?? (process.env.DASHSCOPE_ASR_MODEL || "qwen3.5-omni-plus"),
    personalMemoryApiKey: overrides.personalMemoryApiKey ?? (process.env.PERSONAL_MEMORY_API_KEY || ""),
    personalMemoryBaseUrl: (overrides.personalMemoryBaseUrl ?? process.env.PERSONAL_MEMORY_BASE_URL ?? "").replace(/\/$/, ""),
    personalMemoryModel: overrides.personalMemoryModel ?? (process.env.PERSONAL_MEMORY_MODEL || "memory-model"),
    personalMemoryTimeoutMs: boundedInteger(overrides.personalMemoryTimeoutMs ?? process.env.PERSONAL_MEMORY_TIMEOUT_MS, 30_000, 5_000, 120_000),
    personalMemoryPollMs: boundedInteger(overrides.personalMemoryPollMs ?? process.env.PERSONAL_MEMORY_POLL_MS, 60_000, 5_000, 60 * 60_000),
    personalMemoryDelayMs: boundedInteger(overrides.personalMemoryDelayMs ?? process.env.PERSONAL_MEMORY_DELAY_MS, 120_000, 0, 24 * 60 * 60_000),
    personalMemoryBatchSize: boundedInteger(overrides.personalMemoryBatchSize ?? process.env.PERSONAL_MEMORY_BATCH_SIZE, 12, 1, 50),
    transcriptionPollMs: overrides.transcriptionPollMs ?? Number(process.env.TRANSCRIPTION_POLL_MS ?? 2000),
    transcriptionTimeoutMs: overrides.transcriptionTimeoutMs ?? Number(process.env.TRANSCRIPTION_TIMEOUT_MS ?? 120000),
    transcriptionContextTokenBudget: boundedInteger(
      overrides.transcriptionContextTokenBudget ?? process.env.TRANSCRIPTION_CONTEXT_TOKEN_BUDGET,
      500, 100, 4000,
    ),
    transcriptionContextMaxImages: boundedInteger(
      overrides.transcriptionContextMaxImages ?? process.env.TRANSCRIPTION_CONTEXT_MAX_IMAGES,
      2, 0, 4,
    ),
    transcriptionContextMaxImageBytes: boundedInteger(
      overrides.transcriptionContextMaxImageBytes ?? process.env.TRANSCRIPTION_CONTEXT_MAX_IMAGE_BYTES,
      2 * 1024 * 1024, 64 * 1024, 7 * 1024 * 1024,
    ),
    voiceLexiconTimeoutMs: boundedInteger(overrides.voiceLexiconTimeoutMs ?? process.env.VOICE_LEXICON_TIMEOUT_MS, 180_000, 30_000, 10 * 60_000),
    voiceLexiconPollMs: boundedInteger(overrides.voiceLexiconPollMs ?? process.env.VOICE_LEXICON_POLL_MS, 60_000, 5_000, 60 * 60_000),
    voiceLexiconDelayMs: boundedInteger(overrides.voiceLexiconDelayMs ?? process.env.VOICE_LEXICON_DELAY_MS, 3 * 60 * 60_000, 5 * 60_000, 24 * 60 * 60_000),
    voiceLexiconBatchThreshold: boundedInteger(overrides.voiceLexiconBatchThreshold ?? process.env.VOICE_LEXICON_BATCH_THRESHOLD, 20, 2, 100),
    voiceLexiconBatchSize: boundedInteger(overrides.voiceLexiconBatchSize ?? process.env.VOICE_LEXICON_BATCH_SIZE, 20, 1, 50),
    voiceLexiconMaxTerms: boundedInteger(overrides.voiceLexiconMaxTerms ?? process.env.TRANSCRIPTION_LEXICON_MAX_TERMS, 100, 1, 100),
    voiceLexiconTokenBudget: boundedInteger(overrides.voiceLexiconTokenBudget ?? process.env.TRANSCRIPTION_LEXICON_TOKEN_BUDGET, 1600, 100, 8000),
  };
}

export function assertProductionConfig(config: AppConfig): void {
  if (!config.passwordHash.startsWith("$2")) {
    throw new Error("APP_PASSWORD_HASH is missing or invalid");
  }
  if (config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  if (config.remoteWorkerEnrollmentToken && config.remoteWorkerEnrollmentToken.length < 32) {
    throw new Error("REMOTE_WORKER_ENROLLMENT_TOKEN must contain at least 32 characters when configured");
  }
  const loopback = config.host === "127.0.0.1" || config.host === "::1";
  const containerBind = config.containerized && config.host === "0.0.0.0";
  if (!loopback && !containerBind) {
    throw new Error("The service must bind to loopback, or 0.0.0.0 only inside the hardened container");
  }
}

/** Validate the complete production configuration before callers create directories or open SQLite. */
export function loadProductionConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config = loadConfig(overrides);
  assertProductionConfig(config);
  return config;
}
