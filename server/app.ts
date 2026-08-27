import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { loadConfig, type AppConfig } from "./config.js";
import { CodexRunner, extractLeakedAutoTitleAnswer } from "./codex-runner.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection } from "../src/ask-agent-selection.js";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { parseCodexFileMentionRequest } from "../src/codex-file-mentions.js";
import { AppDatabase, StorageQuotaExceededError, type ComposerDraftWithFiles, type ConversationRow, type FileRow, type JobRow, type MessageRow, type PendingPromptWithFiles, type PersonalMemoryReviewAction, type ProjectRow, type SessionRow, type UserRow, type WakeEventKind, type WakePlanMode, type WakePlanRow } from "./db.js";
import { loadAgentOptions, repairAgentSelection, resolveAgentSelection, type AgentOptions, type AgentSelection } from "./model-options.js";
import { ensureTenant, ensureTenantWorkspace, isPersistedDeliverablePath, newId, persistDeliverableSync, removeCodexThreadFiles, removePersistedDeliverable, removeWorkspace, resolveInside, safeUploadName } from "./paths.js";
import { AUDIO_MIME_EXTENSIONS, TranscriptionError, TranscriptionService } from "./transcription.js";
import { CONVERSATION_TITLE_CODEX_MODEL, CONVERSATION_TITLE_PROMPT_VERSION, CONVERSATION_TITLE_REASONING_EFFORT, ConversationTitleService, extractTitleRequestText } from "./conversation-title.js";
import { HOST_ROOT_USER_ID, isHostRootUser } from "./host-root-user.js";
import { DEFAULT_PROJECT_AGENTS_TEMPLATE, PROJECT_AGENTS_TEMPLATE_SETTING } from "./project-instructions.js";
import { buildUserCancellationSummary } from "./cancellation-summary.js";
import { RemoteWorkerGateway, type ExecutorView } from "./remote-worker-gateway.js";
import { HOST_EXECUTOR_ID, workerIdFromExecutor } from "./remote-worker-protocol.js";
import { hashWakeEventToken, readBearerToken, verifyJobAutomationToken } from "./wake-automation.js";
import { parseRemoteContentLength, RemoteTransferError, streamRemoteUpload } from "./remote-transfer.js";
import { cleanupOwnedStagingDirectory } from "./owned-staging.js";
import { sweepUploadOrphans, uploadOwnershipKey } from "./upload-orphans.js";
import { ResumableUploadService } from "./resumable-upload.js";
import { ImageThumbnailService } from "./image-thumbnail.js";
import { PublicShareAssetError, isPublicShareImage, publicShareDocumentKind, resolvePublicShareAssets, rewritePublicShareDocument } from "./public-file-share.js";
import { TENANT_LOCAL_EXECUTOR_ID, assertTenantProjectRoot, ensureTenantProjectLayout } from "./tenant-projects.js";
import { createProjectSkill, deleteProjectSkill, listProjectSkills, readProjectSkill, setProjectSkillEnabled, updateProjectSkill } from "./project-skills.js";
import { containsPersonalContext } from "./personal-context.js";
import { PersonalMemoryService } from "./personal-memory.js";
import { ensurePersonalMemoryLibrary, isPersonalMemoryEditableFileName, personalMemoryEnabled, readPersonalMemoryManagedFiles, writePersonalMemoryManagedFile } from "./personal-memory-files.js";
import { formatVoiceLexiconTerms, VoiceLexiconService } from "./voice-lexicon.js";
import { persistVoiceRecording, removePersistedVoiceRecording, sha256File, type PersistedVoiceRecording } from "./voice-recording.js";
import { VOICE_LEXICON_CODEX_MODEL } from "./codex-voice-review.js";
import { bootstrapScript, type RemoteWorkerBootstrapPlatform } from "./remote-worker-bootstrap.js";
import { ReaderIngestError } from "./reader-ingest.js";
import { parseReaderRange, ReaderRangeError } from "./reader-range.js";
import { ReaderService, ReaderUnavailableError } from "./reader-service.js";
import type { ReadingAnnotationType } from "./reader-types.js";

const COOKIE_NAME = "cww_session";
// Keep unknown-user login work comparable without using any real account hash.
const DUMMY_PASSWORD_HASH = "$2b$12$3GJ6fV5pZgwKqptJCLdFg.f3pVLsyOugC100TH0YpmvlfA3brYgDe";
const CONVERSATION_MESSAGE_PAGE_SIZE = 30;
const FILE_INSTRUCTION_GUIDANCE = "文件已上传，请输入具体操作，例如“把图片背景改为白色”或“汇总这些表格”。收到明确指令后才会开始处理。";
const PUBLIC_FILE_READER_MAX_BYTES = 5 * 1024 * 1024;
type AuthenticatedRequest = Request & { appSession?: SessionRow; requestId?: string };

function conversationMessagePageSize(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : CONVERSATION_MESSAGE_PAGE_SIZE;
}

function conversationTitleAuditError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out") || message.includes("超时")) return "timeout";
  if (message.includes("offline") || message.includes("离线")) return "executor_offline";
  if (message.includes("尚未支持") || message.includes("upgrade worker")) return "worker_upgrade_required";
  if (message === "invalid_output" || message.includes("invalid output")) return "invalid_output";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "generation_failed";
}

function conversationTitleAuditExcerpt(value: string): string {
  return value.slice(0, 500)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|token|cookie|secret|api[ _-]?key|authorization|密码|口令|私钥|验证码)\s*[=:：]\s*)\S+/gi, "$1[REDACTED]");
}

function projectDirectoryName(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? rootPath;
}

export function projectDisplayName(name: string, executor: Pick<ExecutorView, "kind" | "machineName"> | undefined): string {
  return executor?.kind === "remote_worker" ? `[${executor.machineName}]${name}` : name;
}

export function createApp(overrides: Partial<AppConfig> = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataRoot, { recursive: true });
  fs.mkdirSync(config.tenantRoot, { recursive: true });
  const db = new AppDatabase(config.dataRoot, { username: config.username, passwordHash: config.passwordHash, displayName: "Codex" });
  db.recoverVoiceTranscriptionReceipts();
  const remoteWorkers = new RemoteWorkerGateway(config, db);
  function tenantExecutorView(): ExecutorView {
    return {
      id: TENANT_LOCAL_EXECUTOR_ID,
      machineName: "个人受限工作区",
      kind: "tenant_container",
      status: "online",
      platform: "linux",
      capacity: 0,
      activeJobs: db.countRunningJobsForExecutor(TENANT_LOCAL_EXECUTOR_ID),
      lastSeenAt: null,
      runtime: null,
      securityBoundary: {
        mode: "workspace_write",
        label: "个人容器受限目录",
        description: "只能访问当前账号的项目与独立会话文件，不能访问宿主、其他账号或远程机器。",
      },
      retryCapability: { transparentBeforeStart: true, replayAfterStart: false, idempotencyReceipts: false },
      codexAccountManagementCapable: false,
      worker: null,
    };
  }
  function executorView(executorId: string): ExecutorView | undefined {
    return executorId === TENANT_LOCAL_EXECUTOR_ID ? tenantExecutorView() : remoteWorkers.executor(executorId);
  }
  function projectView<T extends ProjectRow>(project: T) {
    const executor = executorView(project.executor_id);
    return {
      ...project,
      machine_name: executor?.machineName ?? "未知机器",
      executor_status: executor?.status ?? "offline",
      executor_last_seen_at: executor?.lastSeenAt ?? null,
      display_name: projectDisplayName(project.name, executor),
    };
  }
  const projectAgentsTemplate = db.ensureAppSetting(PROJECT_AGENTS_TEMPLATE_SETTING, DEFAULT_PROJECT_AGENTS_TEMPLATE);
  function ensureUserDefaultProject(userId: string) {
    const user = db.getUser(userId);
    if (!user) throw new Error("用户不存在");
    const tenant = ensureTenant(config.tenantRoot, user.id);
    const hostRoot = isHostRootUser(user.id);
    const rootPath = hostRoot ? config.hostKnowledgeRoot : ensureTenantProjectLayout(tenant);
    ensurePersonalMemoryLibrary(tenant.library, user.username);
    return db.ensureDefaultProject(
      newId(),
      user.id,
      hostRoot ? "host-project" : "默认项目",
      rootPath,
      hostRoot ? HOST_EXECUTOR_ID : TENANT_LOCAL_EXECUTOR_ID,
    );
  }
  for (const user of db.listUsers()) ensureUserDefaultProject(user.id);
  migrateExistingOutputFiles(config, db);
  const subscribers = new Map<string, Set<Response>>();
  let shuttingDown = false;

  function optionsForUser(userId: string): AgentOptions {
    return loadAgentOptions(config, ensureTenant(config.tenantRoot, userId).codexHome);
  }

  function optionsForExecutor(userId: string, executorId?: string | null): AgentOptions {
    if (!isHostRootUser(userId) || !executorId) return optionsForUser(userId);
    return db.getExecutorRuntime(executorId)?.agentOptions ?? optionsForUser(userId);
  }

  function optionsForConversation(conversation: ConversationRow): AgentOptions {
    const project = conversation.project_id ? db.getProjectForUser(conversation.project_id, conversation.user_id) : undefined;
    return optionsForExecutor(conversation.user_id, project?.executor_id);
  }

  function userAgentSelection(userId: string, options: AgentOptions = optionsForUser(userId)): AgentSelection {
    const stored = db.getAgentSelectionPreference(userId);
    const selection = repairAgentSelection(options, stored?.model, stored?.reasoningEffort);
    if (!stored || stored.model !== selection.model || stored.reasoningEffort !== selection.reasoningEffort) {
      db.setAgentSelectionPreference(selection, userId);
    }
    return selection;
  }

  function conversationAgentSelection(conversation: ConversationRow, options: AgentOptions = optionsForConversation(conversation)): AgentSelection {
    const fallback = conversation.agent_model && conversation.reasoning_effort
      ? { model: conversation.agent_model, reasoningEffort: conversation.reasoning_effort }
      : userAgentSelection(conversation.user_id, options);
    const selection = repairAgentSelection(options, fallback.model, fallback.reasoningEffort);
    if (conversation.agent_model !== selection.model || conversation.reasoning_effort !== selection.reasoningEffort) {
      db.updateConversation(conversation.id, { agentSelection: selection });
    }
    return selection;
  }

  function safeConversationMessages(conversation: ConversationRow, messages: Array<MessageRow & { files: FileRow[] }>) {
    const citationFiles = db.listFiles(conversation.id);
    return messages.map((message) => {
      if (message.role === "user") {
        const parsed = parseCodexFileMentionRequest(message.content);
        return {
          ...message,
          content: parsed?.content ?? message.content,
          attachment_references: parsed?.fileNames ?? [],
        };
      }
      if (message.role !== "assistant") return { ...message, attachment_references: [] };
      const visibleContent = conversation.title_source === "ai"
        ? extractLeakedAutoTitleAnswer(message.content, true) ?? message.content
        : message.content;
      return { ...message, content: sanitizeAgentMarkdown(visibleContent, citationFiles), attachment_references: [] };
    });
  }

  function saveAgentSelection(userId: string, rawModel: unknown, rawEffort: unknown, conversation?: ConversationRow, executorId?: string): AgentSelection {
    const selection = resolveAgentSelection(conversation ? optionsForConversation(conversation) : optionsForExecutor(userId, executorId), rawModel, rawEffort);
    db.setAgentSelectionPreference(selection, userId);
    if (conversation) db.updateConversation(conversation.id, { agentSelection: selection });
    return selection;
  }

  for (const user of db.listUsers()) userAgentSelection(user.id);
  for (const conversation of db.listConversations()) {
    if (conversation.agent_model || conversation.reasoning_effort) conversationAgentSelection(conversation);
  }

  function publish(jobId: string, eventType: string, payload: unknown): void {
    // Personal context is an internal model input. Never persist or stream a
    // reasoning/progress echo of it into the visible Codex Web conversation.
    if (containsPersonalContext(payload)) return;
    const seq = db.appendEvent(jobId, eventType, payload);
    const livePayload = {
      ...(payload && typeof payload === "object" ? payload : { payload }),
      created_at: new Date().toISOString(),
    };
    for (const response of subscribers.get(jobId) ?? []) writeSse(response, seq, eventType, livePayload);
    if (["done", "failed"].includes(eventType)) {
      setTimeout(() => {
        for (const response of subscribers.get(jobId) ?? []) response.end();
        subscribers.delete(jobId);
      }, 100);
    }
  }

  const runner = new CodexRunner(config, db, publish, remoteWorkers);
  const restoringConversations = new Map<string, Promise<void>>();
  function scheduleColdRestore(conversationId: string, userId: string): void {
    if (restoringConversations.has(conversationId)) return;
    const task = runner.restoreColdConversation(userId, conversationId).catch((error) => {
      console.error(JSON.stringify({ event: "conversation_cold_restore_failed", conversationId, message: error instanceof Error ? error.message : String(error) }));
    }).finally(() => {
      restoringConversations.delete(conversationId);
      const refreshed = db.getConversation(conversationId);
      if (refreshed) publishConversationChanged(refreshed);
      publishQueuePositions();
    });
    restoringConversations.set(conversationId, task);
  }
  function activateConversation(conversation: ConversationRow): { conversation: ConversationRow; state: "local" | "restoring" | "error" } {
    const storage = db.getConversationStorage(conversation.id);
    if (!storage || storage.state === "local") {
      db.touchConversationActivity(conversation.id);
      return { conversation: db.getConversation(conversation.id) ?? conversation, state: "local" };
    }
    if (["cold", "error"].includes(storage.state)) {
      const next = db.transitionConversationStorage(conversation.id, [storage.state], "restoring", "user_open_restore", { last_error: null });
      if (next) {
        const refreshed = db.getConversation(conversation.id) ?? conversation;
        publishConversationChanged(refreshed);
        scheduleColdRestore(conversation.id, conversation.user_id);
        return { conversation: refreshed, state: "restoring" };
      }
      return { conversation: db.getConversation(conversation.id) ?? conversation, state: "restoring" };
    }
    if (storage.state === "restoring") {
      scheduleColdRestore(conversation.id, conversation.user_id);
      return { conversation, state: "restoring" };
    }
    return { conversation, state: "error" };
  }
  for (const storage of db.listConversationStorageByState("restoring")) {
    const conversation = db.getConversation(storage.conversation_id);
    if (conversation) scheduleColdRestore(conversation.id, conversation.user_id);
  }
  const hostRootUser = db.listUsers().find((user) => isHostRootUser(user.id));
  if (hostRootUser) {
    void runner.refreshExecutorRuntime(hostRootUser.id, HOST_EXECUTOR_ID, true)
      .then((runtime) => { db.upsertExecutorRuntime(HOST_EXECUTOR_ID, runtime); remoteWorkers.emit("status", HOST_EXECUTOR_ID); })
      .catch(() => undefined);
  }
  const transcription = new TranscriptionService(config);
  const voiceTranscriptionInFlight = new Map<string, Promise<{ text: string; transcriptionId: string }>>();
  const conversationTitles = new ConversationTitleService((userId, executorId, prompt, timeoutMs) => runner.generateConversationTitle(userId, executorId, prompt, timeoutMs));
  const personalMemory = new PersonalMemoryService(config, db);
  const personalMemoryManagementPayload = (userId: string) => {
    const tenant = ensureTenant(config.tenantRoot, userId);
    const enabled = personalMemoryEnabled(tenant.library);
    const entries = db.listPersonalMemoryEntries(userId).map((entry) => ({
      ...entry,
      evidence: db.listPersonalMemoryEvidence(userId, entry.id),
    }));
    return {
      enabled,
      configured: Boolean(config.personalMemoryApiKey && config.personalMemoryBaseUrl),
      ...db.getPersonalMemoryStatus(userId),
      entries,
      files: enabled ? readPersonalMemoryManagedFiles(tenant.library) : [],
    };
  };
  const voiceLexiconManagementPayload = (userId: string) => {
    const terms = db.listVoiceLexiconManagementTerms(userId);
    const serializeTerm = (term: (typeof terms)[number]) => {
      const { user_id: _userId, aliases_json: aliasesJson, ...visible } = term;
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(aliasesJson) as unknown;
        if (Array.isArray(parsed)) aliases = parsed.filter((value): value is string => typeof value === "string").slice(0, 12);
      } catch {}
      return { ...visible, pinned: Boolean(term.pinned), aliases };
    };
    const activeTerms = terms.filter((term) => term.status === "active");
    const candidateTerms = terms.filter((term) => term.status === "candidate" || term.status === "conflicted");
    return {
      model: VOICE_LEXICON_CODEX_MODEL,
      maxSelectedTerms: config.voiceLexiconMaxTerms,
      tokenBudget: config.voiceLexiconTokenBudget,
      batchThreshold: config.voiceLexiconBatchThreshold,
      delayMs: config.voiceLexiconDelayMs,
      activeCount: activeTerms.length,
      candidateCount: candidateTerms.length,
      conflictedCount: candidateTerms.filter((term) => term.status === "conflicted").length,
      suppressedCount: terms.filter((term) => term.status === "suppressed").length,
      ...db.getVoiceLexiconManagementStats(userId),
      lastRun: db.getLatestVoiceLexiconRun(userId),
      selectedTerms: activeTerms.slice(0, config.voiceLexiconMaxTerms).map(serializeTerm),
      candidateTerms: candidateTerms.map(serializeTerm),
    };
  };
  const voiceLexicon = new VoiceLexiconService(
    config,
    db,
    (userId, prompt, timeoutMs) => runner.reviewVoiceLexicon(userId, prompt, timeoutMs),
  );
  const titleRequests = new Map<string, Promise<void>>();
  const deletingConversations = new Set<string>();
  const syncingProjects = new Set<string>();
  const codexUpdateMaintenanceFile = path.join(config.dataRoot, ".codex-update-maintenance");
  type MaintenancePhase = "idle" | "preparing" | "active";
  type MaintenanceWaitStatus = {
    runningJobs: number;
    taskTitle: string | null;
    lastActivityAt: string | null;
    stalled: boolean;
  };
  type DeploymentPhase = "idle" | "queued" | "building" | "candidate_ready" | "waiting_for_jobs" | "promoting" | "health_check" | "deployed" | "superseded" | "conflict" | "deferred" | "failed";
  type DeploymentStatus = {
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
  const deploymentPhases = new Set<DeploymentPhase>([
    "idle", "queued", "building", "candidate_ready", "waiting_for_jobs", "promoting", "health_check",
    "deployed", "superseded", "conflict", "deferred", "failed",
  ]);
  const maintenanceQueueGuidance = {
    preparing: "系统正在准备维护，任务已保存到等待队列，维护完成后将自动开始。",
    active: "系统正在维护，任务已保存到等待队列，维护完成后将自动开始。",
  } as const;
  const serverInstanceId = crypto.randomUUID();
  const imageThumbnails = new ImageThumbnailService();
  const systemSubscribers = new Map<Response, string>();
  let systemStatusSequence = 0;
  let systemStatusTimer: ReturnType<typeof setInterval> | undefined;
  let lastPublishedSystemStatus = JSON.stringify(systemStatusPayload(HOST_ROOT_USER_ID));
  let queuePumpBusy = false;
  let maintenanceQueueWaiting = false;
  let maintenanceQueueWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeSchedulerBusy = false;
  let wakeSchedulerTimer: ReturnType<typeof setInterval> | undefined;
  const backgroundTasks = new Set<Promise<void>>();
  const backgroundImmediates = new Set<NodeJS.Immediate>();

  function resolveFilePath(file: FileRow, userId: string): string {
    const workspace = ensureTenantWorkspace(config.tenantRoot, userId, file.conversation_id);
    const storageRoot = file.kind === "output" && isPersistedDeliverablePath(file.relative_path) ? config.dataRoot : workspace;
    return resolveInside(storageRoot, file.relative_path);
  }

  function resolveExistingFilePath(file: FileRow, userId: string): string {
    // Reader probes must not recreate a conversation workspace that has been
    // moved to cold storage.  The normal resolver remains intentionally
    // creating for upload/task paths elsewhere in the application.
    const workspace = path.resolve(config.tenantRoot, userId, "conversations", file.conversation_id);
    const storageRoot = file.kind === "output" && isPersistedDeliverablePath(file.relative_path) ? config.dataRoot : workspace;
    return resolveInside(storageRoot, file.relative_path);
  }

  const reader = new ReaderService({
    db, config, resolveFilePath, resolveExistingFilePath,
    ensureFileAvailable: (file, userId) => {
      const conversation = db.getConversationForUser(file.conversation_id, userId);
      if (!conversation) return "missing";
      return activateConversation(conversation).state;
    },
  });

  function publicPreviewPath(fileId: string): string {
    return `${config.basePath}/files/${encodeURIComponent(fileId)}/preview/public`;
  }

  function publicOrigin(req: Request): string {
    const configured = config.publicBaseUrl.replace(/\/$/, "");
    if (configured) return configured;
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    return `${forwardedProto || req.protocol}://${req.get("host")}`;
  }

  function publicPreviewUrl(req: Request, fileId: string): string {
    return `${publicOrigin(req)}${publicPreviewPath(fileId)}`;
  }

  function publicShareState(req: Request, fileId: string) {
    return { enabled: Boolean(db.getPublicFileShare(fileId)?.enabled), publicUrl: publicPreviewUrl(req, fileId) };
  }

  function publicResponseHeaders(res: Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  function activePublicDocument(fileId: string) {
    const active = db.getActivePublicFile(fileId);
    if (!active || !isPersistedDeliverablePath(active.file.relative_path)) return undefined;
    const kind = publicShareDocumentKind(active.file);
    if (!kind || active.file.size > PUBLIC_FILE_READER_MAX_BYTES) return undefined;
    let absolute: string;
    try { absolute = resolveFilePath(active.file, active.share.user_id); }
    catch { return undefined; }
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size !== active.file.size || stat.size > PUBLIC_FILE_READER_MAX_BYTES) return undefined;
    } catch { return undefined; }
    return { ...active, kind, absolute };
  }

  function normalizedPublicIp(req: Request): string {
    const value = String(req.ip || req.socket.remoteAddress || "unknown").trim();
    return value.startsWith("::ffff:") ? value.slice(7) : value.slice(0, 64) || "unknown";
  }

  function trackBackground(label: string, task: Promise<void>): void {
    let tracked: Promise<void>;
    tracked = task.catch((error) => {
      console.error(JSON.stringify({
        level: "error", event: "background_task_failed", task: label,
        message: redactInternalError(error instanceof Error ? error.message : String(error)),
      }));
    }).finally(() => backgroundTasks.delete(tracked));
    backgroundTasks.add(tracked);
  }

  function scheduleBackground(label: string, task: () => Promise<void>): void {
    if (shuttingDown) return;
    const immediate = setImmediate(() => {
      backgroundImmediates.delete(immediate);
      if (!shuttingDown) trackBackground(label, task());
    });
    backgroundImmediates.add(immediate);
  }

  function scheduleQueuePump(): void {
    scheduleBackground("queue_pump", pumpQueue);
  }

  async function waitForBackgroundTasks(): Promise<void> {
    while (backgroundTasks.size > 0) await Promise.allSettled([...backgroundTasks]);
    await reader.waitForBackgroundTasks();
  }

  function codexUpdateMaintenancePhase(): MaintenancePhase {
    try {
      return fs.readFileSync(codexUpdateMaintenanceFile, "utf8").trim() === "preparing" ? "preparing" : "active";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "idle" : "active";
    }
  }

  function codexUpdateMaintenanceActive(): boolean {
    return codexUpdateMaintenancePhase() !== "idle";
  }

  function deploymentStatus(): DeploymentStatus | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(config.deployStatusFile, "utf8"));
      if (!value || typeof value !== "object") return null;
      const candidate = value as Record<string, unknown>;
      const phase = typeof candidate.phase === "string" && deploymentPhases.has(candidate.phase as DeploymentPhase)
        ? candidate.phase as DeploymentPhase : "idle";
      if (phase === "idle") return null;
      return {
        requestId: typeof candidate.requestId === "number" ? candidate.requestId : null,
        targetSha: typeof candidate.targetSha === "string" ? candidate.targetSha.slice(0, 64) : null,
        status: typeof candidate.status === "string" ? candidate.status.slice(0, 32) : "unknown",
        phase,
        message: typeof candidate.message === "string" ? candidate.message.slice(0, 300) : "发布状态已更新。",
        requestedAt: typeof candidate.requestedAt === "string" ? candidate.requestedAt : undefined,
        startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : null,
        finishedAt: typeof candidate.finishedAt === "string" ? candidate.finishedAt : null,
        errorCode: typeof candidate.errorCode === "number" ? candidate.errorCode : null,
        errorSummary: typeof candidate.errorSummary === "string" ? candidate.errorSummary.slice(0, 300) : null,
        phaseHistory: Array.isArray(candidate.phaseHistory) ? candidate.phaseHistory.slice(-32).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const value = entry as Record<string, unknown>;
          return typeof value.phase === "string" && deploymentPhases.has(value.phase as DeploymentPhase) && typeof value.at === "string"
            ? [{ phase: value.phase as DeploymentPhase, at: value.at }] : [];
        }) : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(JSON.stringify({ level: "warn", event: "deployment_status_unavailable", message: "发布状态文件暂时不可读。" }));
      }
      return null;
    }
  }

  function maintenanceQueueMetadata(): { maintenance: boolean; maintenancePhase: MaintenancePhase; guidance?: string } {
    const maintenancePhase = codexUpdateMaintenancePhase();
    return maintenancePhase !== "idle"
      ? { maintenance: true, maintenancePhase, guidance: maintenanceQueueGuidance[maintenancePhase] }
      : { maintenance: false, maintenancePhase };
  }

  function systemStatusPayload(userId?: string): { instanceId: string; maintenance: boolean; maintenancePhase: MaintenancePhase; message: string | null; maintenanceWait: MaintenanceWaitStatus | null; deployment: DeploymentStatus | null } {
    const maintenancePhase = codexUpdateMaintenancePhase();
    const running = maintenancePhase === "preparing" ? db.listRunningJobSummaries() : [];
    const lastActivityAt = running.reduce<string | null>((latest, job) => !latest || job.updated_at > latest ? job.updated_at : latest, null);
    const stalled = Boolean(lastActivityAt && Date.now() - Date.parse(lastActivityAt) >= 5 * 60_000);
    const taskTitle = isHostRootUser(userId ?? "") && running.length === 1 ? running[0].title : null;
    const maintenanceWait: MaintenanceWaitStatus | null = maintenancePhase === "preparing" ? {
      runningJobs: running.length, taskTitle, lastActivityAt, stalled,
    } : null;
    const waitingDescription = running.length === 1 && taskTitle
      ? `等待“${taskTitle}”完成`
      : running.length > 0 ? `等待 ${running.length} 个当前任务完成` : "正在进入维护";
    return {
      instanceId: serverInstanceId,
      maintenance: maintenancePhase !== "idle",
      maintenancePhase,
      message: maintenancePhase === "preparing"
        ? `Codex Web 正在准备维护，${waitingDescription}。${stalled ? "最后进度已超过 5 分钟，任务可能停滞。" : "新的任务已安全排队。"}`
        : maintenancePhase === "active" ? "Codex Web 正在维护，已提交的任务会安全排队并在维护结束后继续。" : null,
      maintenanceWait,
      deployment: deploymentStatus(),
    };
  }

  function pollSystemStatus(): void {
    const signature = JSON.stringify(systemStatusPayload(HOST_ROOT_USER_ID));
    if (signature === lastPublishedSystemStatus) return;
    lastPublishedSystemStatus = signature;
    systemStatusSequence += 1;
    for (const [response, userId] of systemSubscribers) writeSse(response, systemStatusSequence, "system_status", systemStatusPayload(userId));
  }

  function startSystemStatusMonitor(): void {
    if (systemStatusTimer) return;
    lastPublishedSystemStatus = JSON.stringify(systemStatusPayload(HOST_ROOT_USER_ID));
    systemStatusTimer = setInterval(pollSystemStatus, 250);
    systemStatusTimer.unref();
  }

  function stopSystemStatusMonitorIfIdle(): void {
    if (systemSubscribers.size > 0 || !systemStatusTimer) return;
    clearInterval(systemStatusTimer);
    systemStatusTimer = undefined;
  }

  function publishConversationChanged(conversation: ConversationRow): void {
    systemStatusSequence += 1;
    for (const [response, userId] of systemSubscribers) {
      if (userId === conversation.user_id) writeSse(response, systemStatusSequence, "conversation_changed", {
        projectId: conversation.project_id,
        conversationId: conversation.id,
        externalStatus: conversation.external_status,
      });
    }
  }

  function publishConversationMoved(conversation: ConversationRow, fromProjectId: string, toProjectId: string): void {
    systemStatusSequence += 1;
    for (const [response, userId] of systemSubscribers) {
      if (userId === conversation.user_id) writeSse(response, systemStatusSequence, "conversation_moved", {
        conversationId: conversation.id,
        fromProjectId,
        toProjectId,
      });
    }
  }

  function publicWakePlan(plan: WakePlanRow | undefined | null) {
    if (!plan) return null;
    const { event_token_hash: _secret, ...visible } = plan;
    return visible;
  }

  const ACTIVITY_SNAPSHOT_EVENT_LIMIT = 50;
  const ACTIVITY_RETAINED_STAGE_FEEDBACK_LIMIT = 5;

  function conversationActivityPayload(conversation: ConversationRow) {
    const latestJob = db.getLatestJobForConversation(conversation.id) ?? null;
    const activeJobs = db.listActiveJobsForConversation(conversation.id);
    const activeJobRow = activeJobs.find((job) => job.status === "running") ?? activeJobs[0] ?? null;
    const activityJob = activeJobRow ?? latestJob;
    const jobEvents = activityJob
      ? db.listRecentEventsWithRetainedUpdates(activityJob.id, ACTIVITY_SNAPSHOT_EVENT_LIMIT, ACTIVITY_RETAINED_STAGE_FEEDBACK_LIMIT)
        .map((event) => ({ seq: event.seq, type: event.event_type, created_at: event.created_at, ...JSON.parse(event.payload) }))
      : [];
    const remoteTurnId = conversation.codex_thread_id ? db.getLatestRemoteTurnId(conversation.id) : null;
    const remoteActivities = conversation.codex_thread_id ? db.listRemoteThreadActivities(conversation.id, 50, remoteTurnId) : [];
    return {
      conversationStatus: conversation.status,
      externalStatus: conversation.external_status,
      hasUnreadResult: Boolean(conversation.has_unread_result),
      hasPendingWork: Boolean(conversation.has_pending_work),
      activeJob: activeJobRow ? { ...activeJobRow, queuePosition: db.getQueuePosition(activeJobRow.id) } : null,
      latestJob,
      jobEvents,
      remoteTurnId,
      remoteActivities,
    };
  }

  function wakeEventTokenMatches(plan: WakePlanRow, token: string): boolean {
    if (!plan.event_token_hash || !token) return false;
    const received = Buffer.from(hashWakeEventToken(config.sessionSecret, token));
    const expected = Buffer.from(plan.event_token_hash);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  function recordWakeEvent(planId: string, eventId: string, kind: WakeEventKind, summary: string | null) {
    const result = db.recordWakeEvent(planId, eventId, kind, summary, newId());
    const conversation = result.plan ? db.getConversation(result.plan.conversation_id) : undefined;
    if (conversation) publishConversationChanged(conversation);
    if (result.targetConversation && result.targetConversation.id !== conversation?.id) {
      publishConversationChanged(result.targetConversation);
    }
    if (result.status === "triggered" && config.queueAutoStart) scheduleQueuePump();
    return result;
  }

  async function processDueWakePlans(): Promise<void> {
    if (wakeSchedulerBusy || shuttingDown) return;
    wakeSchedulerBusy = true;
    try {
      for (const plan of db.listDueWakePlans(new Date().toISOString())) {
        recordWakeEvent(plan.id, `deadline:${plan.deadline_at}`, "deadline", null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/database is not open/i.test(message)) {
        if (wakeSchedulerTimer) clearInterval(wakeSchedulerTimer);
        wakeSchedulerTimer = undefined;
      } else {
        console.error("Wake scheduler failed", message);
      }
    } finally {
      wakeSchedulerBusy = false;
    }
  }

  remoteWorkers.on("status", () => {
    systemStatusSequence += 1;
    for (const [response, userId] of systemSubscribers) {
      if (isHostRootUser(userId)) writeSse(response, systemStatusSequence, "executor_status", { executors: remoteWorkers.listExecutors() });
    }
    if (config.queueAutoStart) scheduleQueuePump();
  });

  remoteWorkers.on("quota_usage", (notice: { executorId: string }) => {
    systemStatusSequence += 1;
    for (const [response, userId] of systemSubscribers) {
      if (isHostRootUser(userId)) writeSse(response, systemStatusSequence, "executor_quota", { executorId: notice.executorId });
    }
  });

  remoteWorkers.on("thread_activity", (notice: { executorId: string; projectId: string; thread: import("./remote-worker-protocol.js").RemoteThreadSnapshot }) => {
    try {
      const project = db.getActiveProjectForUser(notice.projectId, HOST_ROOT_USER_ID);
      if (!project || project.executor_id !== notice.executorId) return;
      const selection = userAgentSelection(project.user_id, optionsForExecutor(project.user_id, project.executor_id));
      const imported = db.importRemoteThread(project.user_id, project.id, project.executor_id, notice.thread, selection);
      scheduleImportedConversationTitle(imported.conversation.id);
      if (!imported.changed) return;
      publishConversationChanged(imported.conversation);
      if (config.queueAutoStart && notice.thread.status === "idle") scheduleQueuePump();
    } catch (error) {
      console.error("Remote thread activity import failed", error instanceof Error ? error.message : error);
    }
  });

  function wakeQueueAfterMaintenance(): void {
    if (!config.queueAutoStart || maintenanceQueueWakeTimer) return;
    maintenanceQueueWakeTimer = setTimeout(() => {
      maintenanceQueueWakeTimer = undefined;
      if (!shuttingDown) trackBackground("maintenance_queue_pump", pumpQueue());
    }, 1_000);
    maintenanceQueueWakeTimer.unref();
  }

  function removePendingPromptFiles(prompt: PendingPromptWithFiles, userId: string): void {
    const workspace = ensureTenantWorkspace(config.tenantRoot, userId, prompt.conversation_id);
    for (const file of prompt.files) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); }
      catch { /* Missing or already-cleaned drafts must not block queue cleanup. */ }
      db.deleteCompletedResumableUploadForFile(file.id);
    }
  }

  function removeComposerDraftFiles(draft: ComposerDraftWithFiles, userId: string): void {
    const workspace = ensureTenantWorkspace(config.tenantRoot, userId, draft.conversation_id);
    for (const file of draft.files) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); }
      catch { /* Missing draft files must not block explicit draft cleanup. */ }
      db.deleteCompletedResumableUploadForFile(file.id);
    }
  }

  function pendingUploadRows(conversationId: string, pendingPromptId: string, uploaded: Express.Multer.File[]): FileRow[] {
    const createdAt = new Date().toISOString();
    return uploaded.map((file) => {
      const row: FileRow = {
        id: newId(), conversation_id: conversationId, message_id: null, pending_prompt_id: pendingPromptId,
        original_name: safeUploadName(file.originalname).displayName,
        relative_path: path.posix.join("uploads", file.filename), mime_type: file.mimetype || "application/octet-stream",
        size: file.size, kind: "upload", created_at: createdAt,
      };
      return row;
    });
  }

  function maximumStoredBytesForUser(userId: string): number {
    return isHostRootUser(userId) ? Number.MAX_SAFE_INTEGER : config.maxStoredBytesPerUser;
  }

  function registerPendingUploads(userId: string, conversationId: string, pendingPromptId: string, uploaded: Express.Multer.File[]): FileRow[] {
    const rows = pendingUploadRows(conversationId, pendingPromptId, uploaded);
    try { db.addFiles(rows, userId, maximumStoredBytesForUser(userId)); }
    catch (error) { removeUnregisteredUploads(uploaded); throw error; }
    return rows;
  }

  function registerComposerUploads(userId: string, conversationId: string, uploaded: Express.Multer.File[]): FileRow[] {
    db.ensureComposerDraft(conversationId);
    const createdAt = new Date().toISOString();
    const rows = uploaded.map((file) => {
      const row: FileRow = {
        id: newId(), conversation_id: conversationId, message_id: null, pending_prompt_id: null, composer_draft_id: conversationId,
        original_name: safeUploadName(file.originalname).displayName,
        relative_path: path.posix.join("uploads", file.filename), mime_type: file.mimetype || "application/octet-stream",
        size: file.size, kind: "upload", created_at: createdAt,
      };
      return row;
    });
    try { db.addFiles(rows, userId, maximumStoredBytesForUser(userId)); }
    catch (error) { removeUnregisteredUploads(uploaded); throw error; }
    db.touchComposerDraft(conversationId);
    return rows;
  }

  function removeUnregisteredUploads(uploaded: Express.Multer.File[]): void {
    for (const file of uploaded) {
      try { fs.rmSync(file.path, { force: true }); }
      catch { /* A rejected multipart request must not leave orphaned uploads. */ }
    }
  }

  function submittedQuoteExcerpt(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return normalizeAskAgentSelection(value).slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1) || null;
  }

  function submittedVoiceTranscriptionIds(value: unknown): string[] {
    if (typeof value !== "string" || !value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 20);
    } catch { return []; }
  }

  function attachVoiceTranscriptions(ids: string[], session: SessionRow, conversationId: string, target: { messageId?: string; pendingPromptId?: string }): void {
    if (ids.length === 0) return;
    db.attachVoiceTranscriptions({ ids, userId: session.user_id, conversationId, ...target });
  }

  function agentPrompt(content: string, quoteExcerpt?: string | null): string {
    return quoteExcerpt ? buildAskAgentDraft(content, quoteExcerpt) : content;
  }

  function scheduleGeneratedConversationTitle(conversationId: string, content: string, jobId?: string, trigger: "first_message" | "remote_import" = "first_message", messageId?: string): void {
    if (titleRequests.has(conversationId)) return;
    const conversation = db.getConversation(conversationId);
    if (!conversation || conversation.title_source !== "default") return;
    const project = conversation.project_id ? db.getProject(conversation.project_id) : undefined;
    if (!project) return;
    const latestAudit = db.getLatestConversationTitleAudit(conversationId);
    if (latestAudit?.status === "running" || latestAudit?.status === "succeeded") return;
    if (latestAudit?.status === "failed") {
      if (latestAudit.error === "worker_upgrade_required" && !remoteWorkers.supportsTitleAgent(project.executor_id)) return;
      const remoteTitleNowAvailable = latestAudit.error === "worker_upgrade_required";
      const completedAt = latestAudit.completed_at ? Date.parse(latestAudit.completed_at) : Date.now();
      if (!remoteTitleNowAvailable && Date.now() - completedAt < 5 * 60_000) return;
    }
    const requestText = extractTitleRequestText(content);
    if (!requestText) return;
    const attachmentNames = messageId ? db.listFilesForMessage(messageId).map((file) => file.original_name) : [];
    const directoryName = projectDirectoryName(project.root_path);
    const executor = project.executor_id === TENANT_LOCAL_EXECUTOR_ID ? tenantExecutorView() : remoteWorkers.executor(project.executor_id);
    const context = {
      requestText, projectName: project.name, projectDirectory: directoryName, attachmentNames, trigger,
      userId: conversation.user_id, executorId: project.executor_id,
    } as const;
    const auditId = newId();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    db.createConversationTitleAudit({
      id: auditId, conversation_id: conversation.id, user_id: conversation.user_id, project_id: project.id,
      executor_id: project.executor_id, trigger, model: CONVERSATION_TITLE_CODEX_MODEL,
      reasoning_effort: CONVERSATION_TITLE_REASONING_EFFORT, prompt_version: CONVERSATION_TITLE_PROMPT_VERSION,
      request_excerpt: conversationTitleAuditExcerpt(requestText), request_sha256: crypto.createHash("sha256").update(requestText, "utf8").digest("hex"),
      context_json: JSON.stringify({
        projectName: project.name, projectDirectory: directoryName, attachmentNames,
        requestCharacters: Array.from(requestText).length, executorName: executor?.machineName ?? null,
        executorKind: executor?.kind ?? null, codexVersion: executor?.runtime?.installedVersion ?? null,
      }),
      started_at: startedAt,
    });
    const request = conversationTitles.generate(context).then((title) => {
      if (!title) throw new Error("invalid_output");
      const applied = db.setAiConversationTitleIfDefault(conversationId, title);
      try { db.finishConversationTitleAudit(auditId, { status: "succeeded", outputTitle: title, applied, completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs }); } catch { return; }
      if (applied) {
        if (jobId) publish(jobId, "conversation_title", { title });
        const updated = db.getConversation(conversationId);
        if (updated) publishConversationChanged(updated);
        void runner.renameRemoteThread(conversationId, title).catch(() => undefined);
      }
    }).catch((error) => {
      try { db.finishConversationTitleAudit(auditId, { status: "failed", error: conversationTitleAuditError(error), completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs }); } catch { /* App shutdown can close SQLite before a detached naming request returns. */ }
    }).finally(() => titleRequests.delete(conversationId));
    titleRequests.set(conversationId, request);
  }

  function scheduleConversationTitle(conversationId: string, messageId: string, content: string, jobId?: string): void {
    if (!db.isFirstUserMessage(conversationId, messageId)) return;
    scheduleGeneratedConversationTitle(conversationId, content, jobId, "first_message", messageId);
  }

  function scheduleImportedConversationTitle(conversationId: string): void {
    const firstMessage = db.getFirstUserMessage(conversationId);
    if (firstMessage) scheduleGeneratedConversationTitle(conversationId, firstMessage.content, undefined, "remote_import", firstMessage.id);
  }

  function recordUserCancelledJob(job: JobRow): void {
    if (db.getJob(job.id)?.status !== "cancelled" || !db.getConversation(job.conversation_id)) return;
    db.addMessage({
      id: newId(), conversation_id: job.conversation_id, role: "assistant",
      content: buildUserCancellationSummary(db.listEvents(job.id)), created_at: new Date().toISOString(),
    });
  }

  async function stopConversationJobs(conversationId: string, recordCancellation = true): Promise<void> {
    const cancelledWakeCount = db.cancelArmedWakePlansForConversation(conversationId);
    if (cancelledWakeCount) {
      const conversation = db.getConversation(conversationId);
      if (conversation) publishConversationChanged(conversation);
    }
    const activeJobs = db.listActiveJobsForConversation(conversationId);
    const runningJobs = activeJobs.filter((job) => job.status === "running");
    for (const job of activeJobs) {
      if (job.status === "queued" && db.cancelQueuedJob(job.id)) {
        publish(job.id, "done", { status: "cancelled", message: "任务已停止" });
        continue;
      }
      if (job.status !== "running") continue;
      if (runner.cancel(job.id)) continue;
      if (db.getJob(job.id)?.status === "running") {
        db.finishJob(job.id, conversationId, "cancelled", "任务已停止");
        publish(job.id, "done", { status: "cancelled", message: "任务已停止" });
      }
    }
    publishQueuePositions();
    if (config.queueAutoStart) scheduleQueuePump();

    const deadline = Date.now() + 15_000;
    while (db.listActiveJobsForConversation(conversationId).length > 0) {
      if (Date.now() >= deadline) throw new Error("相关任务未能在限定时间内停止，请稍后重试。");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (recordCancellation) for (const job of runningJobs) recordUserCancelledJob(job);
  }

  type DispatchBlock = "global_limit" | "user_limit" | "executor_limit" | "disk_watermark" | "executor_unavailable" | "cold_storage";

  let diskSpaceSample: { sampledAt: number; bytes: number } | null = null;
  function availableDiskBytes(forceRefresh = false): number {
    if (!forceRefresh && diskSpaceSample && Date.now() - diskSpaceSample.sampledAt < 2_000) return diskSpaceSample.bytes;
    try {
      const roots = [...new Set([config.dataRoot, config.tenantRoot])];
      const bytes = Math.min(...roots.map((root) => {
        const stat = fs.statfsSync(root);
        return Number(stat.bavail) * Number(stat.bsize);
      }));
      diskSpaceSample = { sampledAt: Date.now(), bytes };
      return bytes;
    } catch {
      // An unreadable filesystem status is fail-closed for new work. Existing
      // jobs continue and operators retain a clear queue reason.
      diskSpaceSample = { sampledAt: Date.now(), bytes: 0 };
      return diskSpaceSample.bytes;
    }
  }

  const resumableUploads = new ResumableUploadService({ db, config, availableDiskBytes, maximumStoredBytesForUser });

  function dispatchBlock(conversationId: string): DispatchBlock | null {
    const conversation = db.getConversation(conversationId);
    if (!conversation) return "executor_unavailable";
    if (conversation.cold_storage_state !== "local") return "cold_storage";
    const project = conversation.project_id ? db.getProjectForUser(conversation.project_id, conversation.user_id) : undefined;
    // CODEX_WEB is the explicitly trusted host operator account. Its jobs do not
    // consume the shared-user concurrency budget and are not capped by the
    // server-side user/host-executor defaults. Remote Workers still enforce
    // their own per-device capacity in canDispatchConversation().
    if (!isHostRootUser(conversation.user_id)) {
      if (db.countRunningJobsExcludingUser(HOST_ROOT_USER_ID) >= config.maxGlobalRunningJobs) return "global_limit";
      if (db.countRunningJobsForUser(conversation.user_id) >= config.maxRunningJobsPerUser) return "user_limit";
      if (project && db.countRunningJobsForExecutorExcludingUser(project.executor_id, HOST_ROOT_USER_ID) >= config.maxRunningJobsPerExecutor) return "executor_limit";
    }
    if (availableDiskBytes() < config.minimumFreeDiskBytes) return "disk_watermark";
    if (!runner.canDispatchConversation(conversationId)) return "executor_unavailable";
    return null;
  }

  function fairDispatchOrder<T extends { conversation_id: string; created_at: string }>(candidates: T[]): T[] {
    return candidates.map((candidate, originalIndex) => {
      const userId = db.getConversation(candidate.conversation_id)?.user_id ?? "";
      return { candidate, originalIndex, running: userId ? db.countRunningJobsForUser(userId) : Number.MAX_SAFE_INTEGER };
    }).sort((left, right) => left.running - right.running || left.originalIndex - right.originalIndex)
      .map(({ candidate }) => candidate);
  }

  function dispatchBlockLabel(reason: DispatchBlock): string {
    return ({
      global_limit: `等待全局并发槽位（上限 ${config.maxGlobalRunningJobs}）`,
      user_limit: `等待当前账号并发槽位（上限 ${config.maxRunningJobsPerUser}）`,
      executor_limit: `等待执行器并发槽位（安全上限 ${config.maxRunningJobsPerExecutor}）`,
      disk_watermark: "磁盘可用空间低于安全水位，任务已保留在队列",
      executor_unavailable: "等待目标执行器上线或释放容量",
      cold_storage: "正在恢复冷存储历史，恢复完成后自动继续",
    })[reason];
  }

  function publishQueuePositions(): void {
    const maintenancePhase = codexUpdateMaintenancePhase();
    for (const queued of db.listQueuedJobs()) {
      const queuePosition = db.getQueuePosition(queued.id) ?? 1;
      const jobsAhead = Math.max(0, queuePosition - 1);
      const conversation = db.getConversation(queued.conversation_id);
      const project = conversation?.project_id ? db.getProject(conversation.project_id) : undefined;
      const executor = project ? remoteWorkers.executor(project.executor_id) : undefined;
      const waitingForRemote = Boolean(project && workerIdFromExecutor(project.executor_id) && executor?.status !== "online");
      const blocked = dispatchBlock(queued.conversation_id);
      publish(queued.id, "status", {
        status: "queued",
        queuePosition,
        jobsAhead,
        label: maintenancePhase !== "idle"
          ? maintenanceQueueGuidance[maintenancePhase]
          : waitingForRemote ? `等待 ${executor?.machineName ?? "远程电脑"} 上线`
          : blocked ? dispatchBlockLabel(blocked)
          : jobsAhead === 0 ? "任务即将开始" : `正在等待本会话前面的 ${jobsAhead} 个任务运行完毕`,
      });
    }
  }

  async function runQueuedJob(job: JobRow): Promise<void> {
    try {
      const conversation = db.getConversation(job.conversation_id);
      const message = job.message_id ? db.getMessage(job.message_id) : undefined;
      if (!conversation || !message) {
        db.finishJob(job.id, job.conversation_id, "failed", "排队任务的数据不完整");
        publish(job.id, "failed", { status: "failed", message: "排队任务的数据不完整" });
        return;
      }
      const selection = repairAgentSelection(optionsForConversation(conversation), job.agent_model, job.reasoning_effort);
      scheduleConversationTitle(conversation.id, message.id, message.content, job.id);
      await runner.run(job.id, conversation.id, agentPrompt(message.content, message.quote_excerpt), db.listFilesForMessage(message.id), selection);
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务执行失败";
      if (db.getJob(job.id)?.status === "running") {
        db.finishJob(job.id, job.conversation_id, "failed", message);
        publish(job.id, "failed", { status: "failed", message });
      }
    } finally {
      publishQueuePositions();
      await pumpQueue();
    }
  }

  async function pumpQueue(): Promise<void> {
    if (queuePumpBusy || shuttingDown) return;
    if (codexUpdateMaintenanceActive()) {
      if (!maintenanceQueueWaiting) {
        maintenanceQueueWaiting = true;
        publishQueuePositions();
      }
      wakeQueueAfterMaintenance();
      return;
    }
    maintenanceQueueWaiting = false;
    queuePumpBusy = true;
    try {
      for (;;) {
        if (shuttingDown) break;
        if (codexUpdateMaintenanceActive()) {
          maintenanceQueueWaiting = true;
          publishQueuePositions();
          wakeQueueAfterMaintenance();
          break;
        }
        let job = fairDispatchOrder(db.listRunnableQueuedJobs()).find((candidate) => !dispatchBlock(candidate.conversation_id));
        if (!job) {
          const pending = fairDispatchOrder(db.listDispatchablePendingPrompts()).find((candidate) => !dispatchBlock(candidate.conversation_id));
          if (pending) {
            job = db.materializePendingPrompt(pending.id, newId(), newId());
            if (!job) continue;
          }
        }
        if (!job) break;
        // A maintenance marker may appear after the queue lookup. Keep the
        // materialized job queued and stop before reserving or launching it.
        if (codexUpdateMaintenanceActive()) {
          maintenanceQueueWaiting = true;
          publishQueuePositions();
          wakeQueueAfterMaintenance();
          break;
        }
        // Reserve the conversation synchronously before launching the async
        // runner. This lets other conversations start immediately while keeping
        // every turn in this conversation strictly serial.
        db.updateJob(job.id, "running");
        db.updateConversation(job.conversation_id, { status: "running" });
        const startedConversation = db.getConversation(job.conversation_id);
        if (startedConversation) publishConversationChanged(startedConversation);
        trackBackground("queued_job", runQueuedJob(job));
      }
    } finally {
      queuePumpBusy = false;
      publishQueuePositions();
    }
  }

  function remoteTransferToken(req: Request): string {
    const authorization = readBearerToken(req.get("authorization"));
    if (authorization) return authorization;
    // Temporary compatibility for Worker <=1.14.0. The dedicated Nginx log
    // format never records args; remove this fallback after all nodes upgrade.
    if (typeof req.query.token !== "string") return "";
    console.warn(JSON.stringify({
      level: "warn",
      event: "remote_transfer_query_token_compat",
      requestId: (req as AuthenticatedRequest).requestId,
      method: req.method,
      path: req.path,
      userAgent: String(req.get("user-agent") ?? "").slice(0, 160),
    }));
    return req.query.token;
  }

  const app = express();
  app.set("trust proxy", "loopback");
  app.enable("strict routing");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const supplied = String(req.get("x-request-id") ?? "").trim();
    const requestId = /^[a-zA-Z0-9_-]{8,80}$/.test(supplied) ? supplied : crypto.randomUUID();
    (req as AuthenticatedRequest).requestId = requestId;
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser());
  const remoteTransferPrefix = `${config.basePath}/api/remote-worker-files/`;
  const transferScopePattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const remoteJobOutputPattern = new RegExp(`^(${transferScopePattern})/output$`, "i");
  const remoteFetchOutputPattern = new RegExp(`^fetch/(${transferScopePattern})$`, "i");
  const remoteJobInputPattern = new RegExp(`^(${transferScopePattern})/input/(${transferScopePattern})$`, "i");
  app.use((req, res, next) => {
    if (!req.path.startsWith(remoteTransferPrefix)) return next();
    const relativePath = req.path.slice(remoteTransferPrefix.length);
    const token = remoteTransferToken(req);
    const jobOutput = req.method === "PUT" ? remoteJobOutputPattern.exec(relativePath) : null;
    if (jobOutput) {
      if (!remoteWorkers.authorizeArtifactUpload(jobOutput[1], token)) {
        return res.status(404).json({ code: "REMOTE_TRANSFER_UNAUTHORIZED", error: "文件传输凭据无效或任务已结束。" });
      }
      res.locals.remoteTransferToken = token;
      return next();
    }
    const fetchOutput = req.method === "PUT" ? remoteFetchOutputPattern.exec(relativePath) : null;
    if (fetchOutput) {
      if (!remoteWorkers.authorizeFetchedArtifactUpload(fetchOutput[1], token)) {
        return res.status(404).json({ code: "REMOTE_TRANSFER_UNAUTHORIZED", error: "文件传输凭据无效或请求已结束。" });
      }
      res.locals.remoteTransferToken = token;
      return next();
    }
    const jobInput = req.method === "GET" ? remoteJobInputPattern.exec(relativePath) : null;
    if (jobInput) {
      if (!remoteWorkers.inputFile(jobInput[1], jobInput[2], token)) {
        return res.status(404).json({ code: "REMOTE_TRANSFER_UNAUTHORIZED", error: "文件传输凭据无效或任务已结束。" });
      }
      res.locals.remoteTransferToken = token;
      return next();
    }
    return next();
  });
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    // Remote Worker transfers are raw files, even when their MIME type is
    // application/json. Leave them untouched for the route-local authenticated
    // streaming handler instead of applying the normal 1 MiB API JSON parser.
    if (req.method === "PUT" && /(?:^|\/)api\/remote-worker-files\//.test(req.path)) return next();
    return jsonParser(req, res, next);
  });

  const router = express.Router();
  const api = express.Router();

  api.get("/health", (_req, res) => res.json({ ok: true, service: "codex-web", time: new Date().toISOString() }));

  api.get("/remote-worker-release/:version/manifest.json", (req, res) => {
    if (!remoteWorkers.authorizeReleaseDownload(req.get("authorization"))) {
      return res.status(404).json({ error: "Worker 发布包不存在。" });
    }
    const manifest = remoteWorkers.releaseManifest();
    if (!manifest || req.params.version !== manifest.version) return res.status(404).json({ error: "Worker 发布包不存在。" });
    res.setHeader("Cache-Control", "private, no-store");
    return res.json(manifest);
  });

  api.get("/remote-worker-release/:version/archive", (req, res) => {
    if (!remoteWorkers.authorizeReleaseDownload(req.get("authorization"))) {
      return res.status(404).json({ error: "Worker 发布包不存在。" });
    }
    const manifest = remoteWorkers.releaseManifest();
    if (!manifest || req.params.version !== manifest.version) return res.status(404).json({ error: "Worker 发布包不存在。" });
    res.setHeader("Cache-Control", "private, no-store");
    const platform = req.query.platform === "darwin-universal" ? "darwin-universal" : "win32-x64";
    const archive = platform === "darwin-universal" ? manifest.platforms?.[platform] : (manifest.platforms?.[platform] ?? manifest.archive);
    if (!archive) return res.status(404).json({ error: "Worker 发布包不存在。" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", platform === "darwin-universal" ? "application/gzip" : "application/zip");
    res.setHeader("Content-Length", String(archive.size));
    res.setHeader("Content-Disposition", `attachment; filename="${archive.fileName}"`);
    res.setHeader("X-Checksum-SHA256", archive.sha256);
    return res.sendFile(archive.fileName, { root: config.remoteWorkerReleaseRoot });
  });

  api.get("/remote-worker-bootstrap/:platform/:token", (req, res) => {
    const platform = String(req.params.platform) as RemoteWorkerBootstrapPlatform;
    if (platform !== "win32-x64" && platform !== "darwin-universal") return res.status(404).send("Worker 安装包不存在。\n");
    const token = String(req.params.token);
    if (!remoteWorkers.bootstrapGrantValid(token, platform)) return res.status(404).send("Worker 安装链接已过期，请回 Codex Web 重新生成。\n");
    const release = remoteWorkers.releaseManifest();
    if (!release) return res.status(404).send("Worker 发布包不存在。\n");
    const baseUrl = config.publicBaseUrl.replace(/\/$/, "") || `http://127.0.0.1:${config.port}${config.basePath}`;
    const script = bootstrapScript(platform, { baseUrl, token, version: release.version });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", script.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${script.fileName}"`);
    return res.send(script.body);
  });

  api.post("/remote-worker-bootstrap/exchange", (req, res) => {
    const platform = req.body?.platform as RemoteWorkerBootstrapPlatform;
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if ((platform !== "win32-x64" && platform !== "darwin-universal") || !token) return res.status(400).json({ error: "Worker 配对信息无效。" });
    try {
      const exchanged = remoteWorkers.exchangeBootstrapGrant(token, platform);
      const baseUrl = config.publicBaseUrl.replace(/\/$/, "") || `http://127.0.0.1:${config.port}${config.basePath}`;
      return res.json({ enrollmentToken: exchanged.enrollmentToken, version: exchanged.version, archiveUrl: `${baseUrl}/api/remote-worker-release/${encodeURIComponent(exchanged.version)}/archive?platform=${encodeURIComponent(platform)}` });
    } catch (error) { return res.status(410).json({ error: error instanceof Error ? error.message : "Worker 安装链接已失效。" }); }
  });

  // DashScope fetches this short-lived, HMAC-signed URL without a browser
  // session. Keep it before the authentication middleware and expose no other
  // temporary files through this route.
  api.get("/transcription-audio/:fileName", (req, res) => transcription.serveSignedAudio(req, res));

  function decodedRemoteFileName(value: string | undefined, fallback: string): string {
    try { return decodeURIComponent(value ?? fallback); }
    catch { return fallback; }
  }

  function sendRemoteTransferError(res: Response, error: unknown) {
    if (error instanceof RemoteTransferError) return res.status(error.status).json({ code: error.code, error: error.message });
    console.error("Remote Worker transfer failed", error instanceof Error ? error.message : String(error));
    return res.status(500).json({ code: "REMOTE_TRANSFER_FAILED", error: "远程文件传输失败。" });
  }

  api.get("/remote-worker-files/:jobId/input/:fileId", (req, res) => {
    const token = String(res.locals.remoteTransferToken ?? "");
    const input = remoteWorkers.inputFile(String(req.params.jobId), String(req.params.fileId), token);
    if (!input) return res.status(404).json({ error: "文件传输凭据无效或任务已结束。" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", input.row.mime_type || "application/octet-stream");
    res.setHeader("Content-Length", String(input.row.size));
    return res.sendFile(path.basename(input.path), { root: path.dirname(input.path) });
  });

  api.put("/remote-worker-files/:jobId/output", async (req, res) => {
    const jobId = String(req.params.jobId);
    const token = String(res.locals.remoteTransferToken ?? "");
    if (!remoteWorkers.authorizeArtifactUpload(jobId, token)) {
      return res.status(404).json({ code: "REMOTE_TRANSFER_UNAUTHORIZED", error: "文件传输凭据无效或任务已结束。" });
    }
    let reservation: ReturnType<RemoteWorkerGateway["beginArtifactUpload"]>;
    try {
      const expectedSize = parseRemoteContentLength(req.headers["content-length"]);
      reservation = remoteWorkers.beginArtifactUpload(
        jobId,
        token,
        decodedRemoteFileName(req.get("x-file-name"), "output.bin"),
        String(req.get("content-type") ?? "application/octet-stream"),
        expectedSize,
      );
      if (!reservation) return res.status(409).json({ code: "REMOTE_TRANSFER_STALE", error: "任务已结束，无法继续上传。" });
      const received = await streamRemoteUpload(req, reservation.temporaryPath, expectedSize);
      const artifact = await remoteWorkers.completeArtifactUpload(reservation, received.size, received.sha256);
      if (!artifact) {
        await remoteWorkers.abortUpload(reservation);
        return res.status(409).json({ code: "REMOTE_TRANSFER_STALE", error: "任务已结束，上传结果未登记。" });
      }
      return res.status(201).json({ artifact });
    } catch (error) {
      if (reservation) await remoteWorkers.abortUpload(reservation);
      return sendRemoteTransferError(res, error);
    }
  });

  api.put("/remote-worker-files/fetch/:requestId", async (req, res) => {
    const requestId = String(req.params.requestId);
    const token = String(res.locals.remoteTransferToken ?? "");
    if (!remoteWorkers.authorizeFetchedArtifactUpload(requestId, token)) {
      return res.status(404).json({ code: "REMOTE_TRANSFER_UNAUTHORIZED", error: "文件传输凭据无效或请求已结束。" });
    }
    let reservation: ReturnType<RemoteWorkerGateway["beginFetchedArtifactUpload"]>;
    try {
      const expectedSize = parseRemoteContentLength(req.headers["content-length"]);
      reservation = remoteWorkers.beginFetchedArtifactUpload(
        requestId,
        token,
        decodedRemoteFileName(req.get("x-file-name"), "download.bin"),
        String(req.get("content-type") ?? "application/octet-stream"),
        expectedSize,
      );
      if (!reservation) return res.status(409).json({ code: "REMOTE_TRANSFER_STALE", error: "文件请求已结束，无法继续上传。" });
      const received = await streamRemoteUpload(req, reservation.temporaryPath, expectedSize);
      const artifact = await remoteWorkers.completeFetchedArtifactUpload(reservation, received.size, received.sha256);
      if (!artifact) {
        await remoteWorkers.abortUpload(reservation);
        return res.status(409).json({ code: "REMOTE_TRANSFER_STALE", error: "文件请求已结束，上传结果未登记。" });
      }
      return res.status(201).json({ artifact });
    } catch (error) {
      if (reservation) await remoteWorkers.abortUpload(reservation);
      return sendRemoteTransferError(res, error);
    }
  });

  const publicShareLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "公开文件访问过于频繁，请稍后再试。" },
  });

  api.head("/files/:id/preview/public", publicShareLimiter, (req, res) => {
    publicResponseHeaders(res);
    if (!activePublicDocument(String(req.params.id))) return res.status(404).end();
    return res.status(204).end();
  });

  api.get("/files/:id/preview/public", publicShareLimiter, (req, res) => {
    publicResponseHeaders(res);
    const fileId = String(req.params.id);
    const active = activePublicDocument(fileId);
    if (!active) return res.status(404).json({ error: "公开文件不存在或分享已关闭。" });
    let content: string;
    try { content = fs.readFileSync(active.absolute, "utf8").replace(/^\uFEFF/, ""); }
    catch { return res.status(404).json({ error: "公开文件不存在或分享已关闭。" }); }
    const assets = db.listPublicFileShareAssets(active.share.id).map((asset) => ({
      sourceRef: asset.source_ref,
      assetFileId: asset.asset_file_id,
    }));
    try {
      content = rewritePublicShareDocument(active.kind, content, assets, (assetFileId) => (
        `${publicOrigin(req)}${config.basePath}/api/files/${encodeURIComponent(fileId)}/preview/public/assets/${encodeURIComponent(assetFileId)}`
      ));
    } catch {
      return res.status(404).json({ error: "公开文件资源不完整。" });
    }
    const suppliedViewId = String(req.get("x-codex-view-id") ?? "");
    const viewId = /^[A-Za-z0-9_-]{8,100}$/.test(suppliedViewId)
      ? suppliedViewId
      : String((req as AuthenticatedRequest).requestId ?? crypto.randomUUID());
    const userAgent = String(req.get("user-agent") ?? "").trim().slice(0, 256) || null;
    db.recordPublicShareAccess(active.share.id, normalizedPublicIp(req), viewId, userAgent);
    return res.json({
      file: {
        id: active.file.id,
        original_name: active.file.original_name,
        mime_type: active.file.mime_type,
        size: active.file.size,
        kind: active.file.kind,
      },
      content,
    });
  });

  api.get("/files/:id/preview/public/assets/:assetId", publicShareLimiter, (req, res) => {
    publicResponseHeaders(res);
    const active = activePublicDocument(String(req.params.id));
    if (!active) return res.status(404).json({ error: "公开图片不存在或分享已关闭。" });
    const assetId = String(req.params.assetId);
    const mapping = db.listPublicFileShareAssets(active.share.id).find((asset) => asset.asset_file_id === assetId);
    const asset = mapping ? db.getFile(assetId) : undefined;
    const conversation = asset ? db.getConversation(asset.conversation_id) : undefined;
    if (!asset || !conversation || conversation.user_id !== active.share.user_id || conversation.deleted_at
      || asset.kind !== "output" || !isPublicShareImage(asset) || !isPersistedDeliverablePath(asset.relative_path)) {
      return res.status(404).json({ error: "公开图片不存在或分享已关闭。" });
    }
    let absolute: string;
    try { absolute = resolveFilePath(asset, active.share.user_id); }
    catch { return res.status(404).json({ error: "公开图片不存在或分享已关闭。" }); }
    let stat: fs.Stats;
    try { stat = fs.statSync(absolute); }
    catch { return res.status(404).json({ error: "公开图片不存在或分享已关闭。" }); }
    if (!stat.isFile() || stat.size !== asset.size) return res.status(404).json({ error: "公开图片不存在或分享已关闭。" });
    res.setHeader("Content-Type", fileResponseContentType(asset.mime_type));
    res.setHeader("Content-Length", String(stat.size));
    return res.sendFile(path.basename(absolute), { root: path.dirname(absolute) });
  });

  const automationLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "自动续跑请求过于频繁，请稍后再试。" },
  });

  function authenticatedAutomationJob(req: Request) {
    const jobId = String(req.params.jobId);
    const claims = verifyJobAutomationToken(config.sessionSecret, readBearerToken(req.get("authorization")));
    if (!claims || claims.jobId !== jobId) return null;
    const job = db.getJob(jobId);
    if (!job || job.status !== "running" || job.conversation_id !== claims.conversationId) return null;
    return job;
  }

  function wakeDeadline(value: unknown): string | null {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 365 * 24 * 60 * 60) return null;
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  function relativeWakeDeadline(currentDeadlineAt: string, value: unknown): string | null {
    const seconds = Number(value);
    const currentTimestamp = Date.parse(currentDeadlineAt);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 365 * 24 * 60 * 60 || !Number.isFinite(currentTimestamp)) return null;
    return new Date(currentTimestamp + seconds * 1000).toISOString();
  }

  function absoluteWakeDeadline(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + 365 * 24 * 60 * 60 * 1000) return null;
    return new Date(timestamp).toISOString();
  }

  function wakeText(value: unknown, max = 20_000): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function editableWakePrompt(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const prompt = value.trim();
    return prompt && prompt.length <= 20_000 ? prompt : null;
  }

  api.post("/automation/jobs/:jobId/wake-plans", automationLimiter, (req, res) => {
    const job = authenticatedAutomationJob(req);
    if (!job) return res.status(401).json({ error: "自动续跑凭据无效、已过期或任务已经结束。" });
    const mode = req.body?.mode as WakePlanMode;
    const deadlineAt = wakeDeadline(req.body?.delaySeconds);
    const successPrompt = wakeText(req.body?.successPrompt);
    const failurePrompt = mode === "event_or_deadline" ? wakeText(req.body?.failurePrompt) : successPrompt;
    const timeoutPrompt = mode === "event_or_deadline" ? wakeText(req.body?.timeoutPrompt) : successPrompt;
    const newConversation = req.body?.newConversation === true;
    if ((req.body?.newConversation !== undefined && typeof req.body.newConversation !== "boolean")
      || (req.body?.model !== undefined && typeof req.body.model !== "string")
      || (req.body?.reasoningEffort !== undefined && typeof req.body.reasoningEffort !== "string")
      || !deadlineAt || !["time", "event_or_deadline"].includes(mode) || !successPrompt || !failurePrompt || !timeoutPrompt) {
      return res.status(400).json({ error: "等待模式、时间或续跑指令无效。" });
    }
    const eventToken = mode === "event_or_deadline" ? crypto.randomBytes(32).toString("base64url") : null;
    try {
      const conversation = db.getConversation(job.conversation_id)!;
      const inheritedSelection = job.agent_model && job.reasoning_effort
        ? { model: job.agent_model, reasoningEffort: job.reasoning_effort }
        : conversationAgentSelection(conversation);
      const selection = req.body?.model !== undefined || req.body?.reasoningEffort !== undefined
        ? resolveAgentSelection(
          optionsForConversation(conversation),
          req.body?.model ?? inheritedSelection.model,
          req.body?.reasoningEffort ?? inheritedSelection.reasoningEffort,
        )
        : inheritedSelection;
      const plan = db.createWakePlan({
        id: newId(),
        conversationId: job.conversation_id,
        createdByJobId: job.id,
        mode,
        label: wakeText(req.body?.label, 120) || (mode === "time" ? "定时自动继续" : "等待外部事件"),
        runId: wakeText(req.body?.runId, 200) || null,
        deadlineAt,
        successPrompt,
        failurePrompt,
        timeoutPrompt,
        newConversation,
        selection,
        eventTokenHash: eventToken ? hashWakeEventToken(config.sessionSecret, eventToken) : null,
      });
      const sourceConversation = db.getConversation(job.conversation_id)!;
      const targetConversation = plan.target_conversation_id ? db.getConversation(plan.target_conversation_id) : undefined;
      publishConversationChanged(sourceConversation);
      if (targetConversation && targetConversation.id !== sourceConversation.id) {
        publishConversationChanged(targetConversation);
      }
      const baseUrl = config.publicBaseUrl.replace(/\/$/, "") || `http://127.0.0.1:${config.port}${config.basePath}`;
      return res.status(201).json({
        wakePlan: publicWakePlan(plan),
        targetConversation: targetConversation ? { id: targetConversation.id, title: targetConversation.title, projectId: targetConversation.project_id } : undefined,
        signal: eventToken ? { url: `${baseUrl}/api/automation/wake-plans/${encodeURIComponent(plan.id)}/events`, token: eventToken } : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "等待计划创建失败。";
      return res.status(/UNIQUE constraint/i.test(message) ? 409 : 400).json({ error: /UNIQUE constraint/i.test(message) ? "这个会话已经有一个等待计划，请先取消或等待它触发。" : message });
    }
  });

  api.post("/automation/jobs/:jobId/wake-plans/:planId/cancel", automationLimiter, (req, res) => {
    const job = authenticatedAutomationJob(req);
    const plan = job ? db.getWakePlan(String(req.params.planId)) : undefined;
    if (!job || !plan || plan.created_by_job_id !== job.id) return res.status(401).json({ error: "自动续跑凭据无效。" });
    const cancelled = db.cancelWakePlan(plan.id);
    const conversation = db.getConversation(plan.conversation_id);
    if (conversation) publishConversationChanged(conversation);
    if (cancelled && config.queueAutoStart) scheduleQueuePump();
    return cancelled ? res.json({ wakePlan: publicWakePlan(cancelled) }) : res.status(409).json({ error: "等待计划已经触发或取消。" });
  });

  api.post("/automation/wake-plans/:planId/events", automationLimiter, (req, res) => {
    const plan = db.getWakePlan(String(req.params.planId));
    if (!plan || !wakeEventTokenMatches(plan, readBearerToken(req.get("authorization")))) return res.status(401).json({ error: "事件回执凭据无效。" });
    const eventId = wakeText(req.body?.eventId, 200);
    const kind = req.body?.kind as WakeEventKind;
    const summary = wakeText(req.body?.summary, 2_000) || null;
    if (!eventId || !["success", "failure", "heartbeat"].includes(kind)) return res.status(400).json({ error: "事件编号或状态无效。" });
    const result = recordWakeEvent(plan.id, eventId, kind, summary);
    return res.json({
      status: result.status,
      wakePlan: result.plan ? {
        id: result.plan.id,
        state: result.plan.state,
        deadlineAt: result.plan.deadline_at,
        triggerCause: result.plan.trigger_cause,
      } : undefined,
    });
  });

  api.use("/auth", (req, res, next) => {
    // Session responses contain user-specific, rapidly changing authentication
    // state. In particular, a cached unauthenticated response must never survive
    // a mobile tab restore or a later successful login.
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    // Existing tabs may still carry an ETag cached before these directives were
    // deployed. Ignore that legacy validator once so Express sends a full body.
    delete req.headers["if-none-match"];
    delete req.headers["if-modified-since"];
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "尝试次数过多，请稍后再试。" },
  });

  const loginIpHash = (req: Request): string => crypto.createHmac("sha256", config.sessionSecret).update(normalizedPublicIp(req)).digest("hex");
  const loginBlocked = (req: Request, res: Response): boolean => {
    const state = db.getLoginThrottle(loginIpHash(req));
    const remaining = state?.blocked_until ? Date.parse(state.blocked_until) - Date.now() : 0;
    if (remaining <= 0) return false;
    const seconds = Math.ceil(remaining / 1000); res.setHeader("Retry-After", String(seconds));
    res.status(429).json({ error: `尝试次数过多，请${seconds}秒后再试。`, retryAfterSeconds: seconds }); return true;
  };
  const loginFailure = (req: Request) => db.recordLoginFailure(loginIpHash(req));
  api.post("/auth/login", loginLimiter, async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = db.getUserByUsername(username);
    const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    const valid = Boolean(user && user.status === "active" && user.password_hash && passwordMatches);
    if (!valid || !user) return res.status(401).json({ error: "用户名或密码不正确。" });
    ensureUserDefaultProject(user.id);

    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
    db.createSession(hashToken(token, config.sessionSecret), csrfToken, expiresAt.toISOString(), user.id);
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: req.secure || forwardedProto === "https",
      sameSite: "strict",
      path: config.basePath || "/",
      expires: expiresAt,
    });
    const maintenancePhase = codexUpdateMaintenancePhase();
    return res.json({ authenticated: true, accountId: user.id, username: user.username, displayName: user.display_name, csrfToken, chatFontSize: db.getChatFontSize(user.id), projectMode: true, maintenance: maintenancePhase !== "idle", maintenancePhase });
  });

  api.get("/auth/session", (req, res) => {
    const session = readSession(req, db, config);
    if (!session) return res.json({ authenticated: false });
    const maintenancePhase = codexUpdateMaintenancePhase();
    return res.json({ authenticated: true, accountId: session.user_id, username: session.username, displayName: session.display_name, csrfToken: session.csrf_token, chatFontSize: db.getChatFontSize(session.user_id), projectMode: true, maintenance: maintenancePhase !== "idle", maintenancePhase });
  });

  api.use((req, res, next) => {
    const session = readSession(req, db, config);
    if (!session) return res.status(401).json({ error: "请先登录。" });
    res.locals.session = session;
    (req as AuthenticatedRequest).appSession = session;
    return next();
  });

  api.use((req, res, next) => {
    if (["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      delete req.headers["if-none-match"];
      delete req.headers["if-modified-since"];
    }
    return next();
  });

  api.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const session = res.locals.session as SessionRow;
    if (req.get("x-csrf-token") !== session.csrf_token) return res.status(403).json({ error: "安全校验失败，请刷新页面后重试。" });
    const origin = req.get("origin");
    const expectedHost = String(req.headers["x-forwarded-host"] ?? req.get("host") ?? "").split(",")[0].trim();
    if (origin) {
      try {
        if (new URL(origin).host !== expectedHost) return res.status(403).json({ error: "请求来源不受信任。" });
      } catch {
        return res.status(403).json({ error: "请求来源不受信任。" });
      }
    }
    return next();
  });

  function readerRequestError(res: Response, error: unknown): Response {
    if (error instanceof ReaderUnavailableError) {
      return res.status(202).setHeader("Retry-After", "2").json({ code: error.code, restoring: true, error: error.message });
    }
    if (error instanceof ReaderRangeError) {
      if (error.code === "unsatisfiable") {
        const total = Number.isSafeInteger(error.resourceSize) && (error.resourceSize ?? -1) >= 0 ? error.resourceSize : "*";
        return res.status(416).setHeader("Content-Range", `bytes */${total}`).json({ code: "READER_RANGE_UNSATISFIABLE", error: error.message });
      }
      if (error.code === "too_large") return res.status(416).json({ code: "READER_RANGE_TOO_LARGE", error: error.message, maxBytes: config.readerRangeMaxBytes });
      return res.status(400).json({ code: "READER_RANGE_INVALID", error: error.message });
    }
    if (error instanceof ReaderIngestError) {
      const status = /大小上限|安全大小|在线阅读大小/i.test(error.message) ? 413 : 422;
      return res.status(status).json({ code: status === 413 ? "READER_FILE_TOO_LARGE" : "READER_INGEST_FAILED", error: error.message });
    }
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return res.status(404).json({ code: "READER_FILE_NOT_FOUND", error: "阅读资源不存在。" });
    }
    return res.status(500).json({ code: "READER_INTERNAL_ERROR", error: "阅读资源处理失败。" });
  }

  function readerVersionForRequest(versionId: string, session: SessionRow) {
    const version = db.getReadingVersion(versionId, session.user_id);
    if (!version) return undefined;
    // Keep progress/annotation APIs behind the same active conversation
    // boundary as the file preview route.  A tombstoned conversation may
    // still have rows during GC, but it must not accept new reader writes.
    return db.getFileForUser(version.file_id, session.user_id) ? version : undefined;
  }

  api.get("/reader/files/:id/manifest", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    db.touchConversationActivity(file.conversation_id);
    try {
      const manifest = await reader.openFile(file, session.user_id);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(manifest);
    } catch (error) { return readerRequestError(res, error); }
  });

  api.get("/reader/versions/:id/manifest", async (req, res) => {
    const session = res.locals.session as SessionRow;
    try {
      const manifest = await reader.getManifest(String(req.params.id), session.user_id);
      if (!manifest) return res.status(404).json({ error: "阅读版本不存在。" });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(manifest);
    } catch (error) { return readerRequestError(res, error); }
  });

  api.get("/reader/versions/:versionId/units/:unitId", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const release = reader.reads.tryAcquire(session.user_id);
    if (!release) return res.status(429).setHeader("Retry-After", "1").json({ code: "READER_CONCURRENCY_LIMIT", error: `同一账号最多同时读取 ${config.readerMaxConcurrentReads} 个资源。` });
    try {
      const result = await reader.readUnit(String(req.params.versionId), String(req.params.unitId), session.user_id);
      if (!result) return res.status(404).json({ error: "阅读单元不存在或尚未解析完成。" });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ unit: { id: result.unit.id, ordinal: result.unit.ordinal, href: result.unit.href, title: result.unit.title, mediaType: result.unit.media_type }, content: result.content });
    } catch (error) { return readerRequestError(res, error); }
    finally { release(); }
  });

  api.get("/reader/versions/:versionId/asset", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const assetPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!assetPath || assetPath.length > 2_000) return res.status(400).json({ error: "资源路径无效。" });
    const release = reader.reads.tryAcquire(session.user_id);
    if (!release) return res.status(429).setHeader("Retry-After", "1").json({ code: "READER_CONCURRENCY_LIMIT", error: `同一账号最多同时读取 ${config.readerMaxConcurrentReads} 个资源。` });
    let handedOff = false;
    try {
      const asset = await reader.readAsset(String(req.params.versionId), assetPath, session.user_id);
      if (!asset) return res.status(404).json({ error: "阅读资源不存在。" });
      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Content-Length", String(asset.size));
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=3600");
      let released = false;
      const done = () => { if (!released) { released = true; release(); } };
      res.once("finish", done);
      res.once("close", done);
      res.once("error", done);
      const response = res.sendFile(path.basename(asset.absolute), { root: path.dirname(asset.absolute), dotfiles: "deny" }, (error) => {
        done();
        if (error && !res.headersSent) readerRequestError(res, error);
      });
      handedOff = true;
      return response;
    } catch (error) { return readerRequestError(res, error); }
    finally { if (!handedOff) release(); }
  });

  api.head("/reader/versions/:versionId/bytes", (req, res) => {
    const session = res.locals.session as SessionRow;
    let source: ReturnType<ReaderService["sourceFile"]>;
    try { source = reader.sourceFile(String(req.params.versionId), session.user_id); }
    catch (error) { return readerRequestError(res, error); }
    if (!source) return res.status(404).end();
    const format = reader.format(source.file);
    if (format !== "pdf" && format !== "epub") return res.status(415).end();
    const release = reader.reads.tryAcquire(session.user_id);
    if (!release) return res.status(429).setHeader("Retry-After", "1").end();
    try {
      // A successful metadata probe is still a reader call.  Touch before
      // ending HEAD so retention cannot evict an actively inspected source.
      db.touchReadingVersion(source.version.id, session.user_id);
      const stat = fs.lstatSync(source.absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not_file");
      if (stat.size !== source.file.size) return res.status(409).end();
      // HEAD has no response body, so it remains a successful metadata probe
      // even for a large PDF/EPUB. The 1 MiB ceiling applies to bytes actually
      // transferred by GET; a caller can still use Range on HEAD to validate
      // the exact bounded response it intends to request.
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", fileResponseContentType(source.file.mime_type));
      const range = parseReaderRange(typeof req.headers.range === "string" ? req.headers.range : undefined, stat.size, config.readerRangeMaxBytes);
      if (range) {
        res.status(206).setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`).setHeader("Content-Length", String(range.length));
      } else {
        res.setHeader("Content-Length", String(stat.size));
      }
      return res.end();
    } catch (error) {
      if (error instanceof ReaderRangeError || error instanceof ReaderIngestError) return readerRequestError(res, error);
      const availability = reader.ensureOriginalFileAvailable(source.file, session.user_id);
      if (availability === "restoring" || availability === "error") return readerRequestError(res, new ReaderUnavailableError());
      return readerRequestError(res, error);
    } finally { release(); }
  });

  api.get("/reader/versions/:versionId/bytes", (req, res) => {
    const session = res.locals.session as SessionRow;
    let source: ReturnType<ReaderService["sourceFile"]>;
    try { source = reader.sourceFile(String(req.params.versionId), session.user_id); }
    catch (error) { return readerRequestError(res, error); }
    if (!source) return res.status(404).json({ error: "阅读版本不存在。" });
    const format = reader.format(source.file);
    if (format !== "pdf" && format !== "epub") return res.status(415).json({ error: "该阅读版本不提供字节 Range 读取。" });
    const release = reader.reads.tryAcquire(session.user_id);
    if (!release) return res.status(429).setHeader("Retry-After", "1").json({ code: "READER_CONCURRENCY_LIMIT", error: `同一账号最多同时读取 ${config.readerMaxConcurrentReads} 个资源。` });
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      release();
      try { db.touchReadingVersion(source.version.id, session.user_id); } catch { /* shutdown may close the DB after the stream ends */ }
    };
    res.once("finish", done); res.once("close", done); res.once("error", done);
    try {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(source.absolute);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new ReaderIngestError("原文件不是普通文件。");
      }
      catch (error) {
        const availability = reader.ensureOriginalFileAvailable(source.file, session.user_id);
        if (availability === "restoring" || availability === "error") throw new ReaderUnavailableError();
        throw error;
      }
      if (stat.size !== source.file.size) { done(); return res.status(409).json({ error: "文件大小已变化，请重新打开阅读器。" }); }
      const range = parseReaderRange(typeof req.headers.range === "string" ? req.headers.range : undefined, stat.size, config.readerRangeMaxBytes);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", fileResponseContentType(source.file.mime_type));
      res.setHeader("Cache-Control", "private, no-store");
      if (!range) {
        if (stat.size > config.readerRangeMaxBytes) { res.setHeader("Content-Range", `bytes */${stat.size}`); done(); return res.status(416).json({ code: "READER_RANGE_REQUIRED", error: "大文件阅读必须使用 Range 请求。" }); }
        res.setHeader("Content-Length", String(stat.size));
        const stream = fs.createReadStream(source.absolute);
        stream.once("error", (error) => { done(); if (!res.headersSent) readerRequestError(res, error); else res.destroy(error); });
        return stream.pipe(res);
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
      res.setHeader("Content-Length", String(range.length));
      const stream = fs.createReadStream(source.absolute, { start: range.start, end: range.end });
      stream.once("error", (error) => { done(); if (!res.headersSent) readerRequestError(res, error); else res.destroy(error); });
      return stream.pipe(res);
    } catch (error) { done(); return readerRequestError(res, error); }
  });

  api.get("/reader/versions/:versionId/progress", (req, res) => {
    const session = res.locals.session as SessionRow;
    const versionId = String(req.params.versionId);
    if (!readerVersionForRequest(versionId, session)) return res.status(404).json({ error: "阅读版本不存在。" });
    db.touchReadingVersion(versionId, session.user_id);
    return res.json({ progress: db.getReadingProgress(versionId, session.user_id) ?? null });
  });

  api.put("/reader/versions/:versionId/progress", (req, res) => {
    const session = res.locals.session as SessionRow;
    const versionId = String(req.params.versionId);
    if (!readerVersionForRequest(versionId, session)) return res.status(404).json({ error: "阅读版本不存在。" });
    const unitId = req.body?.unitId == null ? null : String(req.body.unitId);
    if (unitId && !db.getReadingUnit(versionId, unitId, session.user_id)) return res.status(400).json({ error: "阅读单元不存在。" });
    const position = req.body?.position;
    if (!position || typeof position !== "object" || Array.isArray(position)) return res.status(400).json({ error: "阅读位置无效。" });
    const positionJson = JSON.stringify(position);
    if (positionJson.length > 8_192) return res.status(400).json({ error: "阅读位置过大。" });
    const progress = db.saveReadingProgress({ user_id: session.user_id, version_id: versionId, unit_id: unitId, position_json: positionJson });
    db.touchReadingVersion(versionId, session.user_id);
    return res.json({ progress });
  });

  api.get("/reader/versions/:versionId/annotations", (req, res) => {
    const session = res.locals.session as SessionRow;
    const versionId = String(req.params.versionId);
    if (!readerVersionForRequest(versionId, session)) return res.status(404).json({ error: "阅读版本不存在。" });
    db.touchReadingVersion(versionId, session.user_id);
    return res.json({ annotations: db.listReadingAnnotations(versionId, session.user_id) });
  });

  api.post("/reader/versions/:versionId/annotations", (req, res) => {
    const session = res.locals.session as SessionRow;
    const versionId = String(req.params.versionId);
    if (!readerVersionForRequest(versionId, session)) return res.status(404).json({ error: "阅读版本不存在。" });
    const type = req.body?.type as ReadingAnnotationType;
    const quoteText = typeof req.body?.quoteText === "string" ? req.body.quoteText.trim().slice(0, 20_000) : "";
    const noteTextInvalid = req.body?.noteText != null && typeof req.body.noteText !== "string";
    const noteText = req.body?.noteText == null ? null : typeof req.body.noteText === "string" ? req.body.noteText.trim().slice(0, 20_000) : null;
    const color = typeof req.body?.color === "string" && /^[a-z-]{1,20}$/i.test(req.body.color) ? req.body.color : "yellow";
    const locator = req.body?.locator;
    if (!(["highlight", "note"] as string[]).includes(type) || !quoteText || noteTextInvalid || (type === "note" && !noteText) || !locator || typeof locator !== "object" || Array.isArray(locator)) return res.status(400).json({ error: "标注内容无效。" });
    const locatorJson = JSON.stringify(locator);
    if (locatorJson.length > 8_192) return res.status(400).json({ error: "标注定位信息过大。" });
    const unitId = req.body?.unitId == null ? null : String(req.body.unitId);
    if (unitId && !db.getReadingUnit(versionId, unitId, session.user_id)) return res.status(400).json({ error: "阅读单元不存在。" });
    const annotation = db.createReadingAnnotation({ id: newId(), user_id: session.user_id, version_id: versionId, unit_id: unitId, type, quote_text: quoteText, note_text: noteText, color, locator_json: locatorJson });
    db.touchReadingVersion(versionId, session.user_id);
    return res.status(201).json({ annotation });
  });

  api.patch("/reader/annotations/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const existing = db.getReadingAnnotation(String(req.params.id), session.user_id);
    if (!existing) return res.status(404).json({ error: "标注不存在。" });
    if (!readerVersionForRequest(existing.version_id, session)) return res.status(404).json({ error: "阅读版本不存在。" });
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.noteText === "string") patch.note_text = req.body.noteText.trim().slice(0, 20_000);
    if (typeof req.body?.color === "string" && /^[a-z-]{1,20}$/i.test(req.body.color)) patch.color = req.body.color;
    const updated = db.updateReadingAnnotation(String(req.params.id), session.user_id, patch);
    db.touchReadingVersion(existing.version_id, session.user_id);
    return updated ? res.json({ annotation: updated }) : res.status(404).json({ error: "标注不存在。" });
  });

  api.delete("/reader/annotations/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const existing = db.getReadingAnnotation(String(req.params.id), session.user_id);
    if (!existing) return res.status(404).json({ error: "标注不存在。" });
    if (!readerVersionForRequest(existing.version_id, session)) return res.status(404).json({ error: "阅读版本不存在。" });
    const deleted = db.deleteReadingAnnotation(String(req.params.id), session.user_id);
    if (deleted) db.touchReadingVersion(existing.version_id, session.user_id);
    return deleted ? res.status(204).end() : res.status(404).json({ error: "标注不存在。" });
  });

  api.options(["/uploads", "/uploads/:id"], (req, res) => resumableUploads.options(req, res));
  api.post("/uploads", (req, res) => resumableUploads.create(req, res, res.locals.session as SessionRow));
  api.head("/uploads/:id", (req, res) => resumableUploads.head(req, res, res.locals.session as SessionRow));
  api.patch("/uploads/:id", (req, res) => resumableUploads.patch(req, res, res.locals.session as SessionRow));
  api.delete("/uploads/:id", (req, res) => resumableUploads.terminate(req, res, res.locals.session as SessionRow));
  api.get("/uploads/:id/result", (req, res) => resumableUploads.result(req, res, res.locals.session as SessionRow));

  api.post("/auth/logout", (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) db.deleteSession(hashToken(token, config.sessionSecret));
    res.clearCookie(COOKIE_NAME, { path: config.basePath || "/" });
    res.json({ ok: true });
  });

  api.get("/system/status", (_req, res) => {
    const session = res.locals.session as SessionRow;
    res.json(systemStatusPayload(session.user_id));
  });

  const codexAccountLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 6,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Codex 账号登录发起过于频繁，请稍后再试。" },
  });

  function codexAccountAdminSession(res: Response): SessionRow | null {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) {
      res.status(403).json({ error: "当前账号不能管理全局 Codex 账号。" });
      return null;
    }
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    return session;
  }

  function codexAccountExecutor(req: Request, res: Response): string | null {
    const value = typeof req.body?.executorId === "string" ? req.body.executorId
      : typeof req.query.executorId === "string" ? req.query.executorId
      : HOST_EXECUTOR_ID;
    const executor = remoteWorkers.executor(value);
    if (!executor) { res.status(404).json({ error: "执行机器不存在。" }); return null; }
    if (executor.status !== "online") { res.status(409).json({ error: `${executor.machineName} 当前离线。` }); return null; }
    if (!executor.codexAccountManagementCapable) { res.status(409).json({ error: "该节点需要先升级 Worker，才能管理 Codex 账号。" }); return null; }
    return value;
  }

  api.get("/codex-accounts", async (_req, res) => {
    const req = _req;
    const session = codexAccountAdminSession(res);
    if (!session) return;
    const executorId = codexAccountExecutor(req, res); if (!executorId) return;
    try { return res.json(await runner.listCodexAccounts(session.user_id, executorId)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Codex 账号读取失败。" }); }
  });

  api.post("/codex-accounts/logins", codexAccountLoginLimiter, async (req, res) => {
    const session = codexAccountAdminSession(res);
    if (!session) return;
    const executorId = codexAccountExecutor(req, res); if (!executorId) return;
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    try { return res.status(201).json({ login: await runner.beginCodexAccountLogin(session.user_id, label, executorId) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Codex 账号登录无法发起。" }); }
  });

  api.get("/codex-accounts/logins/:loginId", async (req, res) => {
    const session = codexAccountAdminSession(res);
    if (!session) return;
    const executorId = codexAccountExecutor(req, res); if (!executorId) return;
    try { return res.json({ login: await runner.codexAccountLoginStatus(session.user_id, String(req.params.loginId), executorId) }); }
    catch (error) { return res.status(404).json({ error: error instanceof Error ? error.message : "登录验证不存在。" }); }
  });

  api.delete("/codex-accounts/logins/:loginId", async (req, res) => {
    const session = codexAccountAdminSession(res);
    if (!session) return;
    const executorId = codexAccountExecutor(req, res); if (!executorId) return;
    try { return res.json({ login: await runner.cancelCodexAccountLogin(session.user_id, String(req.params.loginId), executorId) }); }
    catch (error) { return res.status(404).json({ error: error instanceof Error ? error.message : "登录验证不存在。" }); }
  });

  api.post("/codex-accounts/:accountId/activate", async (req, res) => {
    const session = codexAccountAdminSession(res);
    if (!session) return;
    const executorId = codexAccountExecutor(req, res); if (!executorId) return;
    try { return res.json(await runner.activateCodexAccount(session.user_id, String(req.params.accountId), executorId)); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "Codex 账号切换失败。" }); }
  });

  api.delete("/codex-accounts/:accountId", async (req, res) => {
    const session = codexAccountAdminSession(res);
    if (!session) return;
    const executorId = codexAccountExecutor(req, res); if (!executorId) return;
    try { return res.json(await runner.deleteCodexAccount(session.user_id, String(req.params.accountId), executorId)); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "Codex 账号删除失败。" }); }
  });

  api.get("/personal-memory/status", (_req, res) => {
    const session = res.locals.session as SessionRow;
    const tenant = ensureTenant(config.tenantRoot, session.user_id);
    let enabled = false;
    try { enabled = fs.lstatSync(path.join(tenant.library, "personal", "ENABLED")).isFile(); }
    catch { enabled = false; }
    return res.json({ enabled, configured: Boolean(config.personalMemoryApiKey && config.personalMemoryBaseUrl), ...db.getPersonalMemoryStatus(session.user_id) });
  });

  api.get("/personal-memory", (_req, res) => {
    const session = res.locals.session as SessionRow;
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    return res.json(personalMemoryManagementPayload(session.user_id));
  });

  api.get("/voice-lexicon", (_req, res) => {
    const session = res.locals.session as SessionRow;
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    return res.json(voiceLexiconManagementPayload(session.user_id));
  });

  api.post("/personal-memory/entries/:entryId/review", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    if (!(["accept", "reject", "correct", "forget"] as string[]).includes(action)) {
      return res.status(400).json({ error: "个人知识审核操作无效。" });
    }
    const statement = typeof req.body?.statement === "string" ? req.body.statement : undefined;
    try {
      const entry = db.reviewPersonalMemoryEntry(session.user_id, req.params.entryId, action as PersonalMemoryReviewAction, statement);
      if (!entry) return res.status(404).json({ error: "个人知识条目不存在。" });
      const tenant = ensureTenant(config.tenantRoot, session.user_id);
      await personalMemory.publishNow(session.user_id, tenant.library);
      res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
      return res.json(personalMemoryManagementPayload(session.user_id));
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "个人知识审核失败。" });
    }
  });

  api.put("/personal-memory/files/:fileName", (req, res) => {
    const session = res.locals.session as SessionRow;
    const fileName = req.params.fileName;
    const content = typeof req.body?.content === "string" ? req.body.content : null;
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!isPersonalMemoryEditableFileName(fileName)) return res.status(404).json({ error: "个人知识文件不存在。" });
    if (content === null) return res.status(400).json({ error: "个人知识文件内容无效。" });
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ error: "个人知识 revision 无效。" });
    const tenant = ensureTenant(config.tenantRoot, session.user_id);
    if (!personalMemoryEnabled(tenant.library)) return res.status(409).json({ error: "个人知识尚未启用。" });
    const previous = readPersonalMemoryManagedFiles(tenant.library).find((file) => file.name === fileName)?.content ?? "";
    try {
      writePersonalMemoryManagedFile(tenant.library, fileName, content);
      db.commitPersonalMemoryManualRevision({
        userId: session.user_id,
        expectedRevision,
        publishedFile: `personal/${fileName}`,
        publishedAt: new Date().toISOString(),
      });
    } catch (error) {
      try { writePersonalMemoryManagedFile(tenant.library, fileName, previous); } catch {}
      const message = error instanceof Error ? error.message : "个人知识文件保存失败。";
      const status = message === "PERSONAL_MEMORY_REVISION_CONFLICT" ? 409 : 400;
      return res.status(status).json({ error: status === 409 ? "个人知识已在其他位置更新，请重新加载后再保存。" : message });
    }
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    return res.json(personalMemoryManagementPayload(session.user_id));
  });

  api.get("/system/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Content-Encoding", "identity");
    res.flushHeaders();
    const session = res.locals.session as SessionRow;
    systemSubscribers.set(res, session.user_id);
    startSystemStatusMonitor();
    systemStatusSequence += 1;
    writeSse(res, systemStatusSequence, "system_status", systemStatusPayload(session.user_id));
    if (isHostRootUser(session.user_id)) writeSse(res, systemStatusSequence, "executor_status", { executors: remoteWorkers.listExecutors() });
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      systemSubscribers.delete(res);
      stopSystemStatusMonitorIfIdle();
    });
  });

  api.get("/projects", (_req, res) => {
    const session = res.locals.session as SessionRow;
    const projects = db.listProjects(session.user_id).map((project) => projectView(project));
    return res.json({ projects, canManageProjects: true, defaultProjectId: db.getDefaultProject(session.user_id)?.id ?? null });
  });

  api.post("/remote-worker-bootstrap", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能创建远程 Worker。" });
    const baseUrl = config.publicBaseUrl.replace(/\/$/, "") || `http://127.0.0.1:${config.port}${config.basePath}`;
    try {
      const platforms = (["win32-x64", "darwin-universal"] as const).map((platform) => {
        const grant = remoteWorkers.createBootstrapGrant(platform);
        return {
          platform,
          label: platform === "win32-x64" ? "Windows" : "macOS",
          url: `${baseUrl}/api/remote-worker-bootstrap/${platform}/${encodeURIComponent(grant.token)}`,
          expiresAt: grant.expiresAt,
        };
      });
      return res.status(201).json({ version: remoteWorkers.releaseManifest()?.version ?? null, platforms });
    } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "Worker 安装包暂不可用。" }); }
  });

  api.get("/executors", (_req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json({ executors: isHostRootUser(session.user_id) ? remoteWorkers.listExecutors() : [tenantExecutorView()] });
  });

  api.post("/executors/:executorId/runtime/refresh", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能管理执行机器。" });
    const executorId = String(req.params.executorId);
    if (!remoteWorkers.executor(executorId)) return res.status(404).json({ error: "执行机器不存在。" });
    db.upsertExecutorRuntime(executorId, { updateState: "checking", updateError: null });
    try {
      const runtime = await runner.refreshExecutorRuntime(session.user_id, executorId, true);
      db.upsertExecutorRuntime(executorId, { ...runtime, updateState: "idle", updateError: null });
      remoteWorkers.emit("status", executorId);
      return res.json({ runtime: db.getExecutorRuntime(executorId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex 信息刷新失败";
      db.upsertExecutorRuntime(executorId, { updateState: "failed", updateError: message });
      remoteWorkers.emit("status", executorId);
      return res.status(409).json({ error: message });
    }
  });

  api.post("/executors/:executorId/codex/upgrade", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能管理执行机器。" });
    const executorId = String(req.params.executorId);
    const executor = remoteWorkers.executor(executorId);
    if (!executor) return res.status(404).json({ error: "执行机器不存在。" });
    if (executor.status !== "online") return res.status(409).json({ error: `${executor.machineName} 当前离线。` });
    if (executor.activeJobs > 0 || db.countRunningJobsForExecutor(executorId) > 0) return res.status(409).json({ error: "目标机器仍有任务执行，暂不能升级 Codex。" });
    const current = db.getExecutorRuntime(executorId);
    const version = current?.latestVersion;
    if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return res.status(409).json({ error: "请先检查 Codex 最新版本。" });
    if (current.installedVersion === version) return res.json({ accepted: false, runtime: current });
    db.upsertExecutorRuntime(executorId, { updateState: "updating", updateError: null });
    remoteWorkers.emit("status", executorId);
    try {
      const runtime = await runner.upgradeExecutorCodex(session.user_id, executorId, version);
      db.upsertExecutorRuntime(executorId, { ...runtime, updateState: "idle", updateError: null });
      remoteWorkers.emit("status", executorId);
      return res.status(202).json({ accepted: true, runtime: db.getExecutorRuntime(executorId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex 升级失败";
      db.upsertExecutorRuntime(executorId, { updateState: "failed", updateError: message });
      remoteWorkers.emit("status", executorId);
      return res.status(409).json({ error: message });
    }
  });

  api.post("/executors/:executorId/worker/upgrade", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能管理执行机器。" });
    try {
      const result = remoteWorkers.requestWorkerUpdate(String(req.params.executorId));
      return res.status(result.accepted ? 202 : 200).json(result);
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : "Worker 升级请求失败" });
    }
  });

  api.put("/executors/:executorId/capacity", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能管理执行机器。" });
    try {
      const executor = await remoteWorkers.setCapacity(String(req.params.executorId), req.body?.capacity);
      return res.json({ executor });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker 并发容量修改失败";
      return res.status(/不存在/.test(message) ? 404 : 409).json({ error: message });
    }
  });

  api.get("/executors/:executorId/project-directories", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const executorId = String(req.params.executorId);
    const directory = typeof req.query.path === "string" ? req.query.path.trim() : "";
    try { return res.json(await runner.projectDirectories(session.user_id, executorId, directory)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "文件夹读取失败。" }); }
  });

  api.post("/executors/:executorId/project-directories", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const executorId = String(req.params.executorId);
    const parent = typeof req.body?.parent === "string" ? req.body.parent.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    try { return res.status(201).json(await runner.createProjectDirectory(session.user_id, executorId, parent, name)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "文件夹创建失败。" }); }
  });

  api.get("/project-directories", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能切换项目文件夹。" });
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Sun, 01 Nov 2026 00:00:00 GMT");
    res.setHeader("Link", `</api/executors/${encodeURIComponent(HOST_EXECUTOR_ID)}/project-directories>; rel=\"successor-version\"`);
    console.warn(JSON.stringify({ level: "warn", event: "legacy_project_directories_used", requestId: res.locals.requestId, method: req.method, userId: session.user_id }));
    const directory = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path.trim() : path.dirname(config.hostKnowledgeRoot);
    try { return res.json(await runner.projectDirectories(session.user_id, HOST_EXECUTOR_ID, directory)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "文件夹读取失败。" }); }
  });

  api.post("/project-directories", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能创建项目文件夹。" });
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Sun, 01 Nov 2026 00:00:00 GMT");
    res.setHeader("Link", `</api/executors/${encodeURIComponent(HOST_EXECUTOR_ID)}/project-directories>; rel=\"successor-version\"`);
    console.warn(JSON.stringify({ level: "warn", event: "legacy_project_directories_used", requestId: res.locals.requestId, method: req.method, userId: session.user_id }));
    const parent = typeof req.body?.parent === "string" ? req.body.parent.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    try { return res.status(201).json(await runner.createProjectDirectory(session.user_id, HOST_EXECUTOR_ID, parent, name)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "文件夹创建失败。" }); }
  });

  api.post("/projects", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    const rootPath = typeof req.body?.rootPath === "string" ? req.body.rootPath.trim() : "";
    const executorId = typeof req.body?.executorId === "string"
      ? req.body.executorId.trim()
      : isHostRootUser(session.user_id) ? HOST_EXECUTOR_ID : TENANT_LOCAL_EXECUTOR_ID;
    if (!name) return res.status(400).json({ error: "项目名称不能为空。" });
    try {
      const executor = executorView(executorId);
      if (!executor || (!isHostRootUser(session.user_id) && executorId !== TENANT_LOCAL_EXECUTOR_ID)) return res.status(400).json({ error: "执行机器不存在。" });
      const validated = await runner.validateProjectDirectory(session.user_id, executorId, rootPath);
      const existing = db.getProjectByRootForUser(validated.directory, session.user_id, executorId);
      if (existing && !existing.archived_at) return res.status(409).json({ error: "这个文件夹已经是一个项目。" });
      await runner.initializeProjectDirectory(session.user_id, executorId, validated.directory, projectAgentsTemplate);
      const project = existing
        ? db.restoreProjectForUser(existing.id, session.user_id, name)
        : db.createProject(newId(), session.user_id, name, validated.directory, executorId);
      if (!project) return res.status(409).json({ error: "项目状态已经变化，请刷新后重试。" });
      remoteWorkers.refreshProjectWatches(project.executor_id);
      const listed = db.listProjects(session.user_id).find((candidate) => candidate.id === project.id);
      return res.status(201).json({ project: projectView(listed ?? { ...project, conversation_count: 0 }), restored: Boolean(existing) });
    } catch (error) {
      const message = error instanceof Error && /UNIQUE constraint/.test(error.message) ? "这个文件夹已经是一个项目。" : error instanceof Error ? error.message : "项目创建失败。";
      return res.status(400).json({ error: message });
    }
  });

  function projectForSkillManagement(response: Response, session: SessionRow, projectId: string): { project: ProjectRow; rootPath: string } | { response: Response } {
    const project = db.getActiveProjectForUser(projectId, session.user_id);
    if (!project) return { response: response.status(404).json({ error: "项目不存在。" }) };
    if (project.executor_id !== TENANT_LOCAL_EXECUTOR_ID) {
      return { response: response.status(409).json({ code: "project_skills_unsupported", error: "宿主项目和远端项目暂不支持网页管理项目技能；请在对应执行机的项目目录中维护。" }) };
    }
    try {
      const tenant = ensureTenant(config.tenantRoot, session.user_id);
      return { project, rootPath: assertTenantProjectRoot(tenant, project.root_path) };
    } catch (error) {
      return { response: response.status(409).json({ error: error instanceof Error ? error.message : "项目路径无效。" }) };
    }
  }

  api.get("/projects/:id/skills", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try { return res.json({ supported: true, skills: listProjectSkills(selected.rootPath) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "项目技能读取失败。" }); }
  });

  api.get("/projects/:id/skills/:name", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try { return res.json({ skill: readProjectSkill(selected.rootPath, String(req.params.name)) }); }
    catch (error) { return res.status(404).json({ error: error instanceof Error ? error.message : "项目技能不存在。" }); }
  });

  api.post("/projects/:id/skills", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      return res.status(201).json({ skill: createProjectSkill(selected.rootPath, name, content, req.body?.enabled !== false) });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "项目技能创建失败。" }); }
  });

  api.put("/projects/:id/skills/:name", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try {
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      return res.json({ skill: updateProjectSkill(selected.rootPath, String(req.params.name), content) });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "项目技能保存失败。" }); }
  });

  api.post("/projects/:id/skills/:name/enable", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try { return res.json({ skill: setProjectSkillEnabled(selected.rootPath, String(req.params.name), true) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "项目技能启用失败。" }); }
  });

  api.post("/projects/:id/skills/:name/disable", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try { return res.json({ skill: setProjectSkillEnabled(selected.rootPath, String(req.params.name), false) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "项目技能停用失败。" }); }
  });

  api.delete("/projects/:id/skills/:name", (req, res) => {
    const session = res.locals.session as SessionRow;
    const selected = projectForSkillManagement(res, session, String(req.params.id));
    if ("response" in selected) return selected.response;
    try { deleteProjectSkill(selected.rootPath, String(req.params.name)); return res.json({ ok: true }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "项目技能删除失败。" }); }
  });

  api.patch("/projects/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    if (!name) return res.status(400).json({ error: "项目名称不能为空。" });
    const project = db.renameProjectForUser(String(req.params.id), session.user_id, name);
    return project ? res.json({ project: projectView(project) }) : res.status(404).json({ error: "项目不存在。" });
  });

  api.post("/projects/:id/archive", (req, res) => {
    const session = res.locals.session as SessionRow;
    const projectId = String(req.params.id);
    const current = db.getActiveProjectForUser(projectId, session.user_id);
    if (current?.is_default) return res.status(409).json({ error: "默认项目不能归档。" });
    if (syncingProjects.has(projectId)) return res.status(409).json({ error: "项目正在同步，请稍后再归档。" });
    if (db.listConversations(session.user_id).some((conversation) => conversation.project_id === projectId && conversation.project_move_blocked)) {
      return res.status(409).json({ error: "项目内仍有运行、排队或等待唤醒的任务，请先处理完成。" });
    }
    const project = db.archiveProjectForUser(projectId, session.user_id);
    if (project) remoteWorkers.refreshProjectWatches(project.executor_id);
    return project ? res.json({ project: projectView(project) }) : res.status(404).json({ error: "项目不存在。" });
  });

  api.put("/projects/order", (req, res) => {
    const session = res.locals.session as SessionRow;
    const projectIds = Array.isArray(req.body?.projectIds) && req.body.projectIds.every((id: unknown) => typeof id === "string")
      ? req.body.projectIds as string[]
      : [];
    if (!db.reorderProjectsForUser(session.user_id, projectIds)) return res.status(400).json({ error: "项目顺序无效，请刷新后重试。" });
    return res.json({ ok: true });
  });

  api.put("/projects/:id/sidebar-collapsed", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (typeof req.body?.collapsed !== "boolean") return res.status(400).json({ error: "项目展开状态无效。" });
    const project = db.setProjectSidebarCollapsedForUser(String(req.params.id), session.user_id, req.body.collapsed);
    return project ? res.json({ project: projectView(project) }) : res.status(404).json({ error: "项目不存在。" });
  });

  api.post("/projects/:id/sync", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能同步远程项目。" });
    const project = db.getActiveProjectForUser(String(req.params.id), session.user_id);
    if (!project) return res.status(404).json({ error: "项目不存在。" });
    if (!workerIdFromExecutor(project.executor_id)) return res.status(400).json({ error: "服务器本地项目不需要同步。" });
    if (syncingProjects.has(project.id)) return res.status(409).json({ error: "这个项目正在同步，请稍候。" });
    syncingProjects.add(project.id);
    try {
      const selection = userAgentSelection(session.user_id, optionsForExecutor(session.user_id, project.executor_id));
      let cursor: string | null = null;
      let scanned = 0;
      let created = 0;
      let updated = 0;
      let importedMessages = 0;
      let importedActivities = 0;
      let running = 0;
      let pages = 0;
      const syncedThreads: Array<{ id: string; createdAt: number; updatedAt: number }> = [];
      do {
        // A single Codex rollout can be hundreds of MB. Give each thread its
        // own bounded page budget instead of making several large thread/read
        // calls compete for the same timeout window.
        const page = await remoteWorkers.projectThreadsPage(project.executor_id, project.root_path, cursor, 1);
        for (const thread of page.threads) {
          const result = db.importRemoteThread(session.user_id, project.id, project.executor_id, thread, selection);
          scheduleImportedConversationTitle(result.conversation.id);
          if (result.created) syncedThreads.push({ id: thread.id, createdAt: thread.createdAt, updatedAt: thread.updatedAt });
          scanned += 1;
          if (result.created) created += 1;
          else if (result.changed) updated += 1;
          importedMessages += result.importedMessages;
          importedActivities += result.importedActivities;
          if (thread.status === "running") running += 1;
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 500);
      db.applyRemoteThreadOrderForUser(session.user_id, project.id, syncedThreads);
      if (config.queueAutoStart) scheduleQueuePump();
      return res.json({ ok: true, scanned, created, updated, importedMessages, importedActivities, running, truncated: Boolean(cursor), syncedAt: new Date().toISOString() });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : "远程项目同步失败。" });
    } finally {
      syncingProjects.delete(project.id);
    }
  });

  api.get("/conversations", (req, res) => {
    const session = res.locals.session as SessionRow;
    const requestedProjectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const project = requestedProjectId ? db.getActiveProjectForUser(requestedProjectId, session.user_id) : undefined;
    if (requestedProjectId && !project) return res.status(404).json({ error: "项目不存在。" });
    const page = db.listConversationPage(session.user_id, {
      projectId: requestedProjectId || undefined,
      query: typeof req.query.query === "string" ? req.query.query : "",
      limit: Number(req.query.limit ?? 20),
      offset: Number(req.query.offset ?? 0),
    });
    return res.json(page);
  });

  api.get("/conversations/search-body", (req, res) => {
    const session = res.locals.session as SessionRow;
    const requestedProjectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const project = requestedProjectId ? db.getActiveProjectForUser(requestedProjectId, session.user_id) : undefined;
    if (requestedProjectId && !project) return res.status(404).json({ error: "项目不存在。" });
    return res.json(db.listConversationBodySearchPage(session.user_id, {
      projectId: requestedProjectId || undefined,
      query: typeof req.query.query === "string" ? req.query.query : "",
      limit: Number(req.query.limit ?? 1),
      offset: Number(req.query.offset ?? 0),
    }));
  });

  api.get("/conversation-selection", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const project = projectId ? db.getActiveProjectForUser(projectId, session.user_id) : undefined;
    const conversation = conversationId ? db.getConversationForUser(conversationId, session.user_id) : undefined;
    const valid = Boolean(project && conversation && !conversation.archived_at && conversation.project_id === project.id);
    return res.json({
      valid,
      conversationId: valid ? conversation!.id : null,
      projectId: valid ? project!.id : null,
    });
  });

  api.get("/conversations/archived", (req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json(db.listArchivedConversationPage(session.user_id, {
      query: typeof req.query.query === "string" ? req.query.query : "",
      limit: Number(req.query.limit ?? 100),
      offset: Number(req.query.offset ?? 0),
    }));
  });

  api.get("/agent-options", (req, res) => {
    const session = res.locals.session as SessionRow;
    const requestedConversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    const requestedConversation = requestedConversationId ? db.getConversationForUser(requestedConversationId, session.user_id) : undefined;
    if (requestedConversationId && !requestedConversation) return res.status(404).json({ error: "会话不存在。" });
    const requestedProjectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const requestedProject = requestedProjectId ? db.getActiveProjectForUser(requestedProjectId, session.user_id) : undefined;
    if (requestedProjectId && !requestedProject) return res.status(404).json({ error: "项目不存在。" });
    const conversationProject = requestedConversation?.project_id
      ? db.getProjectForUser(requestedConversation.project_id, session.user_id)
      : undefined;
    const requestedExecutor = isHostRootUser(session.user_id) && typeof req.query.executorId === "string"
      ? req.query.executorId
      : requestedProject?.executor_id ?? conversationProject?.executor_id;
    const options = optionsForExecutor(session.user_id, requestedExecutor);
    return res.json({
      ...options,
      selection: requestedConversation
        ? conversationAgentSelection(requestedConversation, options)
        : userAgentSelection(session.user_id, options),
    });
  });

  api.put("/agent-selection", (req, res) => {
    const session = res.locals.session as SessionRow;
    try { return res.json({ selection: saveAgentSelection(session.user_id, req.body?.model, req.body?.reasoningEffort, undefined, typeof req.body?.executorId === "string" ? req.body.executorId : undefined) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "模型选项无效。" }); }
  });

  api.put("/user-settings/chat-font-size", (req, res) => {
    const session = res.locals.session as SessionRow;
    const rawValue = req.body?.chatFontSize;
    if ((typeof rawValue !== "number" && typeof rawValue !== "string") || !Number.isFinite(Number(rawValue))) {
      return res.status(400).json({ error: "字号设置无效。" });
    }
    const chatFontSize = db.setChatFontSize(normalizeChatFontSize(rawValue, CHAT_FONT_SIZE_DEFAULT), session.user_id);
    return res.json({ chatFontSize });
  });

  api.post("/conversations", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (req.body?.reuseEmpty !== undefined && typeof req.body.reuseEmpty !== "boolean") {
      return res.status(400).json({ error: "新任务复用选项无效。" });
    }
    const requestedProjectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const project = requestedProjectId
      ? db.getActiveProjectForUser(requestedProjectId, session.user_id)
      : db.getDefaultProject(session.user_id);
    if (!project) return res.status(400).json({ error: "请先选择项目。" });
    const reuseEmpty = req.body?.reuseEmpty !== false;
    if (reuseEmpty) {
      const reusable = db.reuseEmptyConversationForNewTask(session.user_id, project.id);
      if (reusable) {
        return res.json({ conversation: reusable, agentSelection: conversationAgentSelection(reusable), reused: true });
      }
    }
    const id = newId();
    const agentSelection = userAgentSelection(session.user_id, optionsForExecutor(session.user_id, project.executor_id));
    const workspace = ensureTenantWorkspace(config.tenantRoot, session.user_id, id);
    try {
      const result = reuseEmpty
        ? db.createOrReuseEmptyConversation(id, agentSelection, session.user_id, project.id)
        : { conversation: db.createConversation(id, "新任务", agentSelection, session.user_id, project.id), reused: false };
      if (result.reused) fs.rmSync(workspace, { recursive: true, force: true });
      return res.status(result.reused ? 200 : 201).json({
        conversation: result.conversation,
        agentSelection: result.reused ? conversationAgentSelection(result.conversation) : agentSelection,
        reused: result.reused,
      });
    } catch (error) {
      fs.rmSync(workspace, { recursive: true, force: true });
      throw error;
    }
  });

  api.post("/conversations/:id/archive", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.json({ conversation });
    const hasWork = conversation.status === "running"
      || conversation.external_status === "running"
      || conversation.active_wake_count > 0
      || db.listActiveJobsForConversation(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id, "editing").length > 0;
    if (hasWork) return res.status(409).json({ error: "会话仍在运行或有待发送任务，请处理完成后再归档。" });
    const archived = db.archiveConversationForUser(conversation.id, session.user_id);
    return archived ? res.json({ conversation: archived }) : res.status(409).json({ error: "会话归档状态已经变化。" });
  });

  api.post("/conversations/:id/restore", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (!conversation.archived_at) return res.json({ conversation });
    if (conversation.project_id && !db.getActiveProjectForUser(conversation.project_id, session.user_id)) {
      return res.status(409).json({ error: "所属项目目前已归档，请先恢复项目。" });
    }
    const restored = db.restoreConversationForUser(conversation.id, session.user_id);
    return restored ? res.json({ conversation: restored }) : res.status(409).json({ error: "会话归档状态已经变化。" });
  });

  api.post("/conversations/:id/activate", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const activated = activateConversation(conversation);
    if (activated.state === "error") return res.status(503).json({ code: "COLD_STORAGE_RESTORE_FAILED", state: activated.state, conversation: activated.conversation, error: activated.conversation.cold_storage_error || "历史恢复失败，请稍后重试。" });
    return res.status(activated.state === "local" ? 200 : 202).json({ state: activated.state, restoring: activated.state === "restoring", conversation: activated.conversation });
  });

  api.get("/conversations/:id", async (req, res) => {
    const session = res.locals.session as SessionRow;
    let conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") {
      return res.status(202).json({ restoring: true, state: conversation.cold_storage_state, conversation });
    }
    const rolloutBytes = await runner.conversationRolloutBytes(conversation.id).catch(() => conversation!.rollout_bytes);
    if (rolloutBytes !== conversation.rollout_bytes) {
      db.setConversationRolloutBytes(conversation.id, rolloutBytes);
      conversation = db.getConversationForUser(conversation.id, session.user_id)!;
    }
    const activity = conversationActivityPayload(conversation);
    const messagePage = db.listMessagesPage(conversation.id, undefined, conversationMessagePageSize(req.query.limit))!;
    const safeMessages = safeConversationMessages(conversation, messagePage.messages);
    const agentSelection = conversationAgentSelection(conversation);
    const pendingPrompts = db.listPendingPrompts(conversation.id);
    const editingPrompt = db.listPendingPrompts(conversation.id, "editing")[0] ?? null;
    const composerDraft = db.getComposerDraft(conversation.id) ?? null;
    const wakePlan = db.getActiveWakePlan(conversation.id) ?? null;
    return res.json({
      conversation,
      agentSelection,
      messages: safeMessages,
      messagePage: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
      pendingPrompts,
      editingPrompt,
      composerDraft,
      wakePlan: publicWakePlan(wakePlan),
      wakeEvents: wakePlan ? db.listWakeEvents(wakePlan.id) : [],
      ...activity,
      rolloutBytes,
      contextUsage: conversation.context_input_tokens === null
        ? null
        : {
          inputTokens: conversation.context_input_tokens,
          modelContextWindow: conversation.context_window_tokens,
          updatedAt: conversation.context_usage_updated_at,
        },
      packageQuota: db.getConversationCodexQuota(conversation.id),
    });
  });

  api.get("/conversations/:id/activity", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    return res.json(conversationActivityPayload(conversation));
  });

  api.get("/conversations/:id/wake-plans/active", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    return res.json({ wakePlan: publicWakePlan(db.getActiveWakePlan(conversation.id)) });
  });

  api.post("/conversations/:id/wake-plans", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档。" });
    const deadlineAt = wakeDeadline(req.body?.delaySeconds);
    const prompt = wakeText(req.body?.prompt);
    if ((req.body?.newConversation !== undefined && typeof req.body.newConversation !== "boolean")
      || (req.body?.model !== undefined && typeof req.body.model !== "string")
      || (req.body?.reasoningEffort !== undefined && typeof req.body.reasoningEffort !== "string")
      || !deadlineAt || !prompt) return res.status(400).json({ error: "等待时间、续跑位置或续跑配置无效。" });
    try {
      const inheritedSelection = conversationAgentSelection(conversation);
      const selection = req.body?.model !== undefined || req.body?.reasoningEffort !== undefined
        ? resolveAgentSelection(
          optionsForConversation(conversation),
          req.body?.model ?? inheritedSelection.model,
          req.body?.reasoningEffort ?? inheritedSelection.reasoningEffort,
        )
        : inheritedSelection;
      const plan = db.createWakePlan({
        id: newId(),
        conversationId: conversation.id,
        mode: "time",
        label: wakeText(req.body?.label, 120) || "定时自动继续",
        deadlineAt,
        successPrompt: prompt,
        failurePrompt: prompt,
        timeoutPrompt: prompt,
        newConversation: req.body?.newConversation === true,
        selection,
      });
      const sourceConversation = db.getConversation(conversation.id)!;
      const targetConversation = plan.target_conversation_id ? db.getConversation(plan.target_conversation_id) : undefined;
      publishConversationChanged(sourceConversation);
      if (targetConversation && targetConversation.id !== sourceConversation.id) publishConversationChanged(targetConversation);
      return res.status(201).json({
        wakePlan: publicWakePlan(plan),
        targetConversation: targetConversation
          ? { id: targetConversation.id, title: targetConversation.title, projectId: targetConversation.project_id }
          : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "等待计划创建失败。";
      return res.status(/UNIQUE constraint/i.test(message) ? 409 : 400).json({ error: /UNIQUE constraint/i.test(message) ? "这个会话已经有一个等待计划。" : message });
    }
  });

  api.post("/conversations/:id/wake-plans/:planId/cancel", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    const plan = conversation ? db.getWakePlanForUser(String(req.params.planId), session.user_id) : undefined;
    if (!conversation || !plan || plan.conversation_id !== conversation.id) return res.status(404).json({ error: "等待计划不存在。" });
    const cancelled = db.cancelWakePlan(plan.id);
    publishConversationChanged(db.getConversation(conversation.id)!);
    if (cancelled && config.queueAutoStart) scheduleQueuePump();
    return cancelled ? res.json({ wakePlan: publicWakePlan(cancelled) }) : res.status(409).json({ error: "等待计划已经触发或取消。" });
  });

  api.post("/conversations/:id/wake-plans/:planId/reschedule", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    const plan = conversation ? db.getWakePlanForUser(String(req.params.planId), session.user_id) : undefined;
    if (!conversation || !plan || plan.conversation_id !== conversation.id) return res.status(404).json({ error: "等待计划不存在。" });
    const usesDelay = req.body?.delaySeconds !== undefined;
    const usesDeadline = req.body?.deadlineAt !== undefined;
    if (usesDelay === usesDeadline) return res.status(400).json({ error: "请提供一个有效的等待时长或安排时间。" });
    const deadlineAt = usesDeadline
      ? absoluteWakeDeadline(req.body.deadlineAt)
      : relativeWakeDeadline(plan.deadline_at, req.body.delaySeconds);
    if (!deadlineAt) return res.status(400).json({ error: "等待时间无效。" });
    const updated = db.rescheduleWakePlan(plan.id, deadlineAt);
    if (!updated) return res.status(409).json({ error: "等待计划已经触发或取消。" });
    publishConversationChanged(db.getConversation(conversation.id)!);
    if (Date.parse(updated.deadline_at) <= Date.now()) {
      recordWakeEvent(updated.id, `deadline:${updated.deadline_at}`, "deadline", null);
    }
    const current = db.getWakePlan(updated.id)!;
    return res.json({ wakePlan: publicWakePlan(current), triggered: current.state === "triggered" });
  });

  api.patch("/conversations/:id/wake-plans/:planId/prompts", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    const plan = conversation ? db.getWakePlanForUser(String(req.params.planId), session.user_id) : undefined;
    if (!conversation || !plan || plan.conversation_id !== conversation.id) {
      return res.status(404).json({ code: "WAKE_PLAN_NOT_FOUND", error: "等待计划不存在。" });
    }
    const body = req.body;
    const allowedFields = plan.mode === "time"
      ? new Set(["revision", "successPrompt", "model", "reasoningEffort"])
      : new Set(["revision", "successPrompt", "failurePrompt", "timeoutPrompt", "model", "reasoningEffort"]);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowedFields.has(key))) {
      return res.status(400).json({ code: "WAKE_PROMPTS_INVALID", error: "续跑提示词请求包含不允许的字段。" });
    }
    const expectedRevision = Number(body.revision);
    const successPrompt = editableWakePrompt(body.successPrompt);
    const failurePrompt = plan.mode === "time" ? successPrompt : editableWakePrompt(body.failurePrompt);
    const timeoutPrompt = plan.mode === "time" ? successPrompt : editableWakePrompt(body.timeoutPrompt);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !successPrompt || !failurePrompt || !timeoutPrompt) {
      return res.status(400).json({ code: "WAKE_PROMPTS_INVALID", error: "续跑提示词不能为空，且每段不能超过 20,000 个字符。" });
    }
    if ((body.model !== undefined && typeof body.model !== "string")
      || (body.reasoningEffort !== undefined && typeof body.reasoningEffort !== "string")) {
      return res.status(400).json({ code: "WAKE_SELECTION_INVALID", error: "续跑模型或思考深度无效。" });
    }
    let selection: AgentSelection | undefined;
    if (body.model !== undefined || body.reasoningEffort !== undefined) {
      try {
        selection = resolveAgentSelection(
          optionsForConversation(conversation),
          body.model ?? plan.agent_model,
          body.reasoningEffort ?? plan.reasoning_effort,
        );
      } catch (error) {
        return res.status(400).json({ code: "WAKE_SELECTION_INVALID", error: error instanceof Error ? error.message : "续跑模型或思考深度无效。" });
      }
    }
    const updated = db.updateWakePlanPrompts({
      id: plan.id,
      expectedRevision,
      successPrompt,
      failurePrompt,
      timeoutPrompt,
      selection,
    });
    if (!updated) {
      return res.status(409).json({
        code: "WAKE_PLAN_CONFLICT",
        error: "等待计划已被其他页面修改、已经触发或取消，请刷新后重试。",
      });
    }
    publishConversationChanged(db.getConversation(conversation.id)!);
    return res.json({ wakePlan: publicWakePlan(updated) });
  });

  api.post("/conversations/:id/wake-plans/:planId/trigger", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    const plan = conversation ? db.getWakePlanForUser(String(req.params.planId), session.user_id) : undefined;
    if (!conversation || !plan || plan.conversation_id !== conversation.id) return res.status(404).json({ error: "等待计划不存在。" });
    const result = recordWakeEvent(plan.id, `manual:${crypto.randomUUID()}`, "manual", "用户手动立即继续");
    return result.status === "triggered" ? res.json({ status: result.status, wakePlan: publicWakePlan(result.plan) }) : res.status(409).json({ error: "等待计划已经触发或取消。" });
  });

  api.get("/conversations/:id/messages", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const before = typeof req.query.before === "string" ? req.query.before : "";
    if (!before) return res.status(400).json({ error: "缺少消息游标。" });
    const messagePage = db.listMessagesPage(conversation.id, before, conversationMessagePageSize(req.query.limit));
    if (!messagePage) return res.status(400).json({ error: "消息游标无效。" });
    return res.json({
      messages: safeConversationMessages(conversation, messagePage.messages),
      messagePage: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
    });
  });

  api.patch("/conversations/:id", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 80) : "";
    if (!title) return res.status(400).json({ error: "标题不能为空。" });
    db.updateConversation(conversation.id, { title, titleSource: "manual" });
    await runner.renameRemoteThread(conversation.id, title).catch(() => undefined);
    return res.json({ conversation: db.getConversationForUser(conversation.id, session.user_id) });
  });

  api.put("/conversations/:id/pin", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (typeof req.body?.pinned !== "boolean") return res.status(400).json({ error: "置顶状态无效。" });
    const conversation = db.setConversationPinnedForUser(String(req.params.id), session.user_id, req.body.pinned);
    return conversation ? res.json({ conversation }) : res.status(404).json({ error: "会话不存在。" });
  });

  api.put("/conversations/:id/sidebar-position", (req, res) => {
    const session = res.locals.session as SessionRow;
    const targetId = typeof req.body?.targetId === "string" ? req.body.targetId : "";
    const placement = req.body?.placement === "before" || req.body?.placement === "after" ? req.body.placement : null;
    if (!targetId || !placement) return res.status(400).json({ error: "任务顺序无效。" });
    if (!db.moveConversationForUser(session.user_id, String(req.params.id), targetId, placement)) {
      return res.status(400).json({ error: "任务只能在所属项目及相同置顶分组内拖动。" });
    }
    return res.json({ ok: true });
  });

  api.put("/conversations/:id/project", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversationId = String(req.params.id);
    const targetProjectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    if (!targetProjectId) return res.status(400).json({ error: "目标项目无效。" });
    if (deletingConversations.has(conversationId)) return res.status(409).json({ error: "会话正在删除，暂时不能移动。" });
    const requiredExecutorId = isHostRootUser(session.user_id) ? HOST_EXECUTOR_ID : TENANT_LOCAL_EXECUTOR_ID;
    const result = db.moveConversationToProjectForUser(session.user_id, conversationId, targetProjectId, requiredExecutorId);
    if (result.status === "not_found") return res.status(404).json({ error: "会话不存在或已归档。" });
    if (result.status === "project_unavailable") return res.status(404).json({ error: "来源或目标项目不存在、已归档。" });
    if (result.status === "unsupported_executor") return res.status(409).json({ error: "任务只能在同一个本地工作区的项目之间移动。" });
    if (result.status === "busy") return res.status(409).json({ error: "会话仍在运行或有排队、待发送内容，暂时不能移动。" });
    if (result.status === "moved") publishConversationMoved(result.conversation, result.fromProjectId, result.toProjectId);
    return res.json({
      conversation: result.conversation,
      fromProjectId: result.fromProjectId,
      toProjectId: result.toProjectId,
      moved: result.status === "moved",
    });
  });

  api.post("/conversations/:id/seen", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.markConversationResultSeenForUser(String(req.params.id), session.user_id);
    if (conversation) db.touchConversationActivity(conversation.id);
    return conversation ? res.json({ conversation }) : res.status(404).json({ error: "会话不存在。" });
  });

  api.put("/conversations/:id/agent-selection", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    try { return res.json({ selection: saveAgentSelection(session.user_id, req.body?.model, req.body?.reasoningEffort, conversation) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "模型选项无效。" }); }
  });

  api.post("/conversations/:id/cancel", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    try {
      await stopConversationJobs(conversation.id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : "停止任务失败。" });
    }
  });

  async function garbageCollectConversation(conversation: ConversationRow): Promise<void> {
    // The tombstone prevents new queue admission. Drain the existing execution
    // before touching file metadata so GC cannot race a job's finalization saga.
    await stopConversationJobs(conversation.id, false);
    await resumableUploads.cancelConversationUploads(conversation.id);
    for (const prompt of [...db.listPendingPrompts(conversation.id), ...db.listPendingPrompts(conversation.id, "editing")]) {
      removePendingPromptFiles(prompt, conversation.user_id);
    }
    db.deletePendingPromptsForConversation(conversation.id);
    for (const file of db.listFiles(conversation.id)) removePersistedDeliverable(config.dataRoot, file.relative_path);
    const tenant = ensureTenant(config.tenantRoot, conversation.user_id);
    if (conversation.codex_thread_id && !db.isCodexThreadUsedByAnotherActiveConversation(conversation.codex_thread_id, conversation.id)) {
      const hostRemoved = await runner.deleteCodexThread(conversation.user_id, conversation.id, conversation.codex_thread_id);
      if (hostRemoved === null) removeCodexThreadFiles(tenant.codexHome, conversation.codex_thread_id);
    }
    await reader.removeConversationResources(conversation.id, conversation.user_id);
    removeWorkspace(tenant.conversations, conversation.id);
    if (!db.completeConversationDeletion(conversation.id) && db.getConversation(conversation.id)) {
      throw new Error("会话清理状态已经变化");
    }
  }

  api.delete("/conversations/:id", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const id = String(req.params.id);
    const existing = db.getConversationForUser(id, session.user_id) ?? db.getConversationCleanupForUser(id, session.user_id);
    if (!existing) return res.status(404).json({ error: "会话不存在。" });
    if (deletingConversations.has(existing.id)) return res.status(409).json({ code: "CONVERSATION_DELETING", cleanupState: "deleting", error: "会话正在删除。" });
    const conversation = db.beginConversationDeletion(existing.id, session.user_id);
    if (!conversation) return res.status(409).json({ code: "CONVERSATION_DELETE_CONFLICT", error: "会话删除状态已经变化。" });
    deletingConversations.add(conversation.id);
    try {
      await garbageCollectConversation(conversation);
      return res.status(204).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除失败。";
      db.markConversationCleanupFailed(conversation.id, message);
      return res.status(503).json({
        code: "CONVERSATION_CLEANUP_FAILED",
        cleanupState: "cleanup_failed",
        retryable: true,
        error: `会话已隐藏，但清理未完成：${message}。可安全重试。`,
      });
    } finally {
      deletingConversations.delete(conversation.id);
    }
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, _file, callback) {
        try {
          if (availableDiskBytes(true) < config.minimumFreeDiskBytes) throw new Error("磁盘可用空间低于上传安全水位");
          const session = (req as AuthenticatedRequest).appSession;
          const conversationId = String(req.params.id);
          const conversation = session ? db.getConversationForUser(conversationId, session.user_id) : undefined;
          if (!session || deletingConversations.has(conversationId) || !conversation || conversation.archived_at) throw new Error("会话不存在或已归档");
          callback(null, path.join(ensureTenantWorkspace(config.tenantRoot, session.user_id, String(req.params.id)), "uploads"));
        } catch (error) { callback(error as Error, ""); }
      },
      filename(_req, file, callback) { callback(null, safeUploadName(file.originalname).diskName); },
    }),
    // A normal reader send carries message, quote, voice IDs, model and
    // reasoning fields; the main composer may add useComposerDraft as well.
    // Keep this limit above that shared payload so model selection never turns
    // a valid multipart request into a misleading 413 upload error.
    limits: { files: 12, fields: 8, fileSize: config.maxUploadFileBytes },
  });

  function uploadCapacityError(userId: string, uploads: Express.Multer.File[]): { status: number; code: string; error: string } | null {
    if (uploads.length === 0) return null;
    const incoming = uploads.reduce((total, file) => total + file.size, 0);
    if (!isHostRootUser(userId) && db.sumStoredFileBytesForUser(userId) + incoming > config.maxStoredBytesPerUser) {
      return { status: 413, code: "USER_STORAGE_LIMIT", error: "该账号的文件存储已达到安全上限，请先删除不再需要的文件。" };
    }
    if (availableDiskBytes(true) < config.minimumFreeDiskBytes) {
      return { status: 507, code: "DISK_WATERMARK", error: "服务器磁盘可用空间低于安全水位；上传已撤销，现有数据不受影响。" };
    }
    return null;
  }

  function rejectUploadsOutsideCapacity(res: Response, userId: string, uploads: Express.Multer.File[]): Response | null {
    const problem = uploadCapacityError(userId, uploads);
    if (!problem) return null;
    removeUnregisteredUploads(uploads);
    return res.status(problem.status).json({ code: problem.code, error: problem.error });
  }

  api.put("/conversations/:id/draft", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    db.touchConversationActivity(conversation.id);
    if (deletingConversations.has(conversation.id)) return res.status(409).json({ error: "会话正在删除。" });
    if (typeof req.body?.content !== "string") return res.status(400).json({ error: "草稿正文无效。" });
    const content = req.body.content.slice(0, 100_000);
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    return res.json({ composerDraft: db.saveComposerDraft(conversation.id, content, quoteExcerpt) ?? null });
  });

  api.post("/conversations/:id/draft/files", upload.array("files", 12), (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    db.touchConversationActivity(conversation.id);
    if (conversation.archived_at) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话已归档，请恢复后再继续发送。" }); }
    if (conversation.cold_storage_state !== "local") { removeUnregisteredUploads(uploaded); return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再发送。" }); }
    if (deletingConversations.has(conversation.id)) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话正在删除。" }); }
    if (uploaded.length === 0) return res.status(400).json({ error: "没有收到附件。" });
    const capacityRejection = rejectUploadsOutsideCapacity(res, session.user_id, uploaded);
    if (capacityRejection) return capacityRejection;
    const existing = db.getComposerDraft(conversation.id);
    if ((existing?.files.length ?? 0) + db.listActiveResumableUploads(conversation.id).length + uploaded.length > 12) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "单个会话草稿最多包含 12 个附件。" });
    }
    const uploadedFiles = registerComposerUploads(session.user_id, conversation.id, uploaded);
    return res.status(201).json({ composerDraft: db.getComposerDraft(conversation.id)!, uploadedFiles });
  });

  api.delete("/conversations/:id/draft/files/:fileId", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    db.touchConversationActivity(conversation.id);
    const file = db.getFileForUser(String(req.params.fileId), session.user_id);
    if (!file || file.conversation_id !== conversation.id || file.composer_draft_id !== conversation.id) {
      return res.status(404).json({ error: "草稿附件不存在。" });
    }
    const workspace = ensureTenantWorkspace(config.tenantRoot, session.user_id, conversation.id);
    try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); } catch {}
    db.removeFile(file.id);
    db.deleteCompletedResumableUploadForFile(file.id);
    db.pruneEmptyComposerDraft(conversation.id);
    if (db.getComposerDraft(conversation.id)) db.touchComposerDraft(conversation.id);
    return res.json({ composerDraft: db.getComposerDraft(conversation.id) ?? null });
  });

  api.delete("/conversations/:id/draft", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再编辑草稿。" });
    db.touchConversationActivity(conversation.id);
    await resumableUploads.cancelConversationUploads(conversation.id);
    const draft = db.getComposerDraft(conversation.id);
    if (draft) {
      removeComposerDraftFiles(draft, session.user_id);
      db.deleteComposerDraft(conversation.id);
    }
    return res.status(204).end();
  });

  const voiceUpload = multer({
    storage: multer.diskStorage({
      destination(_req, _file, callback) {
        if (availableDiskBytes(true) < config.minimumFreeDiskBytes) return callback(new Error("磁盘可用空间低于上传安全水位"), "");
        return callback(null, transcription.audioRoot);
      },
      filename(_req, file, callback) {
        const mime = file.mimetype.toLowerCase().split(";", 1)[0];
        callback(null, `${crypto.randomUUID()}${AUDIO_MIME_EXTENSIONS[mime] ?? ""}`);
      },
    }),
    limits: { files: 1, fileSize: 15 * 1024 * 1024, fields: 6, fieldSize: 10 * 1024 },
    fileFilter(_req, file, callback) {
      const mime = file.mimetype.toLowerCase().split(";", 1)[0];
      callback(null, Boolean(AUDIO_MIME_EXTENSIONS[mime]));
    },
  });

  const transcriptionLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator(_req, res) { return String((res.locals.session as SessionRow).user_id); },
    message: { error: "语音识别请求过于频繁，请稍后再试。" },
  });

  api.post("/transcriptions", transcriptionLimiter, voiceUpload.single("audio"), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "没有收到可识别的录音，请重新录制。" });
    let persistedAudio: PersistedVoiceRecording | undefined;
    try {
      const session = res.locals.session as SessionRow;
      const clientRecordingId = typeof req.body?.clientRecordingId === "string" ? req.body.clientRecordingId.trim() : "";
      if (clientRecordingId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRecordingId)) {
        return res.status(400).json({ error: "语音录音 ID 无效，请重新录音。" });
      }
      const audioBytes = fs.statSync(file.path).size;
      const audioSha256 = sha256File(file.path);
      const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : "";
      const conversation = conversationId ? db.getConversationForUser(conversationId, session.user_id) : undefined;
      if (conversationId && !conversation) return res.status(404).json({ error: "会话不存在。" });
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
      const project = projectId ? db.getActiveProjectForUser(projectId, session.user_id) : undefined;
      if (projectId && !project) return res.status(404).json({ error: "项目不存在。" });
      let attachmentNames: string[] = [];
      try {
        const parsed = JSON.parse(typeof req.body?.attachmentNames === "string" ? req.body.attachmentNames : "[]");
        if (Array.isArray(parsed)) attachmentNames = parsed.filter((value): value is string => typeof value === "string").slice(0, 12);
      } catch {}
      const recentMessages = conversation
        ? db.listMessages(conversation.id).slice(-4).map((message) => ({ role: message.role, content: message.content }))
        : [];
      const selectedLexicon = formatVoiceLexiconTerms(db.listVoiceLexiconTerms(
        session.user_id, conversation?.project_id ?? project?.id ?? null, config.voiceLexiconMaxTerms,
      ));
      const attachments = conversation ? (() => {
        const workspace = ensureTenantWorkspace(config.tenantRoot, session.user_id, conversation.id);
        const available = db.listFiles(conversation.id).filter((candidate) => candidate.kind === "upload").reverse();
        const used = new Set<string>();
        return attachmentNames.flatMap((name) => {
          const row = available.find((candidate) => !used.has(candidate.id) && candidate.original_name === name);
          if (!row) return [];
          used.add(row.id);
          try {
            const filePath = resolveInside(workspace, row.relative_path);
            if (!fs.existsSync(filePath)) return [];
            return [{ name: row.original_name, filePath, mimeType: row.mime_type, size: row.size }];
          } catch { return []; }
        });
      })() : [];
      const runTranscription = async (): Promise<{ text: string; transcriptionId: string }> => {
        try {
          const text = await transcription.transcribe(file.filename, {
            purpose: req.body?.purpose === "search" ? "search" : "composer",
            draftText: typeof req.body?.draftText === "string" ? req.body.draftText : "",
            attachmentNames,
            attachments,
            recentMessages,
            personalizedTerms: ["Codex Web", ...selectedLexicon.lines],
          });
          const transcriptionId = newId();
          persistedAudio = persistVoiceRecording({
            dataRoot: config.dataRoot,
            sourcePath: file.path,
            userId: session.user_id,
            transcriptionId,
            mimeType: file.mimetype.toLowerCase().split(";", 1)[0] ?? "application/octet-stream",
          });
          db.createVoiceTranscription({
            id: transcriptionId, userId: session.user_id, clientRecordingId: clientRecordingId || null,
            conversationId: conversation?.id ?? null, projectId: conversation?.project_id ?? null, rawText: text, model: config.dashscopeModel,
            promptVersion: "transcription-context-v3", selectedTermIds: selectedLexicon.ids, audio: persistedAudio,
          });
          if (clientRecordingId) db.updateVoiceTranscriptionReceipt({ userId: session.user_id, clientRecordingId, state: "succeeded", transcriptionId });
          return { text, transcriptionId };
        } catch (error) {
          if (clientRecordingId) db.updateVoiceTranscriptionReceipt({ userId: session.user_id, clientRecordingId, state: "failed", error: error instanceof Error ? error.message : "语音识别失败" });
          throw error;
        }
      };
      if (!clientRecordingId) return res.json(await runTranscription());
      const existing = db.getVoiceTranscriptionByClientRecordingId(session.user_id, clientRecordingId);
      if (existing) {
        if (existing.audio_bytes !== audioBytes || existing.audio_sha256 !== audioSha256) return res.status(409).json({ error: "同一录音 ID 对应了不同音频内容。" });
        return res.json({ text: existing.raw_text, transcriptionId: existing.id });
      }
      const receipt = db.getVoiceTranscriptionReceipt(session.user_id, clientRecordingId);
      if (receipt && (receipt.audio_bytes !== audioBytes || receipt.audio_sha256 !== audioSha256)) return res.status(409).json({ error: "同一录音 ID 对应了不同音频内容。" });
      if (receipt?.state === "processing") {
        const pending = voiceTranscriptionInFlight.get(`${session.user_id}:${clientRecordingId}`);
        if (pending) return res.json(await pending);
        return res.status(409).json({ error: "这段语音正在识别，请稍后重试。" });
      }
      const claimed = db.claimVoiceTranscriptionReceipt({ userId: session.user_id, clientRecordingId, audioSha256, audioBytes });
      if (claimed.state === "succeeded" && claimed.transcription_id) {
        const completed = db.getVoiceTranscriptionByClientRecordingId(session.user_id, clientRecordingId);
        if (completed) return res.json({ text: completed.raw_text, transcriptionId: completed.id });
      }
      const key = `${session.user_id}:${clientRecordingId}`;
      const pending = runTranscription();
      voiceTranscriptionInFlight.set(key, pending);
      try { return res.json(await pending); }
      finally { voiceTranscriptionInFlight.delete(key); }
    } catch (error) {
      if (persistedAudio) {
        try { removePersistedVoiceRecording(config.dataRoot, persistedAudio.relativePath); } catch {}
      }
      const status = error instanceof TranscriptionError ? error.status : error instanceof Error && error.message.includes("同一录音 ID") ? 409 : 502;
      return res.status(status).json({ error: error instanceof Error ? error.message : "语音识别失败，请重试。" });
    } finally {
      try { fs.rmSync(file.path, { force: true }); } catch {}
    }
  });

  api.post("/conversations/:id/messages", upload.array("files", 12), async (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    if (conversation.archived_at) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话已归档，请恢复后再继续发送。" }); }
    if (conversation.cold_storage_state !== "local") { removeUnregisteredUploads(uploaded); return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再发送。" }); }
    db.touchConversationActivity(conversation.id);
    if (deletingConversations.has(conversation.id)) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话正在删除。" }); }
    const capacityRejection = rejectUploadsOutsideCapacity(res, session.user_id, uploaded);
    if (capacityRejection) return capacityRejection;
    const prompt = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 100_000) : "";
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const voiceTranscriptionIds = submittedVoiceTranscriptionIds(req.body?.voiceTranscriptionIds);
    if (voiceTranscriptionIds.length > 0 && !db.validateVoiceTranscriptions(voiceTranscriptionIds, session.user_id)) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "语音转写记录无效或已经发送。" });
    }
    const useComposerDraft = req.body?.useComposerDraft === "true";
    if (useComposerDraft && uploaded.length > 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "服务器草稿附件无需重复上传。" });
    }
    const composerDraft = useComposerDraft ? db.getComposerDraft(conversation.id) : undefined;
    const attachmentCount = uploaded.length + (composerDraft?.files.length ?? 0);
    if (!prompt && !quoteExcerpt && attachmentCount === 0) return res.status(400).json({ error: "请输入内容、添加引用或上传文件。" });
    let selection: AgentSelection;
    try {
      const currentSelection = conversationAgentSelection(conversation);
      const hasRequestSelection = typeof req.body?.model === "string" || typeof req.body?.reasoningEffort === "string";
      selection = hasRequestSelection
        ? resolveAgentSelection(
            optionsForConversation(conversation),
            typeof req.body?.model === "string" ? req.body.model : currentSelection.model,
            typeof req.body?.reasoningEffort === "string" ? req.body.reasoningEffort : currentSelection.reasoningEffort,
          )
        : currentSelection;
    } catch (error) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: error instanceof Error ? error.message : "模型选项无效。" });
    }
    const editingPrompt = db.listPendingPrompts(conversation.id, "editing")[0];

    if (useComposerDraft && editingPrompt) return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });

    if (!prompt && !quoteExcerpt) {
      if (useComposerDraft) {
        const awaiting = db.materializeComposerDraftAsPending(newId(), conversation.id, "", selection, null, "editing");
        attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { pendingPromptId: awaiting.id });
        return res.status(202).json({ pendingPrompt: awaiting, editingPrompt: awaiting, queued: false, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
      }
      if (editingPrompt?.content.trim() || editingPrompt?.quote_excerpt) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });
      }
      if (editingPrompt && editingPrompt.files.length + uploaded.length > 12) {
        removeUnregisteredUploads(uploaded);
        return res.status(400).json({ error: "等待指令的附件最多保留 12 个。" });
      }
      const createdAwaiting = editingPrompt ?? db.createPendingPrompt(newId(), conversation.id, "", selection);
      const awaiting = editingPrompt ?? db.beginEditingPendingPrompt(createdAwaiting.id);
      if (!awaiting) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "等待指令的文件状态已经变化，请刷新后重试。" }); }
      const rows = pendingUploadRows(conversation.id, awaiting.id, uploaded);
      let persisted: PendingPromptWithFiles | undefined;
      try {
        persisted = db.updatePendingPromptWithFiles({
          id: awaiting.id, expectedUpdatedAt: awaiting.updated_at, content: "", quoteExcerpt: null,
          selection, nextStatus: "editing", newFiles: rows,
          userId: session.user_id, maximumStoredBytes: maximumStoredBytesForUser(session.user_id),
        });
      } catch (error) { removeUnregisteredUploads(uploaded); throw error; }
      if (!persisted) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "等待指令的文件状态已经变化，请刷新后重试。" }); }
      attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { pendingPromptId: persisted.id });
      return res.status(202).json({ pendingPrompt: persisted, editingPrompt: persisted, queued: false, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
    }

    if (editingPrompt) {
      if (editingPrompt.content.trim() || editingPrompt.quote_excerpt) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });
      }
      if (editingPrompt.files.length + uploaded.length > 12) {
        removeUnregisteredUploads(uploaded);
        return res.status(400).json({ error: "单条任务最多包含 12 个附件。" });
      }
      const rows = pendingUploadRows(conversation.id, editingPrompt.id, uploaded);
      let updated: PendingPromptWithFiles | undefined;
      try {
        updated = db.updatePendingPromptWithFiles({
          id: editingPrompt.id, expectedUpdatedAt: editingPrompt.updated_at, content: prompt, quoteExcerpt,
          selection, nextStatus: "queued", newFiles: rows,
          userId: session.user_id, maximumStoredBytes: maximumStoredBytesForUser(session.user_id),
        });
      } catch (error) { removeUnregisteredUploads(uploaded); throw error; }
      if (!updated) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "等待指令的文件状态已经变化，请刷新后重试。" }); }
      attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { pendingPromptId: updated.id });
      if (config.queueAutoStart) await pumpQueue();
      return res.status(202).json({ pendingPrompt: db.getPendingPrompt(updated.id) ?? null, queued: true, ...maintenanceQueueMetadata() });
    }

    if (conversation.external_status === "running"
      || db.listActiveJobsForConversation(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id).length > 0
      || db.getActiveWakePlan(conversation.id)) {
      if (useComposerDraft) {
        const pendingPrompt = db.materializeComposerDraftAsPending(newId(), conversation.id, prompt, selection, quoteExcerpt);
        attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { pendingPromptId: pendingPrompt.id });
        return res.status(202).json({ pendingPrompt, queued: true, externalRunning: conversation.external_status === "running", guidance: conversation.external_status === "running" ? "任务正在本机客户端中执行；再次刷新项目确认空闲后，新指令会自动开始。" : undefined, ...maintenanceQueueMetadata() });
      }
      const pendingPrompt = db.createPendingPrompt(newId(), conversation.id, prompt, selection, quoteExcerpt);
      registerPendingUploads(session.user_id, conversation.id, pendingPrompt.id, uploaded);
      attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { pendingPromptId: pendingPrompt.id });
      return res.status(202).json({ pendingPrompt: db.getPendingPrompt(pendingPrompt.id), queued: true, externalRunning: conversation.external_status === "running", guidance: conversation.external_status === "running" ? "任务正在本机客户端中执行；再次刷新项目确认空闲后，新指令会自动开始。" : undefined, ...maintenanceQueueMetadata() });
    }

    const messageId = newId();
    const createdAt = new Date().toISOString();
    if (useComposerDraft) {
      const job = db.materializeComposerDraftAsJob(messageId, newId(), conversation.id, prompt, selection, quoteExcerpt);
      attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { messageId });
      scheduleConversationTitle(conversation.id, messageId, prompt, job.id);
      const queuePosition = db.getQueuePosition(job.id) ?? 1;
      publishQueuePositions();
      res.status(202).json({ job: { ...job, queuePosition }, message: { id: messageId }, queued: true, ...maintenanceQueueMetadata() });
      if (config.queueAutoStart) scheduleQueuePump();
      return;
    }
    const userMessage = { id: messageId, conversation_id: conversation.id, role: "user" as const, content: prompt, quote_excerpt: quoteExcerpt, created_at: createdAt };
    const fileRows: FileRow[] = uploaded.map((file) => ({
        id: newId(), conversation_id: conversation.id, message_id: messageId, pending_prompt_id: null,
        original_name: safeUploadName(file.originalname).displayName,
        relative_path: path.posix.join("uploads", file.filename), mime_type: file.mimetype || "application/octet-stream",
        size: file.size, kind: "upload" as const, created_at: createdAt,
    }));
    let job: JobRow;
    try { job = db.createJobWithMessageAndFiles(newId(), userMessage, fileRows, selection, session.user_id, maximumStoredBytesForUser(session.user_id)); }
    catch (error) { removeUnregisteredUploads(uploaded); throw error; }
    attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { messageId });
    scheduleConversationTitle(conversation.id, messageId, prompt, job.id);
    const queuePosition = db.getQueuePosition(job.id) ?? 1;
    publishQueuePositions();
    res.status(202).json({ job: { ...job, queuePosition }, message: { id: messageId }, queued: true, ...maintenanceQueueMetadata() });
    if (config.queueAutoStart) scheduleQueuePump();
  });

  api.put("/conversations/:id/pending-prompts/order", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再调整待发送任务。" });
    db.touchConversationActivity(conversation.id);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
    try { return res.json({ pendingPrompts: db.reorderPendingPrompts(conversation.id, ids) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "调整顺序失败。" }); }
  });

  api.post("/conversations/:id/pending-prompts/:promptId/edit", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再编辑待发送任务。" });
    db.touchConversationActivity(conversation.id);
    const prompt = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!prompt || prompt.conversation_id !== conversation.id) return res.status(404).json({ error: "待发送任务不存在。" });
    if (db.listPendingPrompts(conversation.id, "editing").length > 0) return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });
    const editingPrompt = db.beginEditingPendingPrompt(prompt.id);
    return editingPrompt ? res.json({ editingPrompt }) : res.status(409).json({ error: "待发送队列已经变化，请刷新后重试。" });
  });

  api.post("/conversations/:id/pending-prompts/:promptId/restore", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再继续任务。" });
    db.touchConversationActivity(conversation.id);
    const prompt = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!prompt || prompt.conversation_id !== conversation.id) return res.status(404).json({ error: "待发送任务不存在。" });
    if (!prompt.content.trim() && !prompt.quote_excerpt) return res.status(409).json({ error: "请先输入具体操作，或者清除这批待处理文件。" });
    const restored = db.restorePendingPrompt(prompt.id);
    if (!restored) return res.status(409).json({ error: "该任务当前不在编辑状态。" });
    if (config.queueAutoStart) await pumpQueue();
    return res.json({ pendingPrompt: db.getPendingPrompt(prompt.id) ?? null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null, queued: true, ...maintenanceQueueMetadata() });
  });

  api.put("/conversations/:id/pending-prompts/:promptId", upload.array("files", 12), async (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    if (conversation.cold_storage_state !== "local") { removeUnregisteredUploads(uploaded); return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再编辑任务。" }); }
    db.touchConversationActivity(conversation.id);
    const pending = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!pending || pending.conversation_id !== conversation.id) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "待发送任务不存在。" }); }
    if (pending.status !== "editing") { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "请先点击编辑。" }); }
    const capacityRejection = rejectUploadsOutsideCapacity(res, session.user_id, uploaded);
    if (capacityRejection) return capacityRejection;
    const prompt = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 100_000) : "";
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const voiceTranscriptionIds = submittedVoiceTranscriptionIds(req.body?.voiceTranscriptionIds);
    if (voiceTranscriptionIds.length > 0 && !db.validateVoiceTranscriptions(voiceTranscriptionIds, session.user_id)) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "语音转写记录无效或已经发送。" });
    }
    let removedFileIds: string[] = [];
    try {
      const raw = typeof req.body?.removedFileIds === "string" ? JSON.parse(req.body.removedFileIds) : [];
      if (Array.isArray(raw)) removedFileIds = raw.filter((id): id is string => typeof id === "string");
    } catch { removeUnregisteredUploads(uploaded); return res.status(400).json({ error: "待移除文件列表无效。" }); }
    const removed = pending.files.filter((file) => removedFileIds.includes(file.id));
    const retainedCount = pending.files.length - removed.length;
    if (retainedCount + uploaded.length > 12) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "单条任务最多包含 12 个附件。" });
    }
    if (!prompt && !quoteExcerpt && retainedCount === 0 && uploaded.length === 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "请至少保留一个文件，或者输入具体操作。" });
    }
    const selection = conversationAgentSelection(conversation);
    const rows = pendingUploadRows(conversation.id, pending.id, uploaded);
    let updated: PendingPromptWithFiles | undefined;
    try {
      updated = db.updatePendingPromptWithFiles({
        id: pending.id, expectedUpdatedAt: pending.updated_at, content: prompt || quoteExcerpt ? prompt : "", quoteExcerpt,
        selection, nextStatus: prompt || quoteExcerpt ? "queued" : "editing", newFiles: rows,
        removeFileIds: removed.map((file) => file.id),
        userId: session.user_id, maximumStoredBytes: maximumStoredBytesForUser(session.user_id),
      });
    } catch (error) { removeUnregisteredUploads(uploaded); throw error; }
    if (!updated) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "待发送队列已经变化，请刷新后重试。" }); }
    attachVoiceTranscriptions(voiceTranscriptionIds, session, conversation.id, { pendingPromptId: updated.id });
    const workspace = ensureTenantWorkspace(config.tenantRoot, session.user_id, conversation.id);
    for (const file of removed) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); } catch {}
    }
    if (!prompt && !quoteExcerpt) {
      return res.status(202).json({ pendingPrompt: db.getPendingPrompt(pending.id) ?? null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
    }
    if (config.queueAutoStart) await pumpQueue();
    return res.json({ pendingPrompt: db.getPendingPrompt(pending.id) ?? null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null, queued: true, ...maintenanceQueueMetadata() });
  });

  api.delete("/conversations/:id/pending-prompts/:promptId", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再删除待发送任务。" });
    db.touchConversationActivity(conversation.id);
    const pending = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!pending || pending.conversation_id !== conversation.id) return res.status(404).json({ error: "待发送任务不存在。" });
    removePendingPromptFiles(pending, session.user_id);
    db.deletePendingPrompt(pending.id);
    if (config.queueAutoStart) await pumpQueue();
    return res.status(204).end();
  });

  api.post("/conversations/:id/pending-prompts/:promptId/steer", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再引导任务。" });
    db.touchConversationActivity(conversation.id);
    const pending = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!pending || pending.conversation_id !== conversation.id || pending.status !== "queued") return res.status(404).json({ error: "待发送任务不存在。" });
    const running = db.listActiveJobsForConversation(conversation.id).find((job) => job.status === "running");
    if (!running) {
      const job = db.materializePendingPrompt(pending.id, newId(), newId());
      if (!job) return res.status(409).json({ error: "待发送队列已经变化，请刷新后重试。" });
      publishQueuePositions();
      if (config.queueAutoStart) await pumpQueue();
      return res.json({ ok: true, mode: "insert", job: db.getJob(job.id) ?? job });
    }
    try {
      const turnId = await runner.steer(running.id, agentPrompt(pending.content, pending.quote_excerpt), pending.files);
      const message = db.materializeSteeredPrompt(pending.id, newId());
      if (!message) throw new Error("引导已送达，但本地记录队列发生变化，请刷新确认。 ");
      return res.json({ ok: true, mode: "steer", turnId, message });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : "引导失败。" });
    }
  });

  api.get("/jobs/:id/events", (req, res) => {
    const session = res.locals.session as SessionRow;
    const job = db.getJobForUser(String(req.params.id), session.user_id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Content-Encoding", "identity");
    res.flushHeaders();
    const after = Number(req.get("last-event-id") ?? req.query.after ?? 0) || 0;
    let lastSent = after;
    res.write("retry: 2000\n\n");
    const replayFrom = (cursor: number) => {
      for (const event of db.listEvents(job.id, cursor)) {
        writeSse(res, event.seq, event.event_type, { created_at: event.created_at, ...JSON.parse(event.payload) });
        lastSent = event.seq;
      }
    };
    replayFrom(after);
    const replayComplete = () => res.write(`data: ${JSON.stringify({ type: "replay_complete", lastEventId: lastSent })}\n\n`);
    const terminalStatuses = ["completed", "failed", "cancelled", "interrupted"];
    if (terminalStatuses.includes(db.getJob(job.id)?.status ?? "interrupted")) {
      replayFrom(lastSent);
      replayComplete();
      return res.end();
    }
    const set = subscribers.get(job.id) ?? new Set<Response>();
    set.add(res);
    subscribers.set(job.id, set);
    // Subscribe before the second replay. Node and SQLite execute this block
    // synchronously, so no persisted event can fall between snapshot replay and
    // live delivery without being covered by one of the two paths.
    replayFrom(lastSent);
    replayComplete();
    const checkedJob = db.getJob(job.id);
    if (!checkedJob || terminalStatuses.includes(checkedJob.status)) {
      replayFrom(lastSent);
      set.delete(res);
      if (set.size === 0) subscribers.delete(job.id);
      return res.end();
    }
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (set.size === 0) subscribers.delete(job.id);
    });
  });

  api.post("/jobs/:id/cancel", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const job = db.getJobForUser(String(req.params.id), session.user_id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    if (job.status === "queued" && db.cancelQueuedJob(job.id)) {
      publish(job.id, "done", { status: "cancelled", message: "任务已停止" });
      publishQueuePositions();
      if (config.queueAutoStart) scheduleQueuePump();
      return res.json({ ok: true });
    }
    if (job.status !== "running" || !runner.cancel(job.id)) return res.status(409).json({ error: "任务已经结束。" });
    const deadline = Date.now() + 15_000;
    while (db.getJob(job.id)?.status === "running") {
      if (Date.now() >= deadline) return res.status(503).json({ error: "任务未能在限定时间内停止，请稍后重试。" });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    recordUserCancelledJob(job);
    return res.json({ ok: true });
  });

  api.post("/conversations/:id/messages/:messageId/remote-file", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!isHostRootUser(session.user_id)) return res.status(403).json({ error: "当前账号不能获取远程机器文件。" });
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation || !conversation.project_id) return res.status(404).json({ error: "任务不存在。" });
    if (conversation.cold_storage_state !== "local") return res.status(409).json({ code: "COLD_STORAGE_RESTORE_REQUIRED", state: conversation.cold_storage_state, error: "历史正在恢复，请恢复完成后再获取文件。" });
    db.touchConversationActivity(conversation.id);
    const message = db.getMessage(String(req.params.messageId));
    if (!message || message.conversation_id !== conversation.id || message.role !== "assistant") {
      return res.status(404).json({ error: "消息不存在。" });
    }
    const project = db.getProjectForUser(conversation.project_id, session.user_id);
    if (!project || !workerIdFromExecutor(project.executor_id)) return res.status(400).json({ error: "该任务不属于远程机器项目。" });
    const sourcePath = normalizeRemoteSourcePath(req.body?.path);
    if (!sourcePath) return res.status(400).json({ error: "远程文件路径无效。" });
    const existing = db.getFileForMessageSource(message.id, sourcePath);
    if (existing) return res.json({ file: existing, alreadyFetched: true });

    let stagingOwnerId: string | undefined;
    try {
      const artifact = await remoteWorkers.fetchFile(project.executor_id, project.root_path, sourcePath);
      stagingOwnerId = path.basename(path.dirname(artifact.tempPath));
      const fetchedAfterWait = db.getFileForMessageSource(message.id, sourcePath);
      if (fetchedAfterWait) return res.json({ file: fetchedAfterWait, alreadyFetched: true });
      const fileId = newId();
      const storedPath = path.posix.join("deliverables", fileId, artifact.name);
      const destination = resolveInside(config.dataRoot, storedPath);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(artifact.tempPath, destination);
      const file: FileRow = {
        id: fileId, conversation_id: conversation.id, message_id: message.id,
        original_name: artifact.name, relative_path: storedPath, source_path: sourcePath,
        mime_type: artifact.mimeType, size: artifact.size, kind: "output", created_at: new Date().toISOString(),
      };
      try { db.addFile(file); }
      catch (error) {
        fs.rmSync(path.dirname(destination), { recursive: true, force: true });
        throw error;
      }
      return res.status(201).json({ file, alreadyFetched: false });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : "远程文件获取失败。" });
    } finally {
      if (stagingOwnerId) {
        try { cleanupOwnedStagingDirectory(config.dataRoot, "remote-worker-fetch-staging", stagingOwnerId); }
        catch { /* Staging cleanup must not hide a successful fetch. */ }
      }
    }
  });

  api.get("/files/:id/preview", (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    db.touchConversationActivity(file.conversation_id);
    res.setHeader("Cache-Control", "private, no-store");
    const conversation = db.getConversationForUser(file.conversation_id, session.user_id);
    if (!conversation) return res.status(404).json({ error: "所属会话不存在。" });
    return res.json({
      file: {
        id: file.id,
        original_name: file.original_name,
        relative_path: file.relative_path,
        source_path: file.source_path,
        mime_type: file.mime_type,
        size: file.size,
        kind: file.kind,
      },
      share: publicShareState(req, file.id),
      conversation: {
        id: conversation.id,
        title: conversation.title,
        status: conversation.status,
        external_status: conversation.external_status,
        has_unread_result: conversation.has_unread_result,
        has_pending_work: conversation.has_pending_work,
      },
    });
  });

  api.get("/public-shares", (req, res) => {
    const session = res.locals.session as SessionRow;
    const shares = db.listActivePublicFileShares(session.user_id).flatMap((share) => {
      const documentKind = publicShareDocumentKind({ original_name: share.current_file_name, mime_type: share.mime_type });
      if (!documentKind) return [];
      return [{
        id: share.id,
        fileId: share.file_id,
        fileName: share.current_file_name || share.file_name_snapshot,
        documentKind,
        mimeType: share.mime_type,
        size: share.size,
        conversationId: share.conversation_id,
        conversationTitle: share.conversation_title,
        enabledAt: share.enabled_at,
        publicUrl: publicPreviewUrl(req, share.file_id),
      }];
    });
    res.setHeader("Cache-Control", "private, no-store");
    return res.json({ shares });
  });

  api.post("/files/:id/share", (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    const kind = publicShareDocumentKind(file);
    if (file.kind !== "output" || !kind || !isPersistedDeliverablePath(file.relative_path)) {
      return res.status(400).json({ error: "只有已完成的 Markdown 或 HTML 成品可以公开分享。" });
    }
    if (file.size > PUBLIC_FILE_READER_MAX_BYTES) return res.status(413).json({ error: "超过 5 MiB 的文件不能在线公开分享。" });
    let absolute: string;
    try { absolute = resolveFilePath(file, session.user_id); }
    catch { return res.status(404).json({ error: "文件不存在。" }); }
    let content: string;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size !== file.size) return res.status(404).json({ error: "文件不存在。" });
      content = fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
    } catch { return res.status(404).json({ error: "文件不存在。" }); }
    try {
      const siblings = file.message_id ? db.listFilesForMessage(file.message_id) : [];
      const assets = resolvePublicShareAssets(kind, content, siblings);
      for (const reference of assets) {
        const asset = db.getFileForUser(reference.assetFileId, session.user_id);
        if (!asset || asset.message_id !== file.message_id || asset.kind !== "output" || !isPublicShareImage(asset)
          || !isPersistedDeliverablePath(asset.relative_path)) {
          throw new PublicShareAssetError(`图片“${reference.sourceRef}”不是同次交付的安全成品图片。`);
        }
        const assetPath = resolveFilePath(asset, session.user_id);
        const stat = fs.statSync(assetPath);
        if (!stat.isFile() || stat.size !== asset.size) throw new PublicShareAssetError(`图片“${reference.sourceRef}”已经不存在。`);
      }
      db.enablePublicFileShare({ id: newId(), file, userId: session.user_id, assets });
      return res.json({ share: publicShareState(req, file.id) });
    } catch (error) {
      if (error instanceof PublicShareAssetError) return res.status(422).json({ error: error.message });
      return res.status(500).json({ error: "公开分享创建失败。" });
    }
  });

  api.delete("/files/:id/share", (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    db.disablePublicFileShare(file.id, session.user_id);
    return res.json({ share: publicShareState(req, file.id) });
  });

  api.get("/files/:id/thumbnail", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    db.touchConversationActivity(file.conversation_id);
    if (!file.mime_type.startsWith("image/")) return res.status(415).json({ error: "该文件不是图片。" });
    let absolute: string;
    try { absolute = resolveFilePath(file, session.user_id); }
    catch { return res.status(400).json({ error: "文件路径无效。" }); }
    let stat: ReturnType<typeof fs.statSync>;
    try { stat = fs.statSync(absolute); }
    catch { return res.status(404).json({ error: "文件已不存在。" }); }
    if (!stat.isFile()) return res.status(404).json({ error: "文件已不存在。" });
    try {
      const thumbnail = await imageThumbnails.render(file.id, absolute, `${stat.size}:${stat.mtimeMs}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Content-Length", String(thumbnail.length));
      return res.end(thumbnail);
    } catch {
      return res.status(422).json({ error: "无法生成该图片的缩略图。" });
    }
  });

  api.get("/files/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    db.touchConversationActivity(file.conversation_id);
    let absolute: string;
    try { absolute = resolveFilePath(file, session.user_id); }
    catch { return res.status(400).json({ error: "文件路径无效。" }); }
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: "文件已不存在。" });
    const inline = req.query.download !== "1" && (/^image\//.test(file.mime_type) || file.mime_type === "application/pdf" || /^text\/(plain|markdown|csv)/.test(file.mime_type));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", fileResponseContentType(file.mime_type));
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", file.original_name));
    return res.sendFile(path.basename(absolute), { root: path.dirname(absolute) });
  });

  router.use("/api", api);
  const distPath = path.join(config.projectRoot, "dist");
  if (fs.existsSync(distPath)) {
    router.use(express.static(distPath, {
      index: false,
      maxAge: "1h",
      setHeaders: (res, filePath) => {
        if (filePath.startsWith(path.join(distPath, "assets") + path.sep)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
  }
  router.use((req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html") || !fs.existsSync(path.join(distPath, "index.html"))) return next();
    return res.sendFile("index.html", { root: distPath });
  });
  if (config.basePath) app.get(config.basePath, (_req, res) => res.redirect(308, `${config.basePath}/`));
  app.use(config.basePath || "/", router);
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = String(res.locals.requestId ?? crypto.randomUUID());
    if (error instanceof multer.MulterError) {
      const partial = [
        ...(((req.files as Express.Multer.File[] | undefined) ?? [])),
        ...(req.file ? [req.file] : []),
      ];
      removeUnregisteredUploads(partial);
      return res.status(413).json({ code: "UPLOAD_REJECTED", requestId, error: "上传失败，请检查文件数量和大小。" });
    }
    if (error instanceof StorageQuotaExceededError) {
      return res.status(413).json({ code: error.code, requestId, error: "该账号的文件存储已达到安全上限，请先删除不再需要的文件。" });
    }
    if (isMalformedJsonError(error)) return res.status(400).json({ code: "INVALID_JSON", requestId, error: "请求 JSON 格式无效。" });
    const internalMessage = redactInternalError(error instanceof Error ? error.message : String(error ?? "Unknown error"));
    console.error(JSON.stringify({ level: "error", event: "http_request_failed", requestId, method: req.method, path: req.path, errorName: error instanceof Error ? error.name : "UnknownError", message: internalMessage }));
    return res.status(500).json({ code: "INTERNAL_ERROR", requestId, error: "服务器内部错误。" });
  });

  scheduleBackground("startup_gc_and_orphan_sweep", async () => {
      db.prunePublicShareAccessEvents(new Date(Date.now() - 180 * 24 * 60 * 60 * 1_000).toISOString());
      for (const candidate of db.listConversationCleanupCandidates()) {
        if (deletingConversations.has(candidate.id)) continue;
        const conversation = db.beginConversationDeletion(candidate.id, candidate.user_id);
        if (!conversation) continue;
        deletingConversations.add(conversation.id);
        try { await garbageCollectConversation(conversation); }
        catch (error) { db.markConversationCleanupFailed(conversation.id, error instanceof Error ? error.message : "启动清理失败"); }
        finally { deletingConversations.delete(conversation.id); }
      }
      const registeredUploads = new Set<string>();
      for (const file of db.listFiles()) {
        if (file.kind !== "upload" || !file.relative_path.startsWith("uploads/")) continue;
        const conversation = db.getConversation(file.conversation_id);
        if (!conversation) continue;
        try { registeredUploads.add(uploadOwnershipKey(conversation.user_id, conversation.id, path.posix.basename(file.relative_path))); }
        catch { /* Legacy non-UUID names are preserved but never selected by the strict sweeper. */ }
      }
      const swept = await sweepUploadOrphans(config.tenantRoot, registeredUploads);
      if (swept.removed.length || swept.failed.length) console.warn(JSON.stringify({
        event: "upload_orphan_sweep", removed: swept.removed.length, failed: swept.failed.length,
      }));
  });

  wakeSchedulerTimer = config.queueAutoStart ? setInterval(() => void processDueWakePlans(), 1_000) : undefined;
  wakeSchedulerTimer?.unref();
  if (config.queueAutoStart) {
    scheduleBackground("wake_scheduler_startup", processDueWakePlans);
    scheduleQueuePump();
    personalMemory.start();
    voiceLexicon.start();
  }
  if (config.queueAutoStart) resumableUploads.start();
  return {
    app, db, runner, conversationTitles, personalMemory, voiceLexicon, config, pumpQueue, remoteWorkers, resumableUploads, waitForBackgroundTasks,
    beginShutdown: () => {
      shuttingDown = true;
      reader.stop();
      personalMemory.stop();
      voiceLexicon.stop();
      resumableUploads.stop();
      if (wakeSchedulerTimer) clearInterval(wakeSchedulerTimer);
      wakeSchedulerTimer = undefined;
      if (maintenanceQueueWakeTimer) clearTimeout(maintenanceQueueWakeTimer);
      maintenanceQueueWakeTimer = undefined;
      if (systemStatusTimer) clearInterval(systemStatusTimer);
      systemStatusTimer = undefined;
      for (const immediate of backgroundImmediates) clearImmediate(immediate);
      backgroundImmediates.clear();
    },
  };
}

function isMalformedJsonError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "type" in error && (error as { type?: unknown }).type === "entity.parse.failed");
}

function redactInternalError(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|eventToken|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

export function migrateExistingOutputFiles(config: AppConfig, db: AppDatabase): number {
  let migrated = 0;
  for (const file of db.listFiles()) {
    if (file.kind !== "output" || isPersistedDeliverablePath(file.relative_path)) continue;
    const conversation = db.getConversation(file.conversation_id);
    if (!conversation) continue;
    const workspace = ensureTenantWorkspace(config.tenantRoot, conversation.user_id, file.conversation_id);
    let source: string;
    try { source = resolveInside(workspace, file.relative_path); }
    catch { continue; }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const storedPath = persistDeliverableSync(config.dataRoot, workspace, file.relative_path, file.id);
    db.updateFilePath(file.id, storedPath);
    migrated += 1;
  }
  return migrated;
}

function hashToken(token: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

function readSession(req: Request, db: AppDatabase, config: AppConfig): SessionRow | undefined {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== "string" || !token) return undefined;
  return db.getSession(hashToken(token, config.sessionSecret));
}

function writeSse(res: Response, seq: number, eventType: string, payload: unknown): void {
  res.write(`id: ${seq}\ndata: ${JSON.stringify({ type: eventType, ...(payload && typeof payload === "object" ? payload : { payload }) })}\n\n`);
}

function normalizeRemoteSourcePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.trim().replace(/^<|>$/g, "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded;
    } catch { break; }
  }
  normalized = normalized
    .replace(/^file:\/\/\/(?=[a-z]:)/i, "")
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/");
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  normalized = normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.length > 4096 || normalized.includes("\0")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !/^[a-z]:\//i.test(normalized)) return null;
  return normalized;
}

function contentDisposition(disposition: "inline" | "attachment", originalName: string): string {
  const extension = path.extname(originalName).replace(/[^.a-z0-9]/gi, "").slice(0, 16);
  const sourceStem = path.basename(originalName, path.extname(originalName)).normalize("NFKD");
  const asciiStem = sourceStem.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_").replace(/[^a-z0-9._ -]/gi, "_").trim().slice(0, 80);
  const fallback = `${asciiStem || "download"}${extension}`;
  const encoded = encodeURIComponent(originalName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function fileResponseContentType(mimeType: string): string {
  const normalized = mimeType.trim() || "application/octet-stream";
  if (/;\s*charset=/i.test(normalized)) return normalized;
  const baseType = normalized.split(";", 1)[0].trim().toLowerCase();
  if (baseType.startsWith("text/") || baseType === "application/json" || baseType.endsWith("+json") || baseType === "application/xml" || baseType.endsWith("+xml")) {
    return `${normalized}; charset=utf-8`;
  }
  return normalized;
}
