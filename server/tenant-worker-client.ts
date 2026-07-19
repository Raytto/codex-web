import crypto from "node:crypto";
import type { SupervisorToWebMessage, TenantWorkerEvent, TenantWorkerRunRequest, WebToSupervisorMessage } from "./tenant-worker-protocol.js";

type PendingJob = {
  resolve(finalResponse: string): void;
  reject(error: Error): void;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
};

export class TenantWorkerClient {
  private readonly jobs = new Map<string, PendingJob>();
  private readonly steers = new Map<string, { jobId: string; resolve(turnId: string): void; reject(error: Error): void }>();

  constructor() {
    process.on("message", (message: SupervisorToWebMessage) => this.handleMessage(message));
    process.on("disconnect", () => {
      for (const job of this.jobs.values()) job.reject(new Error("Tenant worker supervisor disconnected"));
      this.jobs.clear();
      for (const steer of this.steers.values()) steer.reject(new Error("Tenant worker supervisor disconnected"));
      this.steers.clear();
    });
  }

  run(
    request: TenantWorkerRunRequest,
    callbacks: Pick<PendingJob, "onThreadStarted" | "onProgress">,
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
      this.steers.set(requestId, { jobId, resolve, reject });
      const message: WebToSupervisorMessage = { kind: "tenant_steer", jobId, requestId, prompt, imagePaths };
      process.send!(message, (error) => {
        if (!error) return;
        this.steers.delete(requestId);
        reject(error);
      });
    });
  }

  private handleMessage(message: SupervisorToWebMessage): void {
    if (!message || typeof message !== "object" || !("jobId" in message)) return;
    const pending = this.jobs.get(message.jobId);
    if (!pending) return;
    if (message.kind === "tenant_worker_exit") {
      this.jobs.delete(message.jobId);
      for (const [requestId, steer] of this.steers) {
        if (steer.jobId !== message.jobId) continue;
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
    if (event.type === "progress") pending.onProgress(event.payload);
    if (event.type === "steer_completed" || event.type === "steer_failed") {
      const steer = this.steers.get(event.requestId);
      if (!steer) return;
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
      this.steers.delete(requestId);
      steer.reject(new Error(message));
    }
  }
}
