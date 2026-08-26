import crypto from "node:crypto";
import net, { type Socket } from "node:net";
import readline from "node:readline";
import type { HostJobRuntimeTarget, HostProjectFsResult, HostRootClientMessage, HostRootRunRequest, HostRootServerMessage, HostRuntimeCleanupResult } from "./host-root-protocol.js";
import type { TenantWorkerEvent } from "./tenant-worker-protocol.js";
import type { ExecutorRuntimeStatus } from "./model-options.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";
import type { CodexAccountLoginView, CodexAccountView } from "./codex-account-manager.js";

type PendingJob = {
  socket: Socket;
  resolve(finalResponse: string): void;
  reject(error: Error): void;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onContextUsage(usage: ContextTokenUsage): void;
  onQuotaUsage(usage: CodexQuotaUsage): void;
  terminal: boolean;
};

export class HostRootWorkerClient {
  private readonly jobs = new Map<string, PendingJob>();
  private readonly steers = new Map<string, { jobId: string; resolve(turnId: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly socketPath: string) {}

  run(request: HostRootRunRequest, callbacks: Pick<PendingJob, "onThreadStarted" | "onProgress" | "onContextUsage" | "onQuotaUsage">): Promise<string> {
    if (this.jobs.has(request.jobId)) return Promise.reject(new Error("Host root job already exists"));
    return new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const pending: PendingJob = { socket, resolve, reject, ...callbacks, terminal: false };
      this.jobs.set(request.jobId, pending);
      const lines = this.readLines(socket);
      lines.on("line", (line) => this.handleLine(request.jobId, line));
      socket.once("connect", () => this.send(socket, { type: "run", request }));
      socket.once("error", (error) => this.failJob(request.jobId, error));
      socket.once("close", () => {
        lines.close();
        const active = this.jobs.get(request.jobId);
        if (active && !active.terminal) this.failJob(request.jobId, new Error("CODEX_WEB 宿主执行服务已断开"));
      });
    });
  }

  cancel(jobId: string): boolean {
    const pending = this.jobs.get(jobId);
    if (!pending || pending.socket.destroyed) return false;
    this.send(pending.socket, { type: "cancel" });
    return true;
  }

  steer(jobId: string, prompt: string, imageRelativePaths: string[] = []): Promise<string> {
    const pending = this.jobs.get(jobId);
    if (!pending || pending.socket.destroyed) return Promise.reject(new Error("当前任务已经结束"));
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.steers.delete(requestId);
        reject(new Error("宿主引导请求在 30 秒内未确认；为避免重复副作用，未自动重发"));
      }, 30_000);
      this.steers.set(requestId, { jobId, resolve, reject, timer });
      this.send(pending.socket, { type: "steer", requestId, prompt, imageRelativePaths });
    });
  }

  deleteThread(userId: string, threadId: string): Promise<number> {
    const requestId = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const lines = this.readLines(socket);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("CODEX_WEB 宿主会话删除请求超时")), 60_000);
      const finish = (error?: Error, removed?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        socket.end();
        if (error) reject(error);
        else resolve(removed ?? 0);
      };
      lines.on("line", (line) => {
        let message: HostRootServerMessage;
        try { message = JSON.parse(line) as HostRootServerMessage; }
        catch { return; }
        if (message.type === "delete_thread_result" && message.requestId === requestId) finish(undefined, message.removed);
        if (message.type === "request_failed" && (!message.requestId || message.requestId === requestId)) finish(new Error(message.message));
      });
      socket.once("connect", () => this.send(socket, { type: "delete_thread", requestId, userId, threadId }));
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("CODEX_WEB 宿主执行服务已断开")));
    });
  }

  threadRolloutBytes(userId: string, threadId: string): Promise<number | null> {
    const requestId = crypto.randomUUID();
    return this.singleRequest<number | null>(
      { type: "thread_rollout_size", requestId, userId, threadId },
      (message) => message.type === "thread_rollout_size_result" && message.requestId === requestId
        ? message.bytes
        : undefined,
      (message) => message.type === "thread_rollout_size_result" && message.requestId === requestId,
    );
  }

  restoreColdConversation(userId: string, conversationId: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    return this.singleRequest<boolean>(
      { type: "restore_cold_conversation", requestId, userId, conversationId },
      (message) => message.type === "restore_cold_conversation_result" && message.requestId === requestId ? message.restored : undefined,
      (message) => message.type === "restore_cold_conversation_result" && message.requestId === requestId,
      6 * 60 * 60_000,
    );
  }

  projectDirectories(userId: string, directory: string): Promise<HostProjectFsResult> {
    return this.projectFs(userId, "list", directory);
  }

  validateProjectDirectory(userId: string, directory: string): Promise<HostProjectFsResult> {
    return this.projectFs(userId, "validate", directory);
  }

  createProjectDirectory(userId: string, parent: string, name: string): Promise<HostProjectFsResult> {
    return this.projectFs(userId, "create", parent, name);
  }

  initializeProjectDirectory(userId: string, directory: string, content: string): Promise<HostProjectFsResult> {
    return this.projectFs(userId, "initialize", directory, undefined, content);
  }

  runtimeStatus(userId: string, checkLatest = true): Promise<ExecutorRuntimeStatus> {
    const requestId = crypto.randomUUID();
    return this.singleRequest<ExecutorRuntimeStatus>(
      { type: "runtime_status", requestId, userId, checkLatest },
      (message) => message.type === "runtime_status_result" && message.requestId === requestId
        ? {
          installedVersion: message.installedVersion, latestVersion: message.latestVersion,
          versionCheckedAt: message.versionCheckedAt, catalogUpdatedAt: message.catalogUpdatedAt,
          updateState: message.updateState, updateError: message.updateError, agentOptions: message.agentOptions,
        }
        : undefined,
      undefined,
      60_000,
    );
  }

  reviewVoiceLexicon(userId: string, prompt: string, timeoutMs: number): Promise<string> {
    const requestId = crypto.randomUUID();
    return this.singleRequest<string>(
      { type: "voice_review", requestId, request: { userId, prompt, timeoutMs } },
      (message) => message.type === "voice_review_result" && message.requestId === requestId ? message.output : undefined,
      undefined,
      timeoutMs + 15_000,
    );
  }

  generateConversationTitle(userId: string, prompt: string, timeoutMs: number): Promise<string> {
    const requestId = crypto.randomUUID();
    return this.singleRequest<string>(
      { type: "title_agent", requestId, request: { userId, prompt, timeoutMs } },
      (message) => message.type === "title_agent_result" && message.requestId === requestId ? message.output : undefined,
      undefined,
      timeoutMs + 15_000,
    );
  }

  cleanupJobRuntimes(userId: string, targets: HostJobRuntimeTarget[]): Promise<HostRuntimeCleanupResult> {
    if (targets.length === 0) return Promise.resolve({ removed: 0, absent: 0, failed: [] });
    const requestId = crypto.randomUUID();
    return this.singleRequest<HostRuntimeCleanupResult>(
      { type: "cleanup_runtimes", requestId, userId, targets },
      (message) => message.type === "cleanup_runtimes_result" && message.requestId === requestId
        ? { removed: message.removed, absent: message.absent, failed: message.failed }
        : undefined,
      undefined,
      120_000,
    );
  }

  upgradeCodex(userId: string, version: string): Promise<ExecutorRuntimeStatus> {
    const requestId = crypto.randomUUID();
    return this.singleRequest<ExecutorRuntimeStatus>(
      { type: "codex_upgrade", requestId, userId, version },
      (message) => message.type === "codex_upgrade_result" && message.requestId === requestId && message.accepted
        ? {
          installedVersion: message.installedVersion, latestVersion: message.latestVersion,
          versionCheckedAt: message.versionCheckedAt, catalogUpdatedAt: message.catalogUpdatedAt,
          updateState: message.updateState, updateError: message.updateError, agentOptions: message.agentOptions,
        }
        : undefined,
      undefined,
      45 * 60_000,
    );
  }

  listCodexAccounts(userId: string): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    const requestId = crypto.randomUUID();
    return this.singleRequest(
      { type: "codex_accounts_list", requestId, userId },
      (message) => message.type === "codex_accounts_result" && message.requestId === requestId
        ? { accounts: message.accounts, activeAccountId: message.activeAccountId }
        : undefined,
    );
  }

  beginCodexAccountLogin(userId: string, label: string): Promise<CodexAccountLoginView> {
    return this.codexAccountLoginRequest({ type: "codex_account_login_start", userId, label });
  }

  codexAccountLoginStatus(userId: string, loginId: string): Promise<CodexAccountLoginView> {
    return this.codexAccountLoginRequest({ type: "codex_account_login_status", userId, loginId });
  }

  cancelCodexAccountLogin(userId: string, loginId: string): Promise<CodexAccountLoginView> {
    return this.codexAccountLoginRequest({ type: "codex_account_login_cancel", userId, loginId });
  }

  activateCodexAccount(userId: string, accountId: string): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    return this.codexAccountsMutation({ type: "codex_account_activate", userId, accountId }, 90_000);
  }

  deleteCodexAccount(userId: string, accountId: string): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    return this.codexAccountsMutation({ type: "codex_account_delete", userId, accountId });
  }

  private codexAccountLoginRequest(message: {
    type: "codex_account_login_start"; userId: string; label: string;
  } | {
    type: "codex_account_login_status" | "codex_account_login_cancel"; userId: string; loginId: string;
  }): Promise<CodexAccountLoginView> {
    const requestId = crypto.randomUUID();
    return this.singleRequest(
      { ...message, requestId },
      (response) => response.type === "codex_account_login_result" && response.requestId === requestId ? response.login : undefined,
      undefined,
      30_000,
    );
  }

  private codexAccountsMutation(message: {
    type: "codex_account_activate" | "codex_account_delete";
    userId: string;
    accountId: string;
  }, timeoutMs = 30_000): Promise<{ accounts: CodexAccountView[]; activeAccountId: string }> {
    const requestId = crypto.randomUUID();
    return this.singleRequest(
      { ...message, requestId },
      (response) => response.type === "codex_accounts_result" && response.requestId === requestId
        ? { accounts: response.accounts, activeAccountId: response.activeAccountId }
        : undefined,
      undefined,
      timeoutMs,
    );
  }

  private singleRequest<T>(message: HostRootClientMessage, pick: (message: HostRootServerMessage) => T | undefined, matches?: (message: HostRootServerMessage) => boolean, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const lines = this.readLines(socket);
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`CODEX_WEB 宿主 RPC 在 ${Math.ceil(timeoutMs / 1000)} 秒内未完成`)), timeoutMs);
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true; lines.close(); socket.end();
        clearTimeout(timer);
        if (error) reject(error); else resolve(value as T);
      };
      lines.on("line", (line) => {
        let response: HostRootServerMessage;
        try { response = JSON.parse(line) as HostRootServerMessage; } catch { return; }
        if (response.type === "request_failed" && (!("requestId" in message) || !response.requestId || response.requestId === message.requestId)) finish(new Error(response.message));
        else if (matches?.(response)) finish(undefined, pick(response));
        else { const value = pick(response); if (value !== undefined) finish(undefined, value); }
      });
      socket.once("connect", () => this.send(socket, message));
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("CODEX_WEB 宿主执行服务已断开")));
    });
  }

  private projectFs(userId: string, action: "list" | "create" | "validate" | "initialize", directory: string, name?: string, content?: string): Promise<HostProjectFsResult> {
    const requestId = crypto.randomUUID();
    return new Promise<HostProjectFsResult>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const lines = this.readLines(socket);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("CODEX_WEB 宿主文件系统请求超时")), 30_000);
      const finish = (error?: Error, result?: HostProjectFsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        socket.end();
        if (error) reject(error);
        else if (result) resolve(result);
      };
      lines.on("line", (line) => {
        let message: HostRootServerMessage;
        try { message = JSON.parse(line) as HostRootServerMessage; }
        catch { return; }
        if (message.type === "project_fs_result" && message.requestId === requestId) {
          finish(undefined, { directory: message.directory, parent: message.parent, directories: message.directories });
        }
        if (message.type === "request_failed" && (!message.requestId || message.requestId === requestId)) finish(new Error(message.message));
      });
      socket.once("connect", () => this.send(socket, { type: "project_fs", requestId, userId, action, path: directory, name, content }));
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("CODEX_WEB 宿主执行服务已断开")));
    });
  }

  private handleLine(jobId: string, line: string): void {
    let message: HostRootServerMessage;
    try { message = JSON.parse(line) as HostRootServerMessage; }
    catch { return; }
    const pending = this.jobs.get(jobId);
    if (!pending) return;
    if (message.type === "request_failed") {
      this.failJob(jobId, new Error(message.message));
      return;
    }
    if (message.type !== "event" || message.jobId !== jobId) return;
    this.handleEvent(jobId, pending, message.event);
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
      pending.terminal = true;
      this.jobs.delete(jobId);
      this.rejectSteers(jobId, "当前任务已经结束");
      pending.socket.end();
      pending.resolve(event.finalResponse);
    }
    if (event.type === "failed") {
      const error = new Error(event.message);
      if (event.cancelled) error.name = "AbortError";
      this.failJob(jobId, error);
    }
  }

  private failJob(jobId: string, error: Error): void {
    const pending = this.jobs.get(jobId);
    if (!pending) return;
    pending.terminal = true;
    this.jobs.delete(jobId);
    this.rejectSteers(jobId, error.message);
    pending.socket.destroy();
    pending.reject(error);
  }

  private rejectSteers(jobId: string, message: string): void {
    for (const [requestId, steer] of this.steers) {
      if (steer.jobId !== jobId) continue;
      clearTimeout(steer.timer);
      this.steers.delete(requestId);
      steer.reject(new Error(message));
    }
  }

  private readLines(socket: Socket) {
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    // readline re-emits input stream errors on the Interface. The socket-level
    // handlers reject the affected request; this listener keeps one failed
    // bridge connection from becoming an uncaught process-level error.
    lines.on("error", () => undefined);
    return lines;
  }

  private send(socket: Socket, message: HostRootClientMessage): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }
}
