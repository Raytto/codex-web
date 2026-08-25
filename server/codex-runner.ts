import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { AppConfig } from "./config.js";
import { AppDatabase, type FileRow } from "./db.js";
import { codexThreadRolloutBytes, ensureTenant, ensureTenantWorkspace, newId, normalizeStoredRelativePath, persistDeliverable, resolveGeneratedImage, resolveInside, snapshotDeliverables, snapshotGeneratedImages } from "./paths.js";
import { cleanupJobRuntime, prepareJobRuntime, resolvePythonRuntime } from "./python-runtime.js";
import { assessTaskPolicy } from "./task-policy.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import type { AgentSelection } from "./model-options.js";
import { startTenantTurn } from "./tenant-worker-execution.js";
import { TenantWorkerClient } from "./tenant-worker-client.js";
import type { TenantWorkerRunRequest } from "./tenant-worker-protocol.js";
import type { AppServerTurnExecution, CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";
import { isConnectionInterruptionError, isModelCapacityError, isRetryableUpstreamError, runWithTransientRetries } from "./retry-policy.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt, type AgentAttachmentContext } from "./agent-context.js";
import { detectOptionalAgentCapabilities } from "./optional-capabilities.js";
import { latestUserCancellationContext } from "./cancellation-summary.js";
import { appendWaitAutomationInstructions, createJobAutomationToken } from "./wake-automation.js";
import {
  buildConversationTitlePrompt,
  CONVERSATION_TITLE_CODEX_MODEL,
  CONVERSATION_TITLE_PROMPT_VERSION,
  CONVERSATION_TITLE_REASONING_EFFORT,
  CONVERSATION_TITLE_TIMEOUT_MS,
  extractTitleRequestText,
  parseConversationTitleOutput,
  runCodexConversationTitle,
} from "./conversation-title.js";

type Publish = (jobId: string, eventType: string, payload: unknown) => void;

export const AUTO_TITLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "给用户显示的完整最终回复" },
    title: { type: "string", minLength: 1, maxLength: 10, description: "准确概括首条请求的简短中文任务名，不超过十个字符" },
  },
  required: ["answer", "title"],
  additionalProperties: false,
} as const;

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
  const maxTitleLength = tolerateSchemaTitleOverflow ? 80 : AUTO_TITLE_OUTPUT_SCHEMA.properties.title.maxLength;
  if (!title || Array.from(title).length > maxTitleLength || /[\r\n]/.test(title)) return null;
  return envelope.answer;
}

export function parseAutoTitleResponse(raw: string, prompt: string): { answer: string; title: string } {
  const parsed = parseAutoTitleEnvelope(raw);
  if (parsed) return { answer: parsed.answer, title: normalizeTaskTitle(parsed.title, prompt) };
  return { answer: raw, title: normalizeTaskTitle("", prompt) };
}

function normalizeTaskTitle(value: string, prompt: string): string {
  const clean = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[`'"“”‘’《》【】\[\]()（）]+|[`'"“”‘’《》【】\[\]()（）。！？!?，,；;：:]+$/g, "")
    .trim();
  const fallback = prompt
    .replace(/\s+/g, " ")
    .replace(/^(?:请|麻烦|能否|可以)?(?:帮我|给我)?(?:一下)?/u, "")
    .trim() || "任务处理";
  const candidate = clean && clean !== "新任务" ? clean : fallback;
  return Array.from(candidate).slice(0, 10).join("");
}

export class CodexRunner {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly directExecutions = new Map<string, AppServerTurnExecution>();
  private readonly workerClient: TenantWorkerClient | undefined;
  private readonly titleRequests = new Map<string, Promise<void>>();

  constructor(private readonly config: AppConfig, private readonly db: AppDatabase, private readonly publish: Publish) {
    this.workerClient = config.tenantWorkerIsolation ? new TenantWorkerClient() : undefined;
  }

  cancel(jobId: string): boolean {
    const controller = this.abortControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    this.directExecutions.get(jobId)?.interrupt();
    this.workerClient?.cancel(jobId);
    return true;
  }

  get activeJobCount(): number {
    return this.abortControllers.size;
  }

  conversationRolloutBytes(conversationId: string): number | null {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation?.codex_thread_id) return null;
    return codexThreadRolloutBytes(ensureTenant(this.config.tenantRoot, conversation.user_id).codexHome, conversation.codex_thread_id);
  }

  async steer(jobId: string, prompt: string, uploads: FileRow[]): Promise<string> {
    const job = this.db.getJob(jobId);
    if (!job || job.status !== "running") throw new Error("当前任务已经结束，无法引导");
    const conversation = this.db.getConversation(job.conversation_id);
    if (!conversation) throw new Error("会话不存在");
    const workspace = ensureTenantWorkspace(this.config.tenantRoot, conversation.user_id, conversation.id);
    const effectivePrompt = buildAgentSteerPrompt(
      prompt,
      this.attachmentContext(uploads, workspace),
    );
    const imagePaths = uploads
      .filter((file) => /^image\/(png|jpeg|webp)$/i.test(file.mime_type))
      .map((file) => resolveInside(workspace, file.relative_path));
    const turnId = this.workerClient
      ? await this.workerClient.steer(jobId, effectivePrompt, imagePaths)
      : await this.directExecutions.get(jobId)?.steer(effectivePrompt, imagePaths);
    if (!turnId) throw new Error("当前任务尚未进入可引导状态，请稍后重试");
    this.publish(jobId, "progress", { kind: "status", label: "已收到实时引导，正在调整当前任务" });
    return turnId;
  }

  async run(jobId: string, conversationId: string, prompt: string, uploads: FileRow[], selection: AgentSelection): Promise<void> {
    const controller = new AbortController();
    let runtimeRoot: string | undefined;
    let executionObserved = false;
    let capacityAttemptHadProgress = false;
    let capacityAttemptReportedError = false;
    let capacityContinuationRequired = false;
    let lastRetryWasCapacity = false;
    this.abortControllers.set(jobId, controller);
    try {
      const conversation = this.db.getConversation(conversationId);
      if (!conversation) throw new Error("会话不存在");
      const automation = {
        baseUrl: this.config.publicBaseUrl.replace(/\/$/, "") || `http://127.0.0.1:${this.config.port}${this.config.basePath}`,
        token: createJobAutomationToken(this.config.sessionSecret, jobId, conversationId),
      };
      const job = this.db.getJob(jobId);
      const shouldGenerateTitle = conversation.title_source === "default"
        && Boolean(job?.message_id && this.db.isFirstUserMessage(conversationId, job.message_id));
      const tenant = ensureTenant(this.config.tenantRoot, conversation.user_id);
      const workspace = ensureTenantWorkspace(this.config.tenantRoot, conversation.user_id, conversationId);
      const generatedImagesBeforeThreadId = conversation.codex_thread_id;
      const generatedImagesBefore = generatedImagesBeforeThreadId
        ? await snapshotGeneratedImages(tenant.codexHome, generatedImagesBeforeThreadId)
        : new Map<string, string>();
      const before = await snapshotDeliverables(workspace);
      runtimeRoot = prepareJobRuntime(workspace, jobId);
      const pythonRuntime = resolvePythonRuntime(this.config);
      const taskPolicy = assessTaskPolicy(prompt, uploads);
      const conversationMessages = this.db.listMessages(conversationId);
      const interruptedContext = latestUserCancellationContext(conversationMessages);
      const optionalCapabilities = detectOptionalAgentCapabilities([
        ...conversationMessages.filter((message) => message.role === "user").map((message) => message.content),
        prompt,
      ]);
      this.db.updateJob(jobId, "running");
      this.db.updateConversation(conversationId, { status: "running" });
      this.publish(jobId, "status", { status: "running", label: taskPolicy.isolated ? "正在隔离模式中处理" : "Codex Web 正在处理" });

      const effectivePrompt = appendWaitAutomationInstructions(buildAgentTurnPrompt({
        userPrompt: prompt,
        attachments: this.attachmentContext(uploads, workspace),
        interruptedContext,
        runtimeWarning: !pythonRuntime.ready
          ? "共享 Python 尚未初始化；如本轮需要 Python 或第三方包，请说明需要管理员先初始化，勿修改系统 Python。"
          : undefined,
        isolationReason: taskPolicy.isolated ? taskPolicy.reason : undefined,
      }));
      const continuationEffectivePrompt = buildAgentTurnPrompt({
        userPrompt: MODEL_CAPACITY_CONTINUATION_PROMPT,
        attachments: [],
        runtimeWarning: !pythonRuntime.ready
          ? "共享 Python 尚未初始化；如本轮需要 Python 或第三方包，请说明需要管理员先初始化，勿修改系统 Python。"
          : undefined,
        isolationReason: taskPolicy.isolated ? taskPolicy.reason : undefined,
      });
      const request: TenantWorkerRunRequest = {
        jobId,
        userId: conversation.user_id,
        conversationId,
        projectRoot: this.config.projectRoot,
        pythonRuntimeRoot: this.config.pythonRuntimeRoot,
        tenantRoot: tenant.root,
        workspace,
        runtimeRoot,
        codexHome: tenant.codexHome,
        library: tenant.library,
        codexThreadId: conversation.codex_thread_id,
        effectivePrompt,
        imagePaths: uploads
          .filter((file) => /^image\/(png|jpeg|webp)$/i.test(file.mime_type))
          .map((file) => resolveInside(workspace, file.relative_path)),
        outputSchema: undefined,
        selection,
        networkAccessEnabled: taskPolicy.networkAccessEnabled,
        webSearchMode: taskPolicy.isolated ? "cached" : "live",
        codexWindowsSandbox: this.config.codexWindowsSandbox,
        optionalCapabilities,
        automation,
      };
      const callbacks = {
        onThreadStarted: (threadId: string) => {
          executionObserved = true;
          request.codexThreadId = threadId;
          this.db.updateConversation(conversationId, { codexThreadId: threadId });
        },
        onContextUsage: (usage: ContextTokenUsage) => {
          executionObserved = true;
          this.db.setConversationContextUsage(conversationId, usage);
        },
        onQuotaUsage: (usage: CodexQuotaUsage) => {
          executionObserved = true;
          this.db.setConversationCodexQuota(conversationId, usage);
        },
        onProgress: (payload: unknown) => {
          executionObserved = true;
          if (isMeaningfulExecutionProgress(payload)) capacityAttemptHadProgress = true;
          if (isModelCapacityProgress(payload)) capacityAttemptReportedError = true;
          this.publish(jobId, "progress", payload);
        },
      };
      const rawFinalResponse = await runWithTransientRetries(async (retryAttempt) => {
        capacityAttemptHadProgress = false;
        capacityAttemptReportedError = false;
        const continuationAttempt = capacityContinuationRequired;
        request.effectivePrompt = continuationAttempt ? continuationEffectivePrompt : effectivePrompt;
        request.imagePaths = continuationAttempt ? [] : uploads
          .filter((file) => /^image\/(png|jpeg|webp)$/i.test(file.mime_type))
          .map((file) => resolveInside(workspace, file.relative_path));
        if (retryAttempt > 0) {
          this.publish(jobId, "progress", {
            kind: "retry",
            label: lastRetryWasCapacity
              ? continuationAttempt ? `正在进行第 ${retryAttempt} 次容量续接` : `正在进行第 ${retryAttempt} 次容量重试`
              : `正在进行第 ${retryAttempt} 次连接重试`,
            ...(continuationAttempt ? { detail: "正在原会话中继续未完成的任务，不会重发原始用户指令。" } : {}),
          });
          this.publish(jobId, "status", {
            status: "running",
            label: continuationAttempt ? `正在进行第 ${retryAttempt} 次自动续接` : `正在进行第 ${retryAttempt} 次自动重试`,
          });
        }
        if (this.workerClient) return this.workerClient.run(request, callbacks);
        const execution = startTenantTurn(request, { signal: controller.signal, ...callbacks });
        this.directExecutions.set(jobId, execution);
        try { return await execution.result; }
        finally { if (this.directExecutions.get(jobId) === execution) this.directExecutions.delete(jobId); }
      }, {
        signal: controller.signal,
        canRetry: (error) => isModelCapacityError(error) || !executionObserved,
        onRetry: ({ attempt, maxAttempts, delayMs, message }) => {
          const capacityError = isModelCapacityError(message);
          lastRetryWasCapacity = capacityError;
          if (capacityError) {
            const continueExistingWork = capacityAttemptHadProgress || capacityContinuationRequired;
            capacityContinuationRequired = continueExistingWork;
            if (!capacityAttemptReportedError) this.publish(jobId, "progress", { kind: "error", label: redactBrandForDisplay(message) });
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
            label: capacityError ? `模型容量不足，${retryDelayLabel(delayMs)}后进行第 ${attempt} 次${capacityContinuationRequired ? "续接" : "重试"}` : "上游连接短暂中断，正在自动重试",
            retryAttempt: attempt,
            ...(maxAttempts !== undefined ? { retryMaxAttempts: maxAttempts } : {}),
            retryDelaySeconds: delayMs / 1000,
            retryAt: new Date(Date.now() + delayMs).toISOString(),
          });
        },
      });

      this.publish(jobId, "status", { status: "running", label: "正在登记结果文件" });
      const messageId = newId();
      const createdAt = new Date().toISOString();
      const finalResponse = (conversation.title_source === "ai" ? extractLeakedAutoTitleAnswer(rawFinalResponse, true) : null)
        ?? rawFinalResponse;
      const safeFinalResponse = sanitizeAgentMarkdown(finalResponse, this.db.listFiles(conversationId));
      this.db.addMessage({
        id: messageId,
        conversation_id: conversationId,
        role: "assistant",
        content: safeFinalResponse || "任务已完成。",
        created_at: createdAt,
      });
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
        const storedPath = await persistDeliverable(this.config.dataRoot, workspace, portablePath, fileId);
        const file: FileRow = {
          id: fileId, conversation_id: conversationId, message_id: messageId,
          original_name: path.basename(portablePath), relative_path: storedPath,
          mime_type: mimeType, size: stat.size, kind: "output", created_at: createdAt,
        };
        this.db.addFile(file);
      }
      const generatedImageThreadId = request.codexThreadId;
      if (!hasExplicitImageOutput && generatedImageThreadId) {
        const baseline = generatedImagesBeforeThreadId === generatedImageThreadId
          ? generatedImagesBefore
          : new Map<string, string>();
        const generatedImagesAfter = await snapshotGeneratedImages(tenant.codexHome, generatedImageThreadId);
        const newGeneratedImages = [...generatedImagesAfter]
          .filter(([fileName, fingerprint]) => baseline.get(fileName) !== fingerprint);
        for (const [index, [fileName]] of newGeneratedImages.entries()) {
          const source = resolveGeneratedImage(tenant.codexHome, generatedImageThreadId, fileName);
          const stat = await fs.promises.lstat(source);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const extension = path.extname(fileName).toLowerCase();
          const originalName = newGeneratedImages.length === 1 ? `AI生成图片${extension}` : `AI生成图片-${index + 1}${extension}`;
          const fileId = newId();
          const storedPath = path.posix.join("deliverables", fileId, originalName);
          const destination = resolveInside(this.config.dataRoot, storedPath);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          await fs.promises.copyFile(source, destination);
          this.db.addFile({
            id: fileId, conversation_id: conversationId, message_id: messageId,
            original_name: originalName, relative_path: storedPath,
            mime_type: guessMime(fileName), size: stat.size, kind: "output", created_at: createdAt,
          });
        }
      }
      this.db.finishJob(jobId, conversationId, "completed");
      this.publish(jobId, "done", { status: "completed" });
      if (shouldGenerateTitle) this.scheduleConversationTitle(conversationId, conversation.user_id, jobId, prompt, uploads.map((file) => file.original_name));
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const interrupted = !cancelled && error instanceof Error && (
        error.name === "TurnInterruptedError" || (executionObserved && isConnectionInterruptionError(error))
      );
      const message = cancelled ? "任务已停止" : interrupted
        ? "连接在本轮开始后中断。为避免重复执行命令或外部副作用，系统没有整轮重试；请确认现场状态后再继续。"
        : error instanceof Error ? redactBrandForDisplay(error.message) : "Agent 任务失败";
      try {
        this.db.finishJob(jobId, conversationId, cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", message);
      } catch {
        // Keep a single failed job from becoming an unhandled rejection that terminates the service.
      }
      try {
        this.publish(jobId, cancelled ? "done" : "failed", { status: cancelled ? "cancelled" : interrupted ? "interrupted" : "failed", message });
      } catch {
        // The database may already be unavailable; the service must stay alive for recovery and diagnostics.
      }
    } finally {
      this.abortControllers.delete(jobId);
      this.directExecutions.delete(jobId);
      if (runtimeRoot) cleanupJobRuntime(runtimeRoot);
    }
  }

  private scheduleConversationTitle(conversationId: string, userId: string, jobId: string, content: string, attachmentNames: string[]): void {
    if (this.titleRequests.has(conversationId)) return;
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.title_source !== "default") return;
    const latestAudit = this.db.getLatestConversationTitleAudit(conversationId);
    if (latestAudit?.status === "running" || latestAudit?.status === "succeeded") return;
    const requestText = extractTitleRequestText(content);
    const prompt = buildConversationTitlePrompt({ requestText, attachmentNames });
    if (!prompt) return;
    const auditId = newId();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    this.db.createConversationTitleAudit({
      id: auditId,
      conversation_id: conversationId,
      user_id: userId,
      model: CONVERSATION_TITLE_CODEX_MODEL,
      reasoning_effort: CONVERSATION_TITLE_REASONING_EFFORT,
      prompt_version: CONVERSATION_TITLE_PROMPT_VERSION,
      request_excerpt: Array.from(requestText).slice(0, 240).join(""),
      request_sha256: crypto.createHash("sha256").update(requestText, "utf8").digest("hex"),
      context_json: JSON.stringify({ attachmentNames: attachmentNames.slice(0, 20), requestCharacters: Array.from(requestText).length, execution: "tenant-local" }),
      started_at: startedAt,
    });
    const controller = new AbortController();
    const request = this.workerClient
      ? this.workerClient.generateConversationTitle(userId, prompt, CONVERSATION_TITLE_TIMEOUT_MS)
      : runCodexConversationTitle({ userId, prompt, timeoutMs: CONVERSATION_TITLE_TIMEOUT_MS }, { signal: controller.signal });
    const operation = request.then((output) => {
      const title = parseConversationTitleOutput(output);
      if (!title) throw new Error("invalid_output");
      const applied = this.db.setAiConversationTitleIfDefault(conversationId, title);
      this.db.finishConversationTitleAudit(auditId, {
        status: "succeeded", outputTitle: title, applied,
        completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
      });
      if (applied) this.publish(jobId, "conversation_title", { title });
    }).catch((error) => {
      try {
        this.db.finishConversationTitleAudit(auditId, {
          status: "failed",
          error: titleAuditError(error),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
        });
      } catch { /* Shutdown can close SQLite before a detached title request returns. */ }
    }).finally(() => this.titleRequests.delete(conversationId));
    this.titleRequests.set(conversationId, operation);
  }

  private attachmentContext(uploads: FileRow[], workspace: string): AgentAttachmentContext[] {
    return uploads.map((file) => ({
      name: file.original_name,
      mimeType: file.mime_type,
      path: normalizeStoredRelativePath(path.relative(workspace, resolveInside(workspace, file.relative_path))),
    }));
  }
}

export function redactBrandForDisplay(value: string): string {
  return value.replace(/chatgpt/gi, "Codex Web");
}

function titleAuditError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Codex title request failed";
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|token|cookie|secret|api[ _-]?key|authorization|密码|口令|私钥|验证码)\s*[=:：]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

export function summarizeEvent(event: ThreadEvent): unknown | null {
  if (event.type === "error") return isRetryableUpstreamError(event.message)
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
  if (item.type === "error") return isRetryableUpstreamError(item.message)
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
