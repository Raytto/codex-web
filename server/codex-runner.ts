import fs from "node:fs";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { AppConfig } from "./config.js";
import { AppDatabase, type FileRow, type JobFinalizationPayload } from "./db.js";
import { codexThreadRolloutBytes, ensureTenant, ensureTenantWorkspace, isPersistedDeliverablePath, newId, normalizeStoredRelativePath, resolveGeneratedImage, resolveInside, snapshotDeliverables, snapshotGeneratedImages } from "./paths.js";
import { cleanupJobRuntime, jobRuntimeRoot, prepareJobRuntime, resolvePythonRuntime, type JobRuntimeCleanupTarget } from "./python-runtime.js";
import { assessTaskPolicy } from "./task-policy.js";
import { latestUserCancellationContext } from "./cancellation-summary.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import type { AgentSelection, ExecutorRuntimeStatus } from "./model-options.js";
import { startTenantTurn } from "./tenant-worker-execution.js";
import { TenantWorkerClient } from "./tenant-worker-client.js";
import type { TenantWorkerEvent, TenantWorkerRunRequest } from "./tenant-worker-protocol.js";
import type { AppServerTurnExecution } from "./app-server-turn.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";
import { isConnectionInterruptionError, isModelCapacityError, isRetryableUpstreamError, runWithTransientRetries } from "./retry-policy.js";
import { isHostRootUser } from "./host-root-user.js";
import { HostRootWorkerClient } from "./host-root-worker-client.js";
import type { HostRootRunRequest } from "./host-root-protocol.js";
import type { CodexAccountLoginView, CodexAccountView } from "./codex-account-manager.js";
import { loadAccountSkillBundle } from "./account-skills.js";
import { appendPersonalContextToUserPrompt, buildAgentSteerPrompt, buildAgentTurnPrompt, decideImageInput, isSupportedImageAttachment, type AgentAttachmentContext } from "./agent-context.js";
import { containsPersonalContext, loadPersonalContextForTurn, stripPersonalContext } from "./personal-context.js";
import { buildOptionalCapabilityRoutingHint, detectOptionalAgentCapabilities, updateOptionalAgentCapabilities } from "./optional-capabilities.js";
import { RemoteWorkerGateway, type StoredArtifact } from "./remote-worker-gateway.js";
import { remoteWorkerHasCapacity } from "./remote-worker-capacity.js";
import { HOST_EXECUTOR_ID, workerIdFromExecutor } from "./remote-worker-protocol.js";
import { TENANT_LOCAL_EXECUTOR_ID, assertTenantProjectRoot, createTenantProjectDirectory, initializeTenantProjectDirectory, listTenantProjectDirectories, validateTenantProjectDirectory } from "./tenant-projects.js";
import { CODEX_EGRESS_FALLBACK_NOTICE, selectCodexEgress } from "./codex-egress.js";
import { appendWaitAutomationInstructions, createJobAutomationToken } from "./wake-automation.js";
import { cleanupFinalizationDirectory, prepareFinalizationFiles, recoverPreparedFinalization, rollbackUncommittedFinalization, sweepFinalizationOrphans, type FinalizationFileSource } from "./job-finalization.js";
import { cleanupOwnedStagingDirectory } from "./owned-staging.js";

type Publish = (jobId: string, eventType: string, payload: unknown) => void;

type AutoTitleEnvelope = { answer: string; title: string };

export function isMeaningfulExecutionProgress(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true;
  const record = payload as { kind?: unknown; status?: unknown };
  if (record.kind === "status" || record.kind === "error" || typeof record.status === "string") return false;
  return typeof record.kind === "string";
}

export function isModelCapacityProgress(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as { kind?: unknown; label?: unknown; detail?: unknown; message?: unknown };
  if (record.kind !== "error") return false;
  return [record.label, record.detail, record.message].some((value) => typeof value === "string" && isModelCapacityError(value));
}

export function retryDelayLabel(delayMs: number): string {
  if (delayMs < 60_000) return `${delayMs / 1_000} 秒`;
  return `${delayMs / 60_000} 分钟`;
}

export const MODEL_CAPACITY_CONTINUATION_PROMPT = [
  "继续刚才因模型容量不足而中断、尚未完成的任务。",
  "先检查原会话中的最新进展、已经执行的命令、已有文件和现场状态，不要重复已经完成的步骤或外部操作；只完成剩余工作，并在完成后给出最终结果。",
].join("\n\n");

export function capacityRetryPrompt(originalPrompt: string, continuationRequired: boolean): string {
  return continuationRequired ? MODEL_CAPACITY_CONTINUATION_PROMPT : originalPrompt;
}

export function isAlreadyAbsentRemoteThread(error: unknown, threadId: string): boolean {
  return error instanceof Error
    && error.message.trim().toLowerCase() === `no rollout found for thread id ${threadId}`.toLowerCase();
}

function parseAutoTitleEnvelope(raw: string): AutoTitleEnvelope | null {
  const trimmed = raw.trim();
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes("answer") || !keys.includes("title")) return null;
    if (typeof record.answer !== "string" || typeof record.title !== "string") return null;
    return { answer: record.answer, title: record.title };
  } catch {
    return null;
  }
}

export function extractLeakedAutoTitleAnswer(raw: string, tolerateSchemaTitleOverflow = false): string | null {
  const envelope = parseAutoTitleEnvelope(raw);
  if (!envelope) return null;
  const title = envelope.title.trim();
  const maxTitleLength = tolerateSchemaTitleOverflow ? 80 : 10;
  if (!title || Array.from(title).length > maxTitleLength || /[\r\n]/.test(title)) return null;
  return envelope.answer;
}

export class CodexRunner {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly directExecutions = new Map<string, AppServerTurnExecution>();
  private readonly workerClient: TenantWorkerClient | undefined;
  private readonly hostWorkerClient: HostRootWorkerClient;

  constructor(private readonly config: AppConfig, private readonly db: AppDatabase, private readonly publish: Publish, private readonly remoteWorkers: RemoteWorkerGateway) {
    this.workerClient = config.tenantWorkerIsolation ? new TenantWorkerClient() : undefined;
    this.hostWorkerClient = new HostRootWorkerClient(config.hostRootSocketPath);
  }

  reviewVoiceLexicon(userId: string, prompt: string, timeoutMs: number): Promise<string> {
    if (isHostRootUser(userId)) return this.hostWorkerClient.reviewVoiceLexicon(userId, prompt, timeoutMs);
    if (!this.workerClient) return Promise.reject(new Error("Tenant worker isolation is required for Codex voice review"));
    return this.workerClient.reviewVoiceLexicon(userId, prompt, timeoutMs);
  }

  generateConversationTitle(userId: string, executorId: string, prompt: string, timeoutMs: number): Promise<string> {
    const remoteWorkerId = workerIdFromExecutor(executorId);
    if (remoteWorkerId) return this.remoteWorkers.generateConversationTitle(executorId, prompt, timeoutMs);
    if (executorId === HOST_EXECUTOR_ID) {
      if (!isHostRootUser(userId)) return Promise.reject(new Error("Host title executor is not available to this account"));
      return this.hostWorkerClient.generateConversationTitle(userId, prompt, timeoutMs);
    }
    if (!this.workerClient) return Promise.reject(new Error("Tenant worker isolation is required for Codex title generation"));
    if (executorId !== TENANT_LOCAL_EXECUTOR_ID) return Promise.reject(new Error("Conversation title executor is invalid"));
    return this.workerClient.generateConversationTitle(userId, prompt, timeoutMs);
  }

  cancel(jobId: string): boolean {
    const controller = this.abortControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    this.directExecutions.get(jobId)?.interrupt();
    this.workerClient?.cancel(jobId);
    this.hostWorkerClient.cancel(jobId);
    this.remoteWorkers.cancel(jobId);
    return true;
  }

  get activeJobCount(): number {
    return this.abortControllers.size;
  }

  async recoverJobFinalizations(): Promise<{ resumed: number; rolledBack: number; published: number; orphaned: number; errors: string[] }> {
    const report = { resumed: 0, rolledBack: 0, published: 0, orphaned: 0, errors: [] as string[] };
    const recoverable = this.db.listRecoverableJobFinalizations();
    for (const job of recoverable) {
      try {
        const payload = parseFinalizationPayload(job.finalization_payload);
        if (!payload || payload.message.conversation_id !== job.conversation_id) throw new Error("Invalid persisted finalization payload");
        let ready = payload;
        if (job.finalization_state === "staging") {
          const recovered = await recoverPreparedFinalization(this.config.dataRoot, job.id, payload);
          if (!recovered) {
            await rollbackUncommittedFinalization(this.config.dataRoot, job.id, payload);
            this.db.abandonJobFinalization(job.id, "Incomplete staging was rolled back during startup recovery");
            report.rolledBack += 1;
            continue;
          }
          ready = recovered;
          this.db.markJobFilesReady(job.id, ready);
        }
        if (["staging", "files_ready"].includes(job.finalization_state)) {
          this.db.finalizeJob(job.id, job.conversation_id, ready);
          report.resumed += 1;
        }
        if (!this.db.hasJobEvent(job.id, "done")) this.publish(job.id, "done", { status: "completed", recovered: true });
        this.db.publishJobFinalization(job.id);
        await cleanupFinalizationDirectory(this.config.dataRoot, job.id);
        report.published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.failJobFinalization(job.id, message);
        report.errors.push(`${job.id}: ${message}`);
      }
    }
    const protectedIds = new Set([
      ...this.db.listRecoverableJobFinalizations().map((job) => job.id),
      ...this.db.listRunningJobSummaries().map((job) => job.id),
    ]);
    report.orphaned = (await sweepFinalizationOrphans(this.config.dataRoot, protectedIds)).length;
    return report;
  }

  async cleanupTerminalJobRuntimes(): Promise<{
    removed: number;
    absent: number;
    failed: Array<{ jobId: string; message: string }>;
  }> {
    const targets = this.db.listTerminalJobRuntimes()
      .map<JobRuntimeCleanupTarget>((job) => ({
        userId: job.user_id,
        conversationId: job.conversation_id,
        jobId: job.job_id,
      }))
      .filter((target) => {
        try { return fs.existsSync(jobRuntimeRoot(this.config.tenantRoot, target)); }
        catch { return false; }
      });
    const hostTargets = targets.filter((target) => isHostRootUser(target.userId));
    const tenantTargets = targets.filter((target) => !isHostRootUser(target.userId));
    const report = {
      removed: 0,
      absent: 0,
      failed: [] as Array<{ jobId: string; message: string }>,
    };

    if (hostTargets.length > 0) {
      try {
        const result = await this.hostWorkerClient.cleanupJobRuntimes(
          hostTargets[0].userId,
          hostTargets.map(({ conversationId, jobId }) => ({ conversationId, jobId })),
        );
        report.removed += result.removed;
        report.absent += result.absent;
        report.failed.push(...result.failed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Host runtime cleanup failed";
        report.failed.push(...hostTargets.map((target) => ({ jobId: target.jobId, message })));
      }
    }

    if (tenantTargets.length > 0) {
      if (this.workerClient) {
        try {
          const result = await this.workerClient.cleanupJobRuntimes(tenantTargets);
          report.removed += result.removed;
          report.absent += result.absent;
          report.failed.push(...result.failed);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tenant runtime cleanup failed";
          report.failed.push(...tenantTargets.map((target) => ({ jobId: target.jobId, message })));
        }
      } else {
        for (const target of tenantTargets) {
          const result = cleanupJobRuntime(jobRuntimeRoot(this.config.tenantRoot, target));
          if (result.status === "removed") report.removed += 1;
          else if (result.status === "absent") report.absent += 1;
          else report.failed.push({ jobId: target.jobId, message: result.error?.message ?? "Runtime cleanup failed" });
        }
      }
    }
    return report;
  }

  async deleteCodexThread(userId: string, conversationId: string, threadId: string): Promise<number | null> {
    if (!isHostRootUser(userId)) return null;
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.user_id !== userId) return null;
    const project = conversation?.project_id ? this.db.getProjectForUser(conversation.project_id, userId) : undefined;
    const remoteWorkerId = project ? workerIdFromExecutor(project.executor_id) : null;
    if (remoteWorkerId) {
      try { await this.remoteWorkers.archiveThread(remoteWorkerId, threadId); }
      catch (error) {
        // Deletion is an idempotent saga step. A previous canonical
        // conversation may already have archived this same Remote thread.
        if (!isAlreadyAbsentRemoteThread(error, threadId)) throw error;
        return 0;
      }
      return 1;
    }
    return this.hostWorkerClient.deleteThread(userId, threadId);
  }

  async conversationRolloutBytes(conversationId: string): Promise<number | null> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation?.codex_thread_id) return null;
    if (conversation.cold_storage_state !== "local") return conversation.rollout_bytes;
    if (!isHostRootUser(conversation.user_id)) {
      return codexThreadRolloutBytes(ensureTenant(this.config.tenantRoot, conversation.user_id).codexHome, conversation.codex_thread_id);
    }
    const project = conversation.project_id ? this.db.getProjectForUser(conversation.project_id, conversation.user_id) : undefined;
    if (project && workerIdFromExecutor(project.executor_id)) return conversation.rollout_bytes;
    return this.hostWorkerClient.threadRolloutBytes(conversation.user_id, conversation.codex_thread_id);
  }

  async restoreColdConversation(userId: string, conversationId: string): Promise<void> {
    const restored = await this.hostWorkerClient.restoreColdConversation(userId, conversationId);
    if (!restored) throw new Error("冷存储恢复未完成");
  }

  projectDirectories(userId: string, executorId: string, directory: string) {
    if (!isHostRootUser(userId)) {
      if (executorId !== TENANT_LOCAL_EXECUTOR_ID) throw new Error("当前账号只能使用个人受限工作区");
      return listTenantProjectDirectories(ensureTenant(this.config.tenantRoot, userId), directory);
    }
    const resolvedDirectory = executorId === HOST_EXECUTOR_ID && !directory
      ? path.dirname(this.config.hostKnowledgeRoot)
      : directory;
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.projectDirectories(userId, resolvedDirectory)
      : this.remoteWorkers.projectFs(executorId, "list", resolvedDirectory);
  }

  validateProjectDirectory(userId: string, executorId: string, directory: string) {
    if (!isHostRootUser(userId)) {
      if (executorId !== TENANT_LOCAL_EXECUTOR_ID) throw new Error("当前账号只能使用个人受限工作区");
      return validateTenantProjectDirectory(ensureTenant(this.config.tenantRoot, userId), directory);
    }
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.validateProjectDirectory(userId, directory)
      : this.remoteWorkers.projectFs(executorId, "validate", directory);
  }

  createProjectDirectory(userId: string, executorId: string, parent: string, name: string) {
    if (!isHostRootUser(userId)) {
      if (executorId !== TENANT_LOCAL_EXECUTOR_ID) throw new Error("当前账号只能使用个人受限工作区");
      return createTenantProjectDirectory(ensureTenant(this.config.tenantRoot, userId), parent, name);
    }
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.createProjectDirectory(userId, parent, name)
      : this.remoteWorkers.projectFs(executorId, "create", parent, name);
  }

  initializeProjectDirectory(userId: string, executorId: string, directory: string, content: string) {
    if (!isHostRootUser(userId)) {
      if (executorId !== TENANT_LOCAL_EXECUTOR_ID) throw new Error("当前账号只能使用个人受限工作区");
      return initializeTenantProjectDirectory(ensureTenant(this.config.tenantRoot, userId), directory, content);
    }
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.initializeProjectDirectory(userId, directory, content)
      : this.remoteWorkers.projectFs(executorId, "initialize", directory, undefined, content);
  }

  refreshExecutorRuntime(userId: string, executorId: string, checkLatest = true): Promise<ExecutorRuntimeStatus> {
    if (!isHostRootUser(userId)) throw new Error("当前账号不能管理执行机器");
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.runtimeStatus(userId, checkLatest)
      : this.remoteWorkers.refreshRuntime(executorId, checkLatest);
  }

  async upgradeExecutorCodex(userId: string, executorId: string, version: string): Promise<ExecutorRuntimeStatus> {
    if (!isHostRootUser(userId)) throw new Error("当前账号不能管理执行机器");
    if (this.db.countRunningJobsForExecutor(executorId) > 0) throw new Error("目标机器仍有任务执行，暂不能升级 Codex");
    if (executorId === HOST_EXECUTOR_ID) {
      return this.hostWorkerClient.upgradeCodex(userId, version);
    }
    return this.remoteWorkers.upgradeCodex(executorId, version);
  }

  async listCodexAccounts(userId: string, executorId = HOST_EXECUTOR_ID): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    if (!isHostRootUser(userId)) return Promise.reject(new Error("当前账号不能管理 Codex 账号"));
    const previousAccountId = this.db.getExecutorActiveCodexAccount(executorId);
    const state = executorId === HOST_EXECUTOR_ID
      ? await this.hostWorkerClient.listCodexAccounts(userId)
      : await this.remoteWorkers.listCodexAccounts(executorId);
    this.db.setExecutorActiveCodexAccount(executorId, state.activeAccountId);
    if (previousAccountId !== state.activeAccountId) this.remoteWorkers.emit("quota_usage", { executorId });
    return this.withAccountQuotas(executorId, state);
  }

  beginCodexAccountLogin(userId: string, label: string, executorId = HOST_EXECUTOR_ID): Promise<CodexAccountLoginView> {
    if (!isHostRootUser(userId)) return Promise.reject(new Error("当前账号不能管理 Codex 账号"));
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.beginCodexAccountLogin(userId, label)
      : this.remoteWorkers.beginCodexAccountLogin(executorId, label);
  }

  codexAccountLoginStatus(userId: string, loginId: string, executorId = HOST_EXECUTOR_ID): Promise<CodexAccountLoginView> {
    if (!isHostRootUser(userId)) return Promise.reject(new Error("当前账号不能管理 Codex 账号"));
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.codexAccountLoginStatus(userId, loginId)
      : this.remoteWorkers.codexAccountLoginStatus(executorId, loginId);
  }

  cancelCodexAccountLogin(userId: string, loginId: string, executorId = HOST_EXECUTOR_ID): Promise<CodexAccountLoginView> {
    if (!isHostRootUser(userId)) return Promise.reject(new Error("当前账号不能管理 Codex 账号"));
    return executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.cancelCodexAccountLogin(userId, loginId)
      : this.remoteWorkers.cancelCodexAccountLogin(executorId, loginId);
  }

  async activateCodexAccount(userId: string, accountId: string, executorId = HOST_EXECUTOR_ID): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    if (!isHostRootUser(userId)) return Promise.reject(new Error("当前账号不能管理 Codex 账号"));
    const state = executorId === HOST_EXECUTOR_ID
      ? await this.hostWorkerClient.activateCodexAccount(userId, accountId)
      : await this.remoteWorkers.activateCodexAccount(executorId, accountId);
    this.db.setExecutorActiveCodexAccount(executorId, state.activeAccountId);
    this.remoteWorkers.emit("quota_usage", { executorId });
    return this.withAccountQuotas(executorId, state);
  }

  deleteCodexAccount(userId: string, accountId: string, executorId = HOST_EXECUTOR_ID): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    if (!isHostRootUser(userId)) return Promise.reject(new Error("当前账号不能管理 Codex 账号"));
    return (executorId === HOST_EXECUTOR_ID
      ? this.hostWorkerClient.deleteCodexAccount(userId, accountId)
      : this.remoteWorkers.deleteCodexAccount(executorId, accountId)).then((state) => this.withAccountQuotas(executorId, state));
  }

  private withAccountQuotas(executorId: string, state: { accounts: CodexAccountView[]; activeAccountId: string }): { accounts: CodexAccountView[]; activeAccountId: string } {
    return {
      ...state,
      accounts: state.accounts.map((account) => {
        const quota = this.db.getExecutorCodexQuota(executorId, account.id);
        return {
          ...account,
          quotaRemainingPercent: quota?.remainingPercent ?? null,
          quotaResetAt: quota?.resetAt ?? null,
          quotaUpdatedAt: quota?.updatedAt ?? null,
        };
      }),
    };
  }

  canDispatchConversation(conversationId: string): boolean {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation?.project_id) return true;
    const project = this.db.getProjectForUser(conversation.project_id, conversation.user_id);
    if (!project) return true;
    const executor = this.remoteWorkers.executor(project.executor_id);
    if (!workerIdFromExecutor(project.executor_id)) return true;
    return Boolean(executor?.status === "online"
      && this.remoteWorkers.canRun(project.executor_id)
      && remoteWorkerHasCapacity(this.db.countRunningJobsForExecutor(project.executor_id), executor.capacity));
  }

  async renameRemoteThread(conversationId: string, name: string): Promise<void> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation?.project_id || !conversation.codex_thread_id) return;
    const project = this.db.getProjectForUser(conversation.project_id, conversation.user_id);
    const workerId = project ? workerIdFromExecutor(project.executor_id) : null;
    if (workerId) await this.remoteWorkers.renameThread(workerId, conversation.codex_thread_id, name);
  }

  async steer(jobId: string, prompt: string, uploads: FileRow[]): Promise<string> {
    const job = this.db.getJob(jobId);
    if (!job || job.status !== "running") throw new Error("当前任务已经结束，无法引导");
    const conversation = this.db.getConversation(job.conversation_id);
    if (!conversation) throw new Error("会话不存在");
    const workspace = ensureTenantWorkspace(this.config.tenantRoot, conversation.user_id, conversation.id);
    const hostRoot = isHostRootUser(conversation.user_id);
    const project = conversation.project_id ? this.db.getProjectForUser(conversation.project_id, conversation.user_id) : undefined;
    const remoteWorkerId = project ? workerIdFromExecutor(project.executor_id) : null;
    const agentWorkspace = hostRoot ? this.hostWorkspace(conversation.user_id, conversation.id) : workspace;
    const attachmentContext = this.attachmentContext(uploads, workspace, agentWorkspace, hostRoot);
    const imageInputDecision = decideImageInput(attachmentContext);
    const effectivePrompt = buildAgentSteerPrompt(prompt, attachmentContext, imageInputDecision);
    const selectedImages = imageInputDecision.preload
      ? uploads.filter((file) => isSupportedImageAttachment(file.original_name, file.mime_type))
      : [];
    const imagePaths = selectedImages
      .map((file) => resolveInside(workspace, file.relative_path));
    const imageRelativePaths = selectedImages
      .map((file) => file.relative_path);
    const remoteTurnContext = remoteWorkerId && project && this.remoteWorkers.supportsAgentTurnContext(project.executor_id)
      ? {
          version: 1 as const,
          userPrompt: prompt,
          imageInput: imageInputDecision.preload ? "preload" as const : "none" as const,
        }
      : undefined;
    const turnId = remoteWorkerId
      ? await this.remoteWorkers.steer(jobId, prompt, uploads.map((row) => ({ row, absolutePath: resolveInside(workspace, row.relative_path) })), remoteTurnContext)
      : hostRoot
      ? await this.hostWorkerClient.steer(jobId, effectivePrompt, imageRelativePaths)
      : this.workerClient
      ? await this.workerClient.steer(jobId, effectivePrompt, imagePaths)
      : await this.directExecutions.get(jobId)?.steer(effectivePrompt, imagePaths);
    if (!turnId) throw new Error("当前任务尚未进入可引导状态，请稍后重试");
    this.publish(jobId, "progress", { kind: "status", label: "已收到实时引导，正在调整当前任务" });
    return turnId;
  }

  async run(jobId: string, conversationId: string, prompt: string, uploads: FileRow[], selection: AgentSelection, options: { resumeRemote?: boolean } = {}): Promise<void> {
    const controller = new AbortController();
    let runtimeRoot: string | undefined;
    let remoteArtifacts: StoredArtifact[] = [];
    let remoteOmittedArtifacts: NonNullable<Extract<TenantWorkerEvent, { type: "completed" }>["omittedArtifacts"]> = [];
    let executionObserved = false;
    let capacityAttemptHadProgress = false;
    let capacityAttemptReportedError = false;
    let capacityContinuationRequired = false;
    let lastRetryWasCapacity = false;
    this.abortControllers.set(jobId, controller);
    try {
      const conversation = this.db.getConversation(conversationId);
      if (!conversation) throw new Error("会话不存在");
      const tenant = ensureTenant(this.config.tenantRoot, conversation.user_id);
      const accountSkills = loadAccountSkillBundle(tenant.library);
      const personalContextSnapshot = loadPersonalContextForTurn(
        tenant.library, conversation.codex_thread_id, conversation.personal_context_revision,
        this.db.getPersonalMemoryState(conversation.user_id).revision, prompt,
      );
      const personalContext = personalContextSnapshot?.content;
      const workspace = ensureTenantWorkspace(this.config.tenantRoot, conversation.user_id, conversationId);
      const hostRoot = isHostRootUser(conversation.user_id);
      const project = conversation.project_id ? this.db.getProjectForUser(conversation.project_id, conversation.user_id) : undefined;
      const remoteWorkerId = project ? workerIdFromExecutor(project.executor_id) : null;
      const localCodexHome = hostRoot ? this.config.hostRootCodexHome : tenant.codexHome;
      const generatedImagesBeforeThreadId = conversation.codex_thread_id;
      const generatedImagesBefore = !remoteWorkerId && generatedImagesBeforeThreadId
        ? await snapshotGeneratedImages(localCodexHome, generatedImagesBeforeThreadId)
        : new Map<string, string>();
      const agentWorkspace = hostRoot ? this.hostWorkspace(conversation.user_id, conversationId) : workspace;
      const waitAutomationSupported = !remoteWorkerId || Boolean(project && this.remoteWorkers.supportsWaitAutomation(project.executor_id));
      const automation = waitAutomationSupported ? {
        baseUrl: this.config.publicBaseUrl.replace(/\/$/, "") || `http://127.0.0.1:${this.config.port}${this.config.basePath}`,
        token: createJobAutomationToken(this.config.sessionSecret, jobId, conversationId),
        receiptDirectory: path.join(agentWorkspace, ".automation", "wake-receipts"),
      } : undefined;
      const before = await snapshotDeliverables(workspace);
      runtimeRoot = prepareJobRuntime(workspace, jobId);
      const pythonRuntime = resolvePythonRuntime(this.config);
      const taskPolicy = assessTaskPolicy(prompt, uploads);
      const latestAssistant = this.db.getLatestAssistantMessage(conversationId);
      const interruptedContext = latestUserCancellationContext(latestAssistant ? [{
        id: latestAssistant.id,
        conversation_id: conversationId,
        role: "assistant",
        content: latestAssistant.content,
        created_at: "",
      }] : []);
      const storedCapabilities = this.db.getConversationOptionalCapabilities(conversationId);
      const optionalCapabilities = storedCapabilities
        ? updateOptionalAgentCapabilities(storedCapabilities, [prompt])
        : detectOptionalAgentCapabilities(this.db.listUserMessageContents(conversationId));
      this.db.setConversationOptionalCapabilities(conversationId, optionalCapabilities);
      this.db.updateJob(jobId, "running");
      this.db.updateConversation(conversationId, { status: "running" });
      const executionBoundaryLabel = remoteWorkerId
        ? "正在远程电脑上以本机用户高权限处理（非隔离）"
        : hostRoot
        ? "正在 CODEX_WEB 服务器上以 root 高权限处理（非隔离）"
        : taskPolicy.isolated
        ? "正在受限容器的离线隔离模式中处理"
        : "正在受限容器工作区中处理";
      this.publish(jobId, "status", { status: "running", label: executionBoundaryLabel });

      const attachments = this.attachmentContext(uploads, workspace, agentWorkspace, hostRoot);
      const imageInputDecision = decideImageInput(attachments);
      const baseEffectivePrompt = buildAgentTurnPrompt({
        userPrompt: prompt,
        attachments,
        personalContext,
        interruptedContext,
        runtimeWarning: !hostRoot && !pythonRuntime.ready
          ? "共享 Python 尚未初始化；如本轮需要 Python 或第三方包，请说明需要管理员先初始化，勿修改系统 Python。"
          : undefined,
        capabilityRoutingHint: optionalCapabilities.remotePlugin ? buildOptionalCapabilityRoutingHint(prompt) : undefined,
        isolationReason: !hostRoot && !remoteWorkerId && taskPolicy.isolated ? taskPolicy.reason : undefined,
        imageInputDecision,
      });
      const remoteUnifiedContext = Boolean(remoteWorkerId && project && this.remoteWorkers.supportsAgentTurnContext(project.executor_id));
      const remoteDynamicWait = Boolean(remoteWorkerId && project && this.remoteWorkers.supportsDynamicWaitTool(project.executor_id));
      const legacyWaitInstructions = Boolean(automation && remoteWorkerId && !remoteDynamicWait && !conversation.codex_thread_id);
      const effectivePrompt = appendWaitAutomationInstructions(baseEffectivePrompt, legacyWaitInstructions);
      const continuationEffectivePrompt = buildAgentTurnPrompt({
        userPrompt: MODEL_CAPACITY_CONTINUATION_PROMPT,
        attachments: [],
        personalContext,
        runtimeWarning: !hostRoot && !pythonRuntime.ready
          ? "共享 Python 尚未初始化；如本轮需要 Python 或第三方包，请说明需要管理员先初始化，勿修改系统 Python。"
          : undefined,
        capabilityRoutingHint: optionalCapabilities.remotePlugin ? buildOptionalCapabilityRoutingHint(prompt) : undefined,
        isolationReason: !hostRoot && !remoteWorkerId && taskPolicy.isolated ? taskPolicy.reason : undefined,
      });
      const selectedImagePaths = imageInputDecision.preload
        ? uploads.filter((file) => isSupportedImageAttachment(file.original_name, file.mime_type))
        : [];
      const request: TenantWorkerRunRequest = {
        jobId,
        userId: conversation.user_id,
        conversationId,
        projectRoot: this.config.projectRoot,
        projectDirectory: project && !hostRoot
          ? assertTenantProjectRoot(tenant, project.root_path)
          : tenant.library,
        pythonRuntimeRoot: this.config.pythonRuntimeRoot,
        tenantRoot: tenant.root,
        workspace,
        runtimeRoot,
        codexHome: tenant.codexHome,
        codexThreadId: conversation.codex_thread_id,
        effectivePrompt,
        imagePaths: selectedImagePaths
          .map((file) => resolveInside(workspace, file.relative_path)),
        selection,
        networkAccessEnabled: taskPolicy.networkAccessEnabled,
        webSearchMode: taskPolicy.isolated ? "cached" : "live",
        codexWindowsSandbox: this.config.codexWindowsSandbox,
        optionalCapabilities,
        automation,
      };
      const hostRequest: HostRootRunRequest = {
        jobId,
        userId: conversation.user_id,
        conversationId,
        projectRoot: conversation.project_id
          ? this.db.getProjectForUser(conversation.project_id, conversation.user_id)?.root_path ?? this.config.hostKnowledgeRoot
          : this.config.hostKnowledgeRoot,
        codexThreadId: conversation.codex_thread_id,
        effectivePrompt,
        imageRelativePaths: selectedImagePaths
          .map((file) => file.relative_path),
        selection,
        optionalCapabilities,
        accountSkills,
        automation,
      };
      let remoteThreadId = conversation.codex_thread_id;
      const callbacks = {
        onThreadStarted: (threadId: string) => {
          // Synchronizing the thread prevents accidental duplicate thread creation. It does
          // not make a started turn or its external side effects safe to replay.
          executionObserved = true;
          request.codexThreadId = threadId;
          hostRequest.codexThreadId = threadId;
          remoteThreadId = threadId;
          // The read-only Remote observer can publish a brand-new thread a few
          // milliseconds before this controlled run reports thread_started.
          // Claiming atomically merges that observer placeholder and prevents a
          // second visible conversation for the same project/thread.
          this.db.claimCodexThreadForConversation(conversationId, threadId);
          const latest = this.db.getConversation(conversationId);
          if (remoteWorkerId && latest && latest.title_source !== "default") {
            void this.remoteWorkers.renameThread(remoteWorkerId, threadId, latest.title).catch(() => undefined);
          }
        },
        onContextUsage: (usage: ContextTokenUsage) => {
          executionObserved = true;
          this.db.setConversationContextUsage(conversationId, usage);
        },
        onQuotaUsage: (usage: CodexQuotaUsage) => {
          executionObserved = true;
          this.db.setConversationCodexQuota(conversationId, usage);
          if (!remoteWorkerId && project) this.remoteWorkers.emit("quota_usage", { executorId: project.executor_id });
        },
        onProgress: (payload: unknown) => {
          executionObserved = true;
          if (isMeaningfulExecutionProgress(payload)) capacityAttemptHadProgress = true;
          if (isModelCapacityProgress(payload)) capacityAttemptReportedError = true;
          if (containsPersonalContext(payload)) return;
          this.publish(jobId, "progress", payload);
        },
      };
      if (!remoteWorkerId) {
        const codexEgress = await selectCodexEgress({ signal: controller.signal });
        request.codexEgressKind = codexEgress.kind;
        hostRequest.codexEgressKind = codexEgress.kind;
        if (codexEgress.kind === "backup") {
          this.publish(jobId, "progress", {
            kind: "status",
            status: "warning",
            label: CODEX_EGRESS_FALLBACK_NOTICE,
          });
        }
      }
      const rawFinalResponse = await runWithTransientRetries(async (retryAttempt) => {
        capacityAttemptHadProgress = false;
        capacityAttemptReportedError = false;
        const continuationAttempt = capacityContinuationRequired;
        const attemptUserPrompt = capacityRetryPrompt(prompt, continuationAttempt);
        const attemptEffectivePrompt = continuationAttempt ? continuationEffectivePrompt : effectivePrompt;
        const attemptRemotePrompt = appendPersonalContextToUserPrompt(attemptUserPrompt, personalContext);
        const attemptUploads = continuationAttempt ? [] : uploads;
        request.effectivePrompt = attemptEffectivePrompt;
        request.imagePaths = continuationAttempt ? [] : selectedImagePaths
          .map((file) => resolveInside(workspace, file.relative_path));
        hostRequest.effectivePrompt = attemptEffectivePrompt;
        hostRequest.imageRelativePaths = continuationAttempt ? [] : selectedImagePaths
          .map((file) => file.relative_path);
        if (retryAttempt > 0) {
          this.publish(jobId, "progress", {
            kind: "retry",
            label: lastRetryWasCapacity
              ? continuationAttempt
                ? `正在进行第 ${retryAttempt} 次容量续接`
                : `正在进行第 ${retryAttempt} 次容量重试`
              : `正在进行第 ${retryAttempt} 次连接重试`,
            ...(continuationAttempt ? { detail: "正在原会话中继续未完成的任务，不会重发原始用户指令。" } : {}),
          });
          this.publish(jobId, "status", {
            status: "running",
            label: continuationAttempt
              ? `正在进行第 ${retryAttempt} 次自动续接`
              : `正在进行第 ${retryAttempt} 次自动重试`,
          });
        }
        if (remoteWorkerId && project) {
          const result = options.resumeRemote
            ? await this.remoteWorkers.resume(jobId, remoteWorkerId, callbacks)
            : await this.remoteWorkers.run(remoteWorkerId, {
            jobId,
            conversationId,
            projectRoot: project.root_path,
            codexThreadId: remoteThreadId,
            prompt: appendWaitAutomationInstructions(attemptRemotePrompt, continuationAttempt ? false : legacyWaitInstructions),
            selection,
            optionalCapabilities,
            ...(this.remoteWorkers.supportsAccountSkills(project.executor_id) ? { accountSkills } : {}),
            automation: automation ? {
              token: automation.token,
              ...(remoteDynamicWait ? { dynamicTool: true as const } : {}),
            } : undefined,
            ...(remoteUnifiedContext ? {
              turnContext: {
                version: 1 as const,
                userPrompt: attemptRemotePrompt,
                ...(!continuationAttempt && interruptedContext ? { interruptedContext } : {}),
                imageInput: !continuationAttempt && imageInputDecision.preload ? "preload" as const : "none" as const,
              },
            } : {}),
          }, attemptUploads.map((row) => ({ row, absolutePath: resolveInside(workspace, row.relative_path) })), callbacks);
          remoteArtifacts = result.artifacts;
          remoteOmittedArtifacts = result.omittedArtifacts;
          return result.finalResponse;
        }
        if (hostRoot) return this.hostWorkerClient.run(hostRequest, callbacks);
        if (this.workerClient) return this.workerClient.run(request, callbacks);
        const execution = startTenantTurn(request, { signal: controller.signal, ...callbacks });
        this.directExecutions.set(jobId, execution);
        try { return await execution.result; }
        finally { if (this.directExecutions.get(jobId) === execution) this.directExecutions.delete(jobId); }
      }, {
        signal: controller.signal,
        // A no-progress capacity rejection safely retries the original prompt. Once an
        // attempt has produced meaningful work, the next capacity retry starts a fresh turn
        // in the same thread with an explicit continuation prompt instead of replaying the
        // original user request. Transport retries retain the stricter whole-operation rule.
        canRetry: (error) => isModelCapacityError(error) || !executionObserved,
        onRetry: ({ attempt, maxAttempts, delayMs, message }) => {
          const capacityError = isModelCapacityError(message);
          lastRetryWasCapacity = capacityError;
          if (capacityError) {
            const continueExistingWork = capacityAttemptHadProgress || capacityContinuationRequired;
            capacityContinuationRequired = continueExistingWork;
            if (!capacityAttemptReportedError) this.publish(jobId, "progress", {
              kind: "error",
              label: redactBrandForDisplay(message),
            });
            this.publish(jobId, "progress", {
              kind: "retry",
              label: `容量不足，将在 ${retryDelayLabel(delayMs)} 后进行第 ${attempt} 次${continueExistingWork ? "续接" : "重试"}`,
              detail: continueExistingWork
                ? `本次已经产生执行进展；系统会在原会话中自动继续未完成的任务，不会重发原始用户指令，并持续尝试直到你主动停止。错误：${redactBrandForDisplay(message)}`
                : `本次没有检测到新的命令、文件或阶段进展；系统会持续重试，直到你主动停止任务。错误：${redactBrandForDisplay(message)}`,
            });
          }
          this.publish(jobId, "status", {
            status: "retrying",
            label: capacityError
              ? `模型容量不足，${retryDelayLabel(delayMs)}后进行第 ${attempt} 次${capacityContinuationRequired ? "续接" : "重试"}`
              : "上游连接短暂中断，正在自动重试",
            retryAttempt: attempt,
            ...(maxAttempts !== undefined ? { retryMaxAttempts: maxAttempts } : {}),
            retryDelaySeconds: delayMs / 1000,
            retryAt: new Date(Date.now() + delayMs).toISOString(),
          });
        },
      });

      this.publish(jobId, "status", { status: "running", label: "正在校验并原子登记结果" });
      const messageId = newId();
      const createdAt = new Date().toISOString();
      const finalResponse = stripPersonalContext(
        (conversation.title_source === "ai" ? extractLeakedAutoTitleAnswer(rawFinalResponse, true) : null)
          ?? rawFinalResponse,
      );
      const remoteArtifactCandidates = remoteArtifacts.map((artifact) => ({
        artifact,
        deliveryName: remoteArtifactDeliveryName(artifact.name),
      }));
      const rejectedRemoteArtifacts = remoteArtifactCandidates.filter((item) => !item.deliveryName);
      const omissionItems = [
        ...remoteOmittedArtifacts.map((item) => `${item.path}（${remoteOmissionReason(item.reason)}）`),
        ...rejectedRemoteArtifacts.map(({ artifact }) => `${remoteArtifactDisplayName(artifact.name)}（隐藏或异常文件名不允许交付）`),
      ];
      const omissionNotice = omissionItems.length > 0
        ? `\n\n> Remote Worker 结果文件提示：${omissionItems.join("；")}`
        : "";
      const safeFinalResponse = sanitizeAgentMarkdown(`${finalResponse}${omissionNotice}`, this.db.listFiles(conversationId));
      const message = {
        id: messageId,
        conversation_id: conversationId,
        role: "assistant" as const,
        content: safeFinalResponse || "任务已完成。",
        created_at: createdAt,
      };
      const fileSources: FinalizationFileSource[] = [];
      if (remoteWorkerId) {
        for (const { artifact, deliveryName } of remoteArtifactCandidates) {
          if (!deliveryName) continue;
          const fileId = newId();
          const storedPath = path.posix.join("deliverables", fileId, deliveryName);
          fileSources.push({ row: {
            id: fileId, conversation_id: conversationId, message_id: messageId,
            original_name: deliveryName, relative_path: storedPath, mime_type: artifact.mimeType,
            size: artifact.size, kind: "output", created_at: createdAt,
          }, sourcePath: artifact.tempPath, expectedSha256: artifact.sha256 });
        }
      } else {
        const after = await snapshotDeliverables(workspace);
        let hasExplicitImageOutput = false;
        for (const [relativePath, fingerprint] of after) {
          if (before.get(relativePath) === fingerprint) continue;
          const portablePath = normalizeStoredRelativePath(relativePath);
          const absolute = resolveInside(workspace, portablePath);
          const stat = await fs.promises.stat(absolute);
          const mimeType = guessMime(relativePath);
          if (mimeType.startsWith("image/")) hasExplicitImageOutput = true;
          const fileId = newId();
          const storedPath = path.posix.join("deliverables", fileId, path.basename(portablePath));
          const file: FileRow = {
            id: fileId, conversation_id: conversationId, message_id: messageId,
            original_name: path.basename(portablePath), relative_path: storedPath,
            mime_type: mimeType, size: stat.size, kind: "output", created_at: createdAt,
          };
          fileSources.push({ row: file, sourcePath: absolute });
        }
        // The built-in image generator writes to CODEX_HOME/generated_images and tells
        // the model that the image is already visible. Codex Web messages are persisted
        // from text plus registered files, so collect thread-owned images when the agent
        // did not explicitly copy an image into outputs/ itself.
        const generatedImageThreadId = request.codexThreadId;
        if (!hasExplicitImageOutput && generatedImageThreadId) {
          const baseline = generatedImagesBeforeThreadId === generatedImageThreadId
            ? generatedImagesBefore
            : new Map<string, string>();
          const generatedImagesAfter = await snapshotGeneratedImages(localCodexHome, generatedImageThreadId);
          const newGeneratedImages = [...generatedImagesAfter]
            .filter(([fileName, fingerprint]) => baseline.get(fileName) !== fingerprint);
          for (const [index, [fileName]] of newGeneratedImages.entries()) {
            const absolute = resolveGeneratedImage(localCodexHome, generatedImageThreadId, fileName);
            const stat = await fs.promises.lstat(absolute);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const extension = path.extname(fileName).toLowerCase();
            const originalName = newGeneratedImages.length === 1
              ? `AI生成图片${extension}`
              : `AI生成图片-${index + 1}${extension}`;
            const fileId = newId();
            const storedPath = path.posix.join("deliverables", fileId, originalName);
            fileSources.push({ row: {
              id: fileId, conversation_id: conversationId, message_id: messageId,
              original_name: originalName, relative_path: storedPath,
              mime_type: guessMime(fileName), size: stat.size, kind: "output", created_at: createdAt,
            }, sourcePath: absolute });
          }
        }
      }
      const stagedPayload: JobFinalizationPayload = { message, files: fileSources.map(({ row }) => row) };
      this.db.stageJobFinalization(jobId, stagedPayload);
      const preparedFiles = await prepareFinalizationFiles(this.config.dataRoot, jobId, fileSources);
      const readyPayload: JobFinalizationPayload = { message, files: preparedFiles };
      this.db.markJobFilesReady(jobId, readyPayload);
      this.db.finalizeJob(jobId, conversationId, readyPayload);
      if (personalContextSnapshot) {
        this.db.setConversationPersonalContextRevision(conversationId, personalContextSnapshot.revision);
      }
      if (!this.db.hasJobEvent(jobId, "done")) this.publish(jobId, "done", { status: "completed" });
      this.db.publishJobFinalization(jobId);
      if (remoteWorkerId) this.remoteWorkers.release(jobId);
      await cleanupFinalizationDirectory(this.config.dataRoot, jobId).catch((error) => {
        console.warn("Finalization staging cleanup failed", error instanceof Error ? error.message : error);
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const interrupted = !cancelled && error instanceof Error && (
        error.name === "TurnInterruptedError"
        || (executionObserved && isConnectionInterruptionError(error))
      );
      const message = cancelled
        ? "任务已停止"
        : interrupted
        ? "连接在本轮开始后中断。为避免重复执行命令或外部副作用，系统没有整轮重试；请确认现场状态后再继续。"
        : error instanceof Error ? redactBrandForDisplay(error.message) : "Agent 任务失败";
      try {
        this.db.finishJob(jobId, conversationId, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", message,
          interrupted ? `本轮已经开始执行，但随后连接中断。为避免重复产生副作用，系统没有自动重放。\n\n${message}` : undefined);
      } catch {
        // Keep a single failed job from becoming an unhandled rejection that terminates the service.
      }
      this.remoteWorkers.release(jobId);
      try {
        this.publish(jobId, cancelled ? "done" : "failed", { status: cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", message });
      } catch {
        // The database may already be unavailable; the service must stay alive for recovery and diagnostics.
      }
    } finally {
      this.abortControllers.delete(jobId);
      this.directExecutions.delete(jobId);
      if (runtimeRoot) cleanupJobRuntime(runtimeRoot);
      try { cleanupOwnedStagingDirectory(this.config.dataRoot, "remote-worker-staging", jobId); }
      catch { /* Staging cleanup must not mask the job result. */ }
    }
  }

  recoverRemoteJobs(): Promise<void> {
    const recoveries: Promise<void>[] = [];
    for (const job of this.db.listRunningJobs()) {
      const conversation = this.db.getConversation(job.conversation_id);
      const project = conversation?.project_id ? this.db.getProjectForUser(conversation.project_id, conversation.user_id) : undefined;
      if (!conversation || !project || !workerIdFromExecutor(project.executor_id) || !job.message_id) continue;
      const message = this.db.getMessage(job.message_id);
      if (!message) continue;
      const selection: AgentSelection = {
        model: job.agent_model ?? "gpt-5.6-sol",
        reasoningEffort: (job.reasoning_effort ?? "high") as AgentSelection["reasoningEffort"],
      };
      recoveries.push(this.run(job.id, conversation.id, message.content, this.db.listFilesForMessage(message.id), selection, { resumeRemote: true }));
    }
    return Promise.allSettled(recoveries).then(() => undefined);
  }

  private hostWorkspace(userId: string, conversationId: string): string {
    return path.join(this.config.hostTenantRoot, userId, "conversations", conversationId);
  }

  private attachmentContext(uploads: FileRow[], workspace: string, agentWorkspace: string, hostRoot: boolean): AgentAttachmentContext[] {
    return uploads.map((file) => ({
      name: file.original_name,
      mimeType: file.mime_type,
      path: hostRoot
        ? resolveInside(agentWorkspace, file.relative_path)
        : resolveInside(workspace, file.relative_path),
    }));
  }
}

function parseFinalizationPayload(value: string | null): JobFinalizationPayload | null {
  if (!value) return null;
  try {
    const payload = JSON.parse(value) as JobFinalizationPayload;
    if (!payload || typeof payload !== "object" || !payload.message || !Array.isArray(payload.files)) return null;
    if (typeof payload.message.id !== "string" || typeof payload.message.conversation_id !== "string" || payload.message.role !== "assistant") return null;
    if (payload.files.some((file) => !file || typeof file.id !== "string" || typeof file.relative_path !== "string" || file.kind !== "output")) return null;
    return payload;
  } catch { return null; }
}

export function redactBrandForDisplay(value: string): string {
  return value.replace(/chatgpt|codex/gi, "Codex Web");
}

export function summarizeEvent(event: ThreadEvent): unknown | null {
  if (event.type === "error") return isModelCapacityError(event.message)
    ? { kind: "error", label: redactBrandForDisplay(event.message) }
    : isRetryableUpstreamError(event.message)
    ? { kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" }
    : { kind: "error", label: redactBrandForDisplay(event.message) };
  if (event.type === "turn.started") return { kind: "status", label: "已开始分析" };
  if (event.type === "turn.completed") return { kind: "status", label: "工作已完成，正在整理结果" };
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;
  const item = event.item;
  if (item.type === "reasoning") {
    const summary = redactBrandForDisplay(sanitizeAgentMarkdown(item.text)).trim();
    return summary ? { kind: "reasoning", label: "模型思路摘要", detail: summary } : null;
  }
  if (item.type === "command_execution") {
    const detail = redactBrandForDisplay(item.command);
    return {
      kind: "command",
      label: commandProgressLabel(item.command, item.status),
      detail,
    };
  }
  if (item.type === "file_change") return { kind: "file", label: "已更新文件", files: item.changes.map((change) => change.path) };
  if (item.type === "web_search") return { kind: "search", label: "正在搜索资料", detail: item.query };
  if (item.type === "mcp_tool_call") return { kind: "tool", label: `正在使用 ${redactBrandForDisplay(item.server)}`, detail: redactBrandForDisplay(item.tool) };
  if (item.type === "todo_list") return { kind: "todo", label: "任务计划已更新", items: item.items };
  if (item.type === "error") return isModelCapacityError(item.message)
    ? { kind: "error", label: redactBrandForDisplay(item.message) }
    : isRetryableUpstreamError(item.message)
    ? { kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" }
    : { kind: "error", label: redactBrandForDisplay(item.message) };
  if (item.type === "agent_message" && event.type === "item.completed") {
    const detail = redactBrandForDisplay(sanitizeAgentMarkdown(item.text)).trim();
    return detail ? { kind: "update", label: "阶段反馈", detail } : null;
  }
  return null;
}

function commandProgressLabel(command: string, status: "in_progress" | "completed" | "failed"): string {
  const running = status === "in_progress";
  if (status === "failed") return "本机步骤执行失败，正在调整";
  const presentationQa = /&\s+[^;\r\n]*(?:slides_test|create_montage|render_slides)\.(?:py|mjs)/i.test(command)
    || /run-python-task\.(?:ps1|sh)[^;\r\n]*(?:-Script|--script)\s+[^;\r\n]*(?:slides_test|create_montage|render_slides)\.(?:py|mjs)/i.test(command);
  if (presentationQa) return running ? "正在检查演示文稿质量" : "演示文稿质量检查完成";
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint)|\bpytest\b|\bnode\s+--test\b|\bslides_test\b/i.test(command)) {
    return running ? "正在运行质量验证" : "质量验证完成";
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\btsc\b|build[_-]?(?:ppt|doc|report)|render/i.test(command)) {
    return running ? "正在生成或渲染结果" : "结果生成或渲染完成";
  }
  if (/\b(?:rg|Select-String|Get-Content|type)\b/i.test(command)) {
    return running ? "正在读取并核对资料" : "资料读取与核对完成";
  }
  if (/\b(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add|sync)\b/i.test(command)) {
    return running ? "正在准备所需工具" : "所需工具准备完成";
  }
  if (/\b(?:python|node)(?:\.exe)?\b|\.py\b|\.mjs\b/i.test(command)) {
    return running ? "正在处理数据或生成内容" : "数据与内容处理完成";
  }
  if (/\b(?:Get-ChildItem|Test-Path|git\s+(?:status|diff))\b/i.test(command)) {
    return running ? "正在检查文件与工作区" : "文件与工作区检查完成";
  }
  return running ? "正在执行本机处理步骤" : "本机处理步骤完成";
}

function remoteOmissionReason(reason: NonNullable<Extract<TenantWorkerEvent, { type: "completed" }>["omittedArtifacts"]>[number]["reason"]): string {
  return ({
    count_limit: "超过单轮 20 个文件上限",
    outside_project: "路径不在项目根目录内",
    missing: "完成时文件已不存在",
    not_file: "目标不是普通文件",
    too_large: "超过单文件 100 MiB 上限",
    manifest_limit: "其余省略项已合并计数",
  })[reason];
}

export function remoteArtifactDeliveryName(name: string): string | null {
  const normalized = normalizeStoredRelativePath(name);
  const deliveryName = path.posix.basename(normalized);
  if (!deliveryName || /[\u0000-\u001f\u007f]/.test(deliveryName)) return null;
  const probeId = "00000000-0000-4000-8000-000000000000";
  return isPersistedDeliverablePath(path.posix.join("deliverables", probeId, deliveryName)) ? deliveryName : null;
}

function remoteArtifactDisplayName(name: string): string {
  return normalizeStoredRelativePath(name).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 200) || "未命名文件";
}

function guessMime(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
    ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".htm": "text/html",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
