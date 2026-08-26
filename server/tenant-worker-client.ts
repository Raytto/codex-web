import crypto from "node:crypto";
import type { SupervisorToWebMessage, TenantWorkerEvent, TenantWorkerRunRequest, WebToSupervisorMessage } from "./tenant-worker-protocol.js";
import type { JobRuntimeCleanupTarget } from "./python-runtime.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";

type PendingJob = {
  resolve(finalResponse: string): void;
  reject(error: Error): void;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onContextUsage(usage: ContextTokenUsage): void;
  onQuotaUsage(usage: CodexQuotaUsage): void;
};

export class TenantWorkerClient {
  private readonly jobs = new Map<string, PendingJob>();
  private readonly steers = new Map<string, { jobId: string; resolve(turnId: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly cleanupRequests = new Map<string, {
    resolve(value: { removed: number; absent: number; failed: Array<{ jobId: string; message: string }> }): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly voiceReviews = new Map<string, {
    resolve(output: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly titleAgents = new Map<string, {
    resolve(output: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor() {
    process.on("message", (message: SupervisorToWebMessage) => this.handleMessage(message));
    process.on("disconnect", () => {
      for (const job of this.jobs.values()) job.reject(new Error("Tenant worker supervisor disconnected"));
      this.jobs.clear();
      for (const steer of this.steers.values()) { clearTimeout(steer.timer); steer.reject(new Error("Tenant worker supervisor disconnected")); }
      this.steers.clear();
      for (const cleanup of this.cleanupRequests.values()) { clearTimeout(cleanup.timer); cleanup.reject(new Error("Tenant worker supervisor disconnected")); }
      this.cleanupRequests.clear();
      for (const review of this.voiceReviews.values()) { clearTimeout(review.timer); review.reject(new Error("Tenant worker supervisor disconnected")); }
      this.voiceReviews.clear();
      for (const request of this.titleAgents.values()) { clearTimeout(request.timer); request.reject(new Error("Tenant worker supervisor disconnected")); }
      this.titleAgents.clear();
    });
  }

  generateConversationTitle(userId: string, prompt: string, timeoutMs: number): Promise<string> {
    if (!process.send || !process.connected) return Promise.reject(new Error("Tenant worker isolation is unavailable"));
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.titleAgents.delete(requestId);
        reject(new Error(`Codex title request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
      }, timeoutMs + 15_000);
      this.titleAgents.set(requestId, { resolve, reject, timer });
      process.send!({ kind: "tenant_title_agent", requestId, request: { userId, prompt, timeoutMs } } satisfies WebToSupervisorMessage, (error) => {
        if (!error) return;
        clearTimeout(timer); this.titleAgents.delete(requestId); reject(error);
      });
    });
  }

  reviewVoiceLexicon(userId: string, prompt: string, timeoutMs: number): Promise<string> {
    if (!process.send || !process.connected) return Promise.reject(new Error("Tenant worker isolation is unavailable"));
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.voiceReviews.delete(requestId);
        reject(new Error(`Codex voice review timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
      }, timeoutMs + 15_000);
      this.voiceReviews.set(requestId, { resolve, reject, timer });
      const message: WebToSupervisorMessage = {
        kind: "tenant_voice_review",
        requestId,
        request: { userId, prompt, timeoutMs },
      };
      process.send!(message, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.voiceReviews.delete(requestId);
        reject(error);
      });
    });
  }

  cleanupJobRuntimes(targets: JobRuntimeCleanupTarget[]): Promise<{
    removed: number;
    absent: number;
    failed: Array<{ jobId: string; message: string }>;
  }> {
    if (targets.length === 0) return Promise.resolve({ removed: 0, absent: 0, failed: [] });
    if (!process.send || !process.connected) return Promise.reject(new Error("Tenant worker isolation is unavailable"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cleanupRequests.delete(requestId);
        reject(new Error("Tenant runtime cleanup timed out after 120 seconds"));
      }, 120_000);
      this.cleanupRequests.set(requestId, { resolve, reject, timer });
      const message: WebToSupervisorMessage = { kind: "tenant_runtime_cleanup", requestId, targets };
      process.send!(message, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.cleanupRequests.delete(requestId);
        reject(error);
      });
    });
  }

  run(
    request: TenantWorkerRunRequest,
    callbacks: Pick<PendingJob, "onThreadStarted" | "onProgress" | "onContextUsage" | "onQuotaUsage">,
  ): Promise<string> {
    if (!process.send || !process.connected) return Promise.reject(new Error("Tenant worker isolation is unavailable"));
    if (this.jobs.has(request.jobId)) return Promise.reject(new Error("Tenant worker job already exists"));
    return new Promise<string>((resolve, reject) => {
      this.jobs.set(request.jobId, { ...callbacks, resolve, reject });
      const message: WebToSupervisorMessage = { kind: "tenant_run", jobId: request.jobId, userId: request.userId, request };
      process.send!(message, (error) => {
        if (!error) return;
        this.jobs.delete(request.jobId);
        reject(error);
      });
    });
  }

  cancel(jobId: string): boolean {
    if (!this.jobs.has(jobId) || !process.send || !process.connected) return false;
    const message: WebToSupervisorMessage = { kind: "tenant_cancel", jobId };
    process.send(message);
    return true;
  }

  steer(jobId: string, prompt: string, imagePaths: string[] = []): Promise<string> {
    if (!this.jobs.has(jobId) || !process.send || !process.connected) return Promise.reject(new Error("当前任务已经结束"));
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.steers.delete(requestId);
        reject(new Error("引导请求在 30 秒内未确认；为避免重复副作用，未自动重发"));
      }, 30_000);
      this.steers.set(requestId, { jobId, resolve, reject, timer });
      const message: WebToSupervisorMessage = { kind: "tenant_steer", jobId, requestId, prompt, imagePaths };
      process.send!(message, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.steers.delete(requestId);
        reject(error);
      });
    });
  }

  private handleMessage(message: SupervisorToWebMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.kind === "tenant_title_agent_result") {
      const pending = this.titleAgents.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.titleAgents.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error));
      else if (typeof message.output === "string") pending.resolve(message.output);
      else pending.reject(new Error("Codex title request returned no output"));
      return;
    }
    if (message.kind === "tenant_voice_review_result") {
      const pending = this.voiceReviews.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.voiceReviews.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error));
      else if (typeof message.output === "string") pending.resolve(message.output);
      else pending.reject(new Error("Codex voice review returned no output"));
      return;
    }
    if (message.kind === "tenant_runtime_cleanup_result") {
      const pendingCleanup = this.cleanupRequests.get(message.requestId);
      if (!pendingCleanup) return;
      clearTimeout(pendingCleanup.timer);
      this.cleanupRequests.delete(message.requestId);
      pendingCleanup.resolve({ removed: message.removed, absent: message.absent, failed: message.failed });
      return;
    }
    if (!("jobId" in message)) return;
    const pending = this.jobs.get(message.jobId);
    if (!pending) return;
    if (message.kind === "tenant_worker_exit") {
      this.jobs.delete(message.jobId);
      for (const [requestId, steer] of this.steers) {
        if (steer.jobId !== message.jobId) continue;
        clearTimeout(steer.timer);
        this.steers.delete(requestId);
        steer.reject(new Error(message.message));
      }
      pending.reject(new Error(message.message));
      return;
    }
    if (message.kind !== "tenant_event") return;
    this.handleEvent(message.jobId, pending, message.event);
  }

  private handleEvent(jobId: string, pending: PendingJob, event: TenantWorkerEvent): void {
    if (event.type === "thread_started") pending.onThreadStarted(event.threadId);
    if (event.type === "context_usage") pending.onContextUsage(event.usage);
    if (event.type === "quota_usage") pending.onQuotaUsage(event.usage);
    if (event.type === "progress") pending.onProgress(event.payload);
    if (event.type === "steer_completed" || event.type === "steer_failed") {
      const steer = this.steers.get(event.requestId);
      if (!steer) return;
      clearTimeout(steer.timer);
      this.steers.delete(event.requestId);
      if (event.type === "steer_completed") steer.resolve(event.turnId);
      else steer.reject(new Error(event.message));
      return;
    }
    if (event.type === "completed") {
      this.jobs.delete(jobId);
      this.rejectSteersForJob(jobId, "当前任务已经结束");
      pending.resolve(event.finalResponse);
    }
    if (event.type === "failed") {
      this.jobs.delete(jobId);
      this.rejectSteersForJob(jobId, event.message);
      const error = new Error(event.message);
      if (event.cancelled) error.name = "AbortError";
      pending.reject(error);
    }
  }

  private rejectSteersForJob(jobId: string, message: string): void {
    for (const [requestId, steer] of this.steers) {
      if (steer.jobId !== jobId) continue;
      clearTimeout(steer.timer);
      this.steers.delete(requestId);
      steer.reject(new Error(message));
    }
  }
}
