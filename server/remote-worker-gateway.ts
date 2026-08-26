import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AppConfig } from "./config.js";
import { AppDatabase, type FileRow, type RemoteWorkerRow } from "./db.js";
import type { TenantWorkerEvent } from "./tenant-worker-protocol.js";
import type { CodexAccountLoginView } from "./codex-account-manager.js";
import type { ExecutorRuntimeStatus } from "./model-options.js";
import {
  HOST_EXECUTOR_ID,
  REMOTE_WORKER_PROTOCOL_VERSION,
  remoteExecutorId,
  workerIdFromExecutor,
  type RemoteArtifact,
  type RemoteFetchedArtifact,
  type RemoteProjectFsResult,
  type RemoteRunRequest,
  type RemoteThreadSnapshot,
  type RemoteThreadSyncPage,
  type RemoteCodexAccountsState,
  type RemoteWorkerToServer,
  type ServerToRemoteWorker,
} from "./remote-worker-protocol.js";
import { loadRemoteWorkerReleaseManifest, REMOTE_WORKER_TARGET_REF, REMOTE_WORKER_TARGET_VERSION, type RemoteWorkerReleaseManifest, type RemoteWorkerReleaseArchive } from "./remote-worker-release.js";
import type { CodexQuotaUsage, ContextTokenUsage } from "./app-server-turn.js";
import { isValidRemoteWorkerCapacity, normalizeRemoteWorkerCapacity, remoteWorkerHasCapacity } from "./remote-worker-capacity.js";
import { REMOTE_TRANSFER_MAX_FILE_BYTES, RemoteTransferError } from "./remote-transfer.js";
import { cleanupOwnedStagingDirectory, ownedStagingDirectory, sweepOwnedStagingDirectories } from "./owned-staging.js";
import { parseRemoteWorkerMessage, REMOTE_WORKER_MAX_MESSAGE_BYTES, REMOTE_WORKER_MAX_PROTOCOL_ERRORS } from "./remote-worker-message.js";
import { ensureTenantWorkspace, resolveInside } from "./paths.js";
import type { RemoteWorkerBootstrapPlatform } from "./remote-worker-bootstrap.js";

const REMOTE_TRANSFER_MAX_FILES_PER_JOB = 32;
const REMOTE_TRANSFER_MAX_ACTIVE_PER_JOB = 4;
const REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB = 512 * 1024 * 1024;
const REMOTE_THREAD_SYNC_TIMEOUT_MAX_MS = 5 * 60_000;
export const REMOTE_WORKER_UPDATE_TIMEOUT_MS = 15 * 60_000;
const REMOTE_WORKER_AUTO_RETRY_COOLDOWN_MS = 60_000;
const REMOTE_WORKER_BOOTSTRAP_TTL_MS = 30 * 60_000;

export function remoteThreadSyncTimeoutMs(): number {
  return REMOTE_THREAD_SYNC_TIMEOUT_MAX_MS;
}

type Connection = { socket: WebSocket; workerId: string; capacity: number; lastHeartbeat: number; activeJobs: Set<string>; heartbeatSeen: boolean; waitAutomation: boolean; capacityConfig: boolean; dynamicWaitTool: boolean; agentTurnContext: boolean; accountSkills: boolean; titleAgent: boolean; codexAccounts: boolean; accountSwitching: boolean };
type BootstrapGrant = { platform: RemoteWorkerBootstrapPlatform; expiresAt: number };
type PendingFs = { workerId: string; resolve(value: RemoteProjectFsResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingRename = { workerId: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingThreadSync = { workerId: string; resolve(value: RemoteThreadSyncPage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingRuntime = { workerId: string; resolve(value: ExecutorRuntimeStatus): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingUpgrade = { workerId: string; resolve(value: ExecutorRuntimeStatus): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingWorkerConfig = { workerId: string; capacity: number; resolve(value: ExecutorView): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingTitleAgent = { workerId: string; resolve(output: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingCodexAccounts = { workerId: string; action: string; resolve(value: { state?: RemoteCodexAccountsState; login?: CodexAccountLoginView; restart?: boolean }): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PendingFileFetch = {
  workerId: string;
  transferToken: string;
  sourcePath: string;
  artifact?: StoredFetchedArtifact;
  upload?: RemoteUploadReservation;
  resolve(value: StoredFetchedArtifact): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export type StoredArtifact = RemoteArtifact & { tempPath: string; sha256: string };
export type StoredFetchedArtifact = RemoteFetchedArtifact & { tempPath: string; sha256: string };
export type RemoteUploadReservation = {
  id: string;
  kind: "job" | "fetch";
  ownerId: string;
  expectedSize: number;
  name: string;
  mimeType: string;
  temporaryPath: string;
  finalPath: string;
};
type PendingJob = {
  workerId: string;
  transferToken: string;
  observedActive: boolean;
  inputFiles: Map<string, { row: FileRow; absolutePath: string }>;
  artifacts: Map<string, StoredArtifact>;
  activeUploads: Map<string, RemoteUploadReservation>;
  uploadedBytes: number;
  resolve(value: { finalResponse: string; artifacts: StoredArtifact[]; omittedArtifacts: NonNullable<Extract<TenantWorkerEvent, { type: "completed" }>["omittedArtifacts"]> }): void;
  reject(error: Error): void;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onContextUsage(usage: ContextTokenUsage): void;
  onQuotaUsage(usage: CodexQuotaUsage): void;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

type PersistedRemoteJob = {
  version: 1;
  jobId: string;
  workerId: string;
  transferToken: string;
  inputFileIds: string[];
  artifacts: StoredArtifact[];
  uploadedBytes: number;
  terminalEvent?: Extract<TenantWorkerEvent, { type: "completed" | "failed" }>;
};

export type ExecutorView = {
  id: string;
  machineName: string;
  kind: "host_root" | "remote_worker" | "tenant_container";
  status: "online" | "offline" | "disabled";
  platform: string;
  capacity: number;
  activeJobs: number;
  lastSeenAt: string | null;
  runtime: ExecutorRuntimeStatus | null;
  securityBoundary: {
    mode: "danger_full_access" | "workspace_write";
    label: string;
    description: string;
  };
  retryCapability: {
    transparentBeforeStart: true;
    replayAfterStart: false;
    idempotencyReceipts: false;
  };
  codexAccountManagementCapable: boolean;
  worker: {
    installedVersion: string;
    installedRef: string | null;
    installedCommit: string | null;
    updaterCapable: boolean;
    capacityConfigurable: boolean;
    targetVersion: string;
    targetRef: string;
    update: {
      requestId: string;
      state: "queued" | "dispatching" | "updating" | "succeeded" | "failed";
      requestedAt: string;
      dispatchedAt: string | null;
      completedAt: string | null;
      error: string | null;
    } | null;
  } | null;
};

export class RemoteWorkerGateway extends EventEmitter {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: REMOTE_WORKER_MAX_MESSAGE_BYTES });
  private readonly connections = new Map<string, Connection>();
  private readonly pendingFs = new Map<string, PendingFs>();
  private readonly pendingRenames = new Map<string, PendingRename>();
  private readonly pendingThreadSyncs = new Map<string, PendingThreadSync>();
  private readonly pendingRuntimes = new Map<string, PendingRuntime>();
  private readonly pendingUpgrades = new Map<string, PendingUpgrade>();
  private readonly pendingWorkerConfigs = new Map<string, PendingWorkerConfig>();
  private readonly pendingTitleAgents = new Map<string, PendingTitleAgent>();
  private readonly pendingCodexAccounts = new Map<string, PendingCodexAccounts>();
  private readonly pendingFileFetches = new Map<string, PendingFileFetch>();
  private readonly pendingSteers = new Map<string, { jobId: string; workerId: string; resolve(turnId: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly bootstrapGrants = new Map<string, BootstrapGrant>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private closing = false;
  private readonly targetRelease: RemoteWorkerReleaseManifest | null;

  constructor(private readonly config: AppConfig, private readonly db: AppDatabase) {
    super();
    this.targetRelease = loadRemoteWorkerReleaseManifest(config.remoteWorkerReleaseRoot);
    // Remote Worker support is optional. A clone without a release package or
    // enrollment token still serves local projects; pairing endpoints remain
    // unavailable until the operator supplies both pieces.
    if (config.containerized && config.remoteWorkerEnrollmentToken && !this.targetRelease) {
      throw new Error("Remote Worker release package is missing from the production image");
    }
    for (const worker of db.listRemoteWorkers()) db.markRemoteWorkerOffline(worker.id);
    for (const worker of db.listRemoteWorkers()) this.maybeQueueAutomaticWorkerUpdate(worker.id);
    sweepOwnedStagingDirectories(config.dataRoot, "remote-worker-staging", (jobId) => {
      const job = db.getJob(jobId);
      return Boolean(job && ["queued", "running"].includes(job.status));
    });
    sweepOwnedStagingDirectories(config.dataRoot, "remote-worker-fetch-staging", () => false);
    this.server.on("connection", (socket) => this.handleConnection(socket));
  }

  attach(httpServer: http.Server): void {
    httpServer.on("upgrade", (request, socket, head) => {
      let pathname = "";
      try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; }
      catch { socket.destroy(); return; }
      if (pathname !== "/api/remote-workers/connect") { socket.destroy(); return; }
      this.server.handleUpgrade(request, socket, head, (ws) => this.server.emit("connection", ws, request));
    });
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 15_000);
    this.heartbeatTimer.unref();
  }

  close(): void {
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const connection of this.connections.values()) connection.socket.close(1001, "server shutdown");
    for (const [requestId, pending] of this.pendingFileFetches) {
      clearTimeout(pending.timer);
      this.pendingFileFetches.delete(requestId);
      if (pending.artifact) this.removeStagedArtifact(pending.artifact);
      pending.reject(new Error("服务正在停止"));
    }
    for (const [requestId, pending] of this.pendingWorkerConfigs) {
      clearTimeout(pending.timer);
      this.pendingWorkerConfigs.delete(requestId);
      pending.reject(new Error("服务正在停止"));
    }
    for (const [requestId, pending] of this.pendingTitleAgents) {
      clearTimeout(pending.timer); this.pendingTitleAgents.delete(requestId); pending.reject(new Error("服务正在停止"));
    }
    for (const [requestId, pending] of this.pendingCodexAccounts) {
      clearTimeout(pending.timer); this.pendingCodexAccounts.delete(requestId); pending.reject(new Error("服务正在停止"));
    }
    this.server.close();
  }

  releaseManifest(): RemoteWorkerReleaseManifest | null {
    return this.targetRelease;
  }

  createBootstrapGrant(platform: RemoteWorkerBootstrapPlatform): { token: string; expiresAt: string } {
    if (!this.config.remoteWorkerEnrollmentToken) throw new Error("服务器尚未配置远程 Worker 配对凭据");
    if (!this.targetRelease?.platforms?.[platform]) throw new Error("当前发布包暂不支持该系统");
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + REMOTE_WORKER_BOOTSTRAP_TTL_MS;
    this.bootstrapGrants.set(token, { platform, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  exchangeBootstrapGrant(token: string, platform: RemoteWorkerBootstrapPlatform): { enrollmentToken: string; archive: RemoteWorkerReleaseArchive; version: string } {
    const grant = this.bootstrapGrants.get(token);
    if (!grant || grant.platform !== platform || grant.expiresAt < Date.now()) {
      this.bootstrapGrants.delete(token);
      throw new Error("Worker 安装链接已过期，请回网页重新生成");
    }
    this.bootstrapGrants.delete(token);
    const release = this.targetRelease;
    const archive = release?.platforms?.[platform];
    if (!release || !archive || !this.config.remoteWorkerEnrollmentToken) throw new Error("当前 Worker 发布包不可用");
    return { enrollmentToken: this.config.remoteWorkerEnrollmentToken, archive, version: release.version };
  }

  bootstrapGrantValid(token: string, platform: RemoteWorkerBootstrapPlatform): boolean {
    const grant = this.bootstrapGrants.get(token);
    if (!grant || grant.platform !== platform || grant.expiresAt < Date.now()) {
      this.bootstrapGrants.delete(token);
      return false;
    }
    return true;
  }

  authorizeReleaseDownload(authorization: string | undefined): boolean {
    const match = /^Bearer ([^\s]+)$/.exec(String(authorization ?? ""));
    return Boolean(match && this.config.remoteWorkerEnrollmentToken
      && safeEqual(this.config.remoteWorkerEnrollmentToken, match[1]));
  }

  listExecutors(): ExecutorView[] {
    const remote = this.db.listRemoteWorkers().map((worker) => this.workerView(worker));
    return [{
      id: HOST_EXECUTOR_ID,
      machineName: "CODEX_WEB服务器",
      kind: "host_root",
      status: "online",
      platform: "linux",
      capacity: 0,
      activeJobs: this.db.countRunningJobsForExecutor(HOST_EXECUTOR_ID),
      lastSeenAt: null,
      runtime: this.db.getExecutorRuntime(HOST_EXECUTOR_ID) ?? null,
      securityBoundary: {
        mode: "danger_full_access",
        label: "宿主 root 高权限（非隔离）",
        description: "命令可修改 CODEX_WEB 服务器；本轮开始后不允许透明整轮重放。",
      },
      retryCapability: { transparentBeforeStart: true, replayAfterStart: false, idempotencyReceipts: false },
      codexAccountManagementCapable: true,
      worker: null,
    }, ...remote];
  }

  executor(executorId: string): ExecutorView | undefined {
    if (executorId === HOST_EXECUTOR_ID) return this.listExecutors()[0];
    const workerId = workerIdFromExecutor(executorId);
    const worker = workerId ? this.db.getRemoteWorker(workerId) : undefined;
    return worker ? this.workerView(worker) : undefined;
  }

  refreshProjectWatches(executorId: string): void {
    const workerId = workerIdFromExecutor(executorId);
    const connection = workerId ? this.connections.get(workerId) : undefined;
    const worker = workerId ? this.db.getRemoteWorker(workerId) : undefined;
    if (!workerId || !connection || !worker || worker.protocol_version < 5) return;
    this.send(connection.socket, {
      type: "project_watch",
      projects: this.db.listActiveProjectsForExecutor(executorId).map((project) => ({ id: project.id, rootPath: project.root_path })),
    });
  }

  canRun(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return true;
    const connection = this.connections.get(workerId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || !connection.heartbeatSeen || connection.accountSwitching) return false;
    const update = this.db.getRemoteWorkerUpdate(workerId);
    if (update && ["queued", "dispatching", "updating"].includes(update.state)) return false;
    const active = this.activeJobCount(workerId, connection);
    return remoteWorkerHasCapacity(active, connection.capacity);
  }

  supportsWaitAutomation(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return true;
    const connection = this.connections.get(workerId);
    return Boolean(connection?.waitAutomation && connection.socket.readyState === WebSocket.OPEN);
  }

  supportsTitleAgent(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return true;
    const connection = this.connections.get(workerId);
    return Boolean(connection?.titleAgent && connection.socket.readyState === WebSocket.OPEN);
  }

  supportsDynamicWaitTool(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return true;
    const connection = this.connections.get(workerId);
    return Boolean(connection?.dynamicWaitTool && connection.socket.readyState === WebSocket.OPEN);
  }

  supportsAgentTurnContext(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return true;
    const connection = this.connections.get(workerId);
    return Boolean(connection?.agentTurnContext && connection.socket.readyState === WebSocket.OPEN);
  }

  supportsAccountSkills(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return true;
    const connection = this.connections.get(workerId);
    return Boolean(connection?.accountSkills && connection.socket.readyState === WebSocket.OPEN);
  }

  supportsCodexAccounts(executorId: string): boolean {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return executorId === HOST_EXECUTOR_ID;
    const connection = this.connections.get(workerId);
    return Boolean(connection?.codexAccounts && connection.socket.readyState === WebSocket.OPEN);
  }

  listCodexAccounts(executorId: string): Promise<RemoteCodexAccountsState> {
    return this.codexAccountsRequest(executorId, "list", {}).then((result) => {
      if (!result.state) throw new Error("远程 Worker 未返回 Codex 账号列表");
      return result.state;
    });
  }

  beginCodexAccountLogin(executorId: string, label: string) {
    return this.codexAccountsRequest(executorId, "login_start", { label }).then((result) => {
      if (!result.login) throw new Error("远程 Worker 未返回登录状态");
      return result.login;
    });
  }

  codexAccountLoginStatus(executorId: string, loginId: string) {
    return this.codexAccountsRequest(executorId, "login_status", { loginId }).then((result) => {
      if (!result.login) throw new Error("远程 Worker 未返回登录状态");
      return result.login;
    });
  }

  cancelCodexAccountLogin(executorId: string, loginId: string) {
    return this.codexAccountsRequest(executorId, "login_cancel", { loginId }).then((result) => {
      if (!result.login) throw new Error("远程 Worker 未返回登录状态");
      return result.login;
    });
  }

  activateCodexAccount(executorId: string, accountId: string): Promise<RemoteCodexAccountsState> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行机器无效"));
    const connection = this.connection(workerId);
    if (connection.activeJobs.size > 0 || this.activeJobCount(workerId, connection) > 0
      || this.db.countRunningJobsForExecutor(executorId) > 0 || this.db.countRunningCodexThreadsForExecutor(executorId) > 0) {
      return Promise.reject(new Error("目标机器仍有 Codex 任务执行，暂不能切换账号。"));
    }
    connection.accountSwitching = true;
    return this.codexAccountsRequest(executorId, "activate", { accountId }).then((result) => {
      if (!result.state) throw new Error("远程 Worker 未确认 Codex 账号切换");
      if (!result.restart) connection.accountSwitching = false;
      return result.state;
    }, (error) => {
      const current = this.connections.get(workerId);
      if (current === connection) current.accountSwitching = false;
      throw error;
    });
  }

  deleteCodexAccount(executorId: string, accountId: string): Promise<RemoteCodexAccountsState> {
    return this.codexAccountsRequest(executorId, "delete", { accountId }).then((result) => {
      if (!result.state) throw new Error("远程 Worker 未返回 Codex 账号列表");
      return result.state;
    });
  }

  private codexAccountsRequest(executorId: string, action: "list" | "login_start" | "login_status" | "login_cancel" | "activate" | "delete", fields: { label?: string; loginId?: string; accountId?: string }): Promise<{ state?: RemoteCodexAccountsState; login?: CodexAccountLoginView; restart?: boolean }> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行机器无效"));
    const connection = this.connection(workerId);
    if (!connection.codexAccounts) return Promise.reject(new Error("该节点需要先升级 Worker，才能管理 Codex 账号。"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingCodexAccounts.delete(requestId); reject(new Error("远程 Codex 账号请求超时")); }, 30_000);
      this.pendingCodexAccounts.set(requestId, { workerId, action, resolve, reject, timer });
      this.send(connection.socket, { type: "codex_accounts", requestId, action, ...fields });
    });
  }

  requestWorkerUpdate(executorId: string): { accepted: boolean; executor: ExecutorView } {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) throw new Error("只有远程 Worker 节点可以执行此升级");
    const worker = this.db.getRemoteWorker(workerId);
    if (!worker) throw new Error("远程 Worker 不存在");
    if (!worker.worker_update_capable) throw new Error("该节点尚未安装远程更新能力，需要在节点上完成最后一次手动引导更新");
    const current = this.db.getRemoteWorkerUpdate(workerId);
    if (worker.worker_version === REMOTE_WORKER_TARGET_VERSION && worker.worker_release === REMOTE_WORKER_TARGET_REF
      && (!this.targetRelease || worker.worker_commit === this.targetRelease.commit)) {
      return { accepted: false, executor: this.workerView(worker) };
    }
    if (current && ["queued", "dispatching", "updating"].includes(current.state)) {
      return { accepted: false, executor: this.workerView(worker) };
    }
    this.db.requestRemoteWorkerUpdate(workerId, crypto.randomUUID(), REMOTE_WORKER_TARGET_VERSION, REMOTE_WORKER_TARGET_REF);
    this.emit("status", workerId);
    this.maybeDispatchWorkerUpdate(workerId);
    return { accepted: true, executor: this.workerView(worker) };
  }

  setCapacity(executorId: string, capacity: number): Promise<ExecutorView> {
    if (!isValidRemoteWorkerCapacity(capacity)) throw new Error("Worker 并发容量必须是 0 到 8 的整数；0 表示不限并发");
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) throw new Error("只有远程 Worker 节点可以配置并发容量");
    const connection = this.connection(workerId);
    if (!connection.capacityConfig) throw new Error("该节点需要先升级 Worker，才能由服务器安全修改并发容量");
    const requestId = crypto.randomUUID();
    return new Promise<ExecutorView>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkerConfigs.delete(requestId);
        reject(new Error("远程 Worker 容量配置超时"));
      }, 15_000);
      this.pendingWorkerConfigs.set(requestId, { workerId, capacity, resolve, reject, timer });
      this.send(connection.socket, { type: "worker_config", requestId, capacity });
    });
  }

  async projectFs(executorId: string, action: "list" | "create" | "validate" | "initialize", directory: string, name?: string, content?: string): Promise<RemoteProjectFsResult> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) throw new Error("远程执行器无效");
    const connection = this.connection(workerId);
    const requestId = crypto.randomUUID();
    return new Promise<RemoteProjectFsResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFs.delete(requestId);
        reject(new Error("远程文件夹请求超时"));
      }, 15_000);
      this.pendingFs.set(requestId, { workerId, resolve, reject, timer });
      this.send(connection.socket, { type: "project_fs", requestId, action, path: directory, name, content });
    });
  }

  generateConversationTitle(executorId: string, prompt: string, timeoutMs: number): Promise<string> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行器无效"));
    const connection = this.connection(workerId);
    if (!connection.titleAgent) return Promise.reject(new Error("远程 Worker 尚未支持 Codex 命名器，请先升级 Worker"));
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingTitleAgents.delete(requestId); reject(new Error("远程 Codex 命名请求超时")); }, timeoutMs + 15_000);
      this.pendingTitleAgents.set(requestId, { workerId, resolve, reject, timer });
      this.send(connection.socket, { type: "title_agent", requestId, prompt, timeoutMs });
    });
  }

  run(workerId: string, request: Omit<RemoteRunRequest, "transferToken" | "attachments">, inputs: Array<{ row: FileRow; absolutePath: string }>, callbacks: Pick<PendingJob, "onThreadStarted" | "onProgress" | "onContextUsage" | "onQuotaUsage">): Promise<{ finalResponse: string; artifacts: StoredArtifact[]; omittedArtifacts: NonNullable<Extract<TenantWorkerEvent, { type: "completed" }>["omittedArtifacts"]> }> {
    const connection = this.connection(workerId);
    if (this.pendingJobs.has(request.jobId)) return Promise.reject(new Error("远程任务已经存在"));
    const transferToken = crypto.randomBytes(32).toString("base64url");
    return new Promise((resolve, reject) => {
      const pending: PendingJob = {
        workerId, transferToken, observedActive: false, resolve, reject, ...callbacks,
        inputFiles: new Map(inputs.map((input) => [input.row.id, input])),
        artifacts: new Map(),
        activeUploads: new Map(),
        uploadedBytes: 0,
      };
      this.persistPendingJob(request.jobId, pending);
      this.pendingJobs.set(request.jobId, pending);
      this.updatePresence(workerId);
      const attachments = inputs.map(({ row }) => ({
        id: row.id,
        name: row.original_name,
        mimeType: row.mime_type,
        size: row.size,
        downloadPath: `/api/remote-worker-files/${encodeURIComponent(request.jobId)}/input/${encodeURIComponent(row.id)}`,
      }));
      this.send(connection.socket, { type: "run", request: { ...request, transferToken, attachments } });
    });
  }

  resume(jobId: string, workerId: string, callbacks: Pick<PendingJob, "onThreadStarted" | "onProgress" | "onContextUsage" | "onQuotaUsage">): Promise<{ finalResponse: string; artifacts: StoredArtifact[]; omittedArtifacts: NonNullable<Extract<TenantWorkerEvent, { type: "completed" }>["omittedArtifacts"]> }> {
    if (this.pendingJobs.has(jobId)) return Promise.reject(new Error("远程任务已经恢复"));
    const state = this.readRecoveryState(jobId);
    if (!state || state.workerId !== workerId) return Promise.reject(new Error("远程任务恢复租约不存在或不匹配"));
    const job = this.db.getJob(jobId);
    const conversation = job ? this.db.getConversation(job.conversation_id) : undefined;
    if (!job || job.status !== "running" || !conversation) return Promise.reject(new Error("远程任务已经结束"));
    const workspace = ensureTenantWorkspace(this.config.tenantRoot, conversation.user_id, conversation.id);
    const inputFiles = new Map<string, { row: FileRow; absolutePath: string }>();
    for (const fileId of state.inputFileIds) {
      const row = this.db.getFile(fileId);
      if (!row || row.conversation_id !== conversation.id || row.kind === "output") continue;
      inputFiles.set(row.id, { row, absolutePath: resolveInside(workspace, row.relative_path) });
    }
    const artifacts = new Map<string, StoredArtifact>();
    const stagingRoot = ownedStagingDirectory(this.config.dataRoot, "remote-worker-staging", jobId);
    for (const artifact of state.artifacts) {
      const relative = path.relative(stagingRoot, artifact.tempPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      try {
        if (fs.statSync(artifact.tempPath).isFile()) artifacts.set(artifact.id, artifact);
      } catch { /* A missing staged artifact is omitted from recovery. */ }
    }
    return new Promise((resolve, reject) => {
      const pending: PendingJob = {
        workerId,
        transferToken: state.transferToken,
        observedActive: false,
        resolve,
        reject,
        ...callbacks,
        inputFiles,
        artifacts,
        activeUploads: new Map(),
        uploadedBytes: state.uploadedBytes,
      };
      this.pendingJobs.set(jobId, pending);
      pending.disconnectTimer = setTimeout(() => this.failJob(jobId, new Error("远程电脑未在 90 秒内恢复该任务")), 90_000);
      this.updatePresence(workerId);
      if (state.terminalEvent) queueMicrotask(() => this.handleJobEvent(jobId, pending, state.terminalEvent!));
    });
  }

  release(jobId: string): void {
    const pending = this.pendingJobs.get(jobId);
    if (pending?.disconnectTimer) clearTimeout(pending.disconnectTimer);
    this.pendingJobs.delete(jobId);
    try { fs.rmSync(this.recoveryPath(jobId), { force: true }); }
    catch { /* Terminal database state remains authoritative if cleanup is delayed. */ }
  }

  cancel(jobId: string): boolean {
    const pending = this.pendingJobs.get(jobId);
    if (!pending) return false;
    const connection = this.connections.get(pending.workerId);
    if (!connection) return false;
    this.send(connection.socket, { type: "cancel", jobId });
    return true;
  }

  steer(
    jobId: string,
    prompt: string,
    inputs: Array<{ row: FileRow; absolutePath: string }> = [],
    turnContext?: { version: 1; userPrompt: string; imageInput: "preload" | "path_only" | "none" },
  ): Promise<string> {
    const pending = this.pendingJobs.get(jobId);
    if (!pending) return Promise.reject(new Error("当前远程任务已经结束"));
    const connection = this.connection(pending.workerId);
    const requestId = crypto.randomUUID();
    for (const input of inputs) pending.inputFiles.set(input.row.id, input);
    this.persistPendingJob(jobId, pending);
    const attachments = inputs.map(({ row }) => ({
      id: row.id,
      name: row.original_name,
      mimeType: row.mime_type,
      size: row.size,
      downloadPath: `/api/remote-worker-files/${encodeURIComponent(jobId)}/input/${encodeURIComponent(row.id)}`,
    }));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSteers.delete(requestId);
        reject(new Error("远程引导请求在 30 秒内未确认；为避免重复副作用，未自动重发"));
      }, 30_000);
      this.pendingSteers.set(requestId, { jobId, workerId: pending.workerId, resolve, reject, timer });
      this.send(connection.socket, {
        type: "steer", jobId, requestId, prompt, attachments, transferToken: pending.transferToken,
        ...(connection.agentTurnContext && turnContext ? { turnContext } : {}),
      });
    });
  }

  renameThread(workerId: string, threadId: string, name: string): Promise<void> {
    return this.threadAction(workerId, { type: "thread_rename", requestId: crypto.randomUUID(), threadId, name });
  }

  archiveThread(workerId: string, threadId: string): Promise<void> {
    return this.threadAction(workerId, { type: "thread_archive", requestId: crypto.randomUUID(), threadId });
  }

  projectThreadsPage(executorId: string, projectRoot: string, cursor: string | null, limit = 20): Promise<RemoteThreadSyncPage> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行器无效"));
    const connection = this.connection(workerId);
    const requestId = crypto.randomUUID();
    return new Promise<RemoteThreadSyncPage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingThreadSyncs.delete(requestId);
        reject(new Error("远程 Codex 任务同步超时"));
      }, remoteThreadSyncTimeoutMs());
      this.pendingThreadSyncs.set(requestId, { workerId, resolve, reject, timer });
      this.send(connection.socket, { type: "thread_sync", requestId, projectRoot, cursor, limit });
    });
  }

  fetchFile(executorId: string, projectRoot: string, sourcePath: string): Promise<StoredFetchedArtifact> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行器无效"));
    const connection = this.connection(workerId);
    const requestId = crypto.randomUUID();
    const transferToken = crypto.randomBytes(32).toString("base64url");
    return new Promise<StoredFetchedArtifact>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingFileFetches.get(requestId);
        this.pendingFileFetches.delete(requestId);
        if (pending?.artifact) this.removeStagedArtifact(pending.artifact);
        reject(new Error("远程文件获取超时"));
      }, 120_000);
      this.pendingFileFetches.set(requestId, { workerId, transferToken, sourcePath, resolve, reject, timer });
      this.send(connection.socket, { type: "file_fetch", requestId, projectRoot, path: sourcePath, transferToken });
    });
  }

  refreshRuntime(executorId: string, checkLatest = true): Promise<ExecutorRuntimeStatus> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行机器无效"));
    const connection = this.connection(workerId);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRuntimes.delete(requestId); reject(new Error("Codex 信息刷新超时")); }, 60_000);
      this.pendingRuntimes.set(requestId, { workerId, resolve, reject, timer });
      this.send(connection.socket, { type: "runtime_refresh", requestId, checkLatest });
    });
  }

  upgradeCodex(executorId: string, version: string): Promise<ExecutorRuntimeStatus> {
    const workerId = workerIdFromExecutor(executorId);
    if (!workerId) return Promise.reject(new Error("远程执行机器无效"));
    const connection = this.connection(workerId);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingUpgrades.delete(requestId); reject(new Error("Codex 升级请求超时")); }, 12 * 60_000);
      this.pendingUpgrades.set(requestId, { workerId, resolve, reject, timer });
      this.send(connection.socket, { type: "codex_upgrade", requestId, version });
    });
  }

  private threadAction(workerId: string, message: Extract<ServerToRemoteWorker, { type: "thread_rename" | "thread_archive" }>): Promise<void> {
    const connection = this.connection(workerId);
    const requestId = message.requestId;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRenames.delete(requestId);
        reject(new Error("远程会话改名超时"));
      }, 10_000);
      this.pendingRenames.set(requestId, { workerId, resolve, reject, timer });
      this.send(connection.socket, message);
    });
  }

  inputFile(jobId: string, fileId: string, token: string): { path: string; row: FileRow } | undefined {
    const pending = this.pendingJobs.get(jobId);
    if (!pending || !safeEqual(pending.transferToken, token)) return undefined;
    const input = pending.inputFiles.get(fileId);
    return input ? { path: input.absolutePath, row: input.row } : undefined;
  }

  authorizeArtifactUpload(jobId: string, token: string): boolean {
    const pending = this.pendingJobs.get(jobId);
    return Boolean(pending && isTransferScopeId(jobId) && safeEqual(pending.transferToken, token));
  }

  authorizeFetchedArtifactUpload(requestId: string, token: string): boolean {
    const pending = this.pendingFileFetches.get(requestId);
    return Boolean(pending && isTransferScopeId(requestId) && !pending.artifact && !pending.upload && safeEqual(pending.transferToken, token));
  }

  beginArtifactUpload(jobId: string, token: string, name: string, mimeType: string, expectedSize: number): RemoteUploadReservation | undefined {
    const pending = this.pendingJobs.get(jobId);
    if (!pending || !isTransferScopeId(jobId) || !safeEqual(pending.transferToken, token)) return undefined;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > REMOTE_TRANSFER_MAX_FILE_BYTES) {
      throw new RemoteTransferError("远程结果文件大小无效。", 413, "REMOTE_FILE_TOO_LARGE");
    }
    if (pending.artifacts.size + pending.activeUploads.size >= REMOTE_TRANSFER_MAX_FILES_PER_JOB) {
      throw new RemoteTransferError("单个任务的结果文件数量超过上限。", 429, "REMOTE_FILE_COUNT_LIMIT");
    }
    if (pending.activeUploads.size >= REMOTE_TRANSFER_MAX_ACTIVE_PER_JOB) {
      throw new RemoteTransferError("单个任务同时上传的文件过多。", 429, "REMOTE_UPLOAD_CONCURRENCY_LIMIT");
    }
    const reservedBytes = [...pending.activeUploads.values()].reduce((total, upload) => total + upload.expectedSize, 0);
    if (pending.uploadedBytes + reservedBytes + expectedSize > REMOTE_TRANSFER_MAX_TOTAL_BYTES_PER_JOB) {
      throw new RemoteTransferError("单个任务的结果文件总量超过 512 MiB 上限。", 413, "REMOTE_JOB_BYTES_LIMIT");
    }
    const reservation = this.createUploadReservation("job", jobId, name, mimeType, expectedSize);
    pending.activeUploads.set(reservation.id, reservation);
    return reservation;
  }

  beginFetchedArtifactUpload(requestId: string, token: string, name: string, mimeType: string, expectedSize: number): RemoteUploadReservation | undefined {
    const pending = this.pendingFileFetches.get(requestId);
    if (!pending || pending.artifact || pending.upload || !isTransferScopeId(requestId) || !safeEqual(pending.transferToken, token)) return undefined;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > REMOTE_TRANSFER_MAX_FILE_BYTES) {
      throw new RemoteTransferError("远程文件大小无效。", 413, "REMOTE_FILE_TOO_LARGE");
    }
    const reservation = this.createUploadReservation("fetch", requestId, name, mimeType, expectedSize);
    pending.upload = reservation;
    return reservation;
  }

  async completeArtifactUpload(reservation: RemoteUploadReservation, size: number, sha256: string): Promise<RemoteArtifact | undefined> {
    const pending = reservation.kind === "job" ? this.pendingJobs.get(reservation.ownerId) : undefined;
    if (!pending || pending.activeUploads.get(reservation.id)?.temporaryPath !== reservation.temporaryPath || size !== reservation.expectedSize) return undefined;
    await fs.promises.rename(reservation.temporaryPath, reservation.finalPath);
    pending.activeUploads.delete(reservation.id);
    pending.uploadedBytes += size;
    const artifact: StoredArtifact = {
      id: reservation.id,
      name: reservation.name,
      mimeType: reservation.mimeType,
      size,
      sha256,
      tempPath: reservation.finalPath,
    };
    pending.artifacts.set(artifact.id, artifact);
    this.persistPendingJob(reservation.ownerId, pending);
    return { id: artifact.id, name: artifact.name, mimeType: artifact.mimeType, size: artifact.size, sha256: artifact.sha256 };
  }

  async completeFetchedArtifactUpload(reservation: RemoteUploadReservation, size: number, sha256: string): Promise<RemoteFetchedArtifact | undefined> {
    const pending = reservation.kind === "fetch" ? this.pendingFileFetches.get(reservation.ownerId) : undefined;
    if (!pending || pending.upload?.temporaryPath !== reservation.temporaryPath || pending.artifact || size !== reservation.expectedSize) return undefined;
    await fs.promises.rename(reservation.temporaryPath, reservation.finalPath);
    pending.upload = undefined;
    pending.artifact = {
      id: reservation.id,
      name: reservation.name,
      mimeType: reservation.mimeType,
      size,
      sha256,
      sourcePath: pending.sourcePath,
      tempPath: reservation.finalPath,
    };
    return {
      id: pending.artifact.id,
      name: pending.artifact.name,
      mimeType: pending.artifact.mimeType,
      size: pending.artifact.size,
      sha256: pending.artifact.sha256,
      sourcePath: pending.sourcePath,
    };
  }

  async abortUpload(reservation: RemoteUploadReservation): Promise<void> {
    if (reservation.kind === "job") {
      const pending = this.pendingJobs.get(reservation.ownerId);
      if (pending?.activeUploads.get(reservation.id)?.temporaryPath === reservation.temporaryPath) pending.activeUploads.delete(reservation.id);
    } else {
      const pending = this.pendingFileFetches.get(reservation.ownerId);
      if (pending?.upload?.temporaryPath === reservation.temporaryPath) pending.upload = undefined;
    }
    await fs.promises.rm(reservation.temporaryPath, { force: true }).catch(() => undefined);
  }

  private createUploadReservation(kind: RemoteUploadReservation["kind"], ownerId: string, name: string, mimeType: string, expectedSize: number): RemoteUploadReservation {
    const id = crypto.randomUUID();
    const safeName = safeTransferName(name, kind === "job" ? "output.bin" : "download.bin");
    const directory = ownedStagingDirectory(this.config.dataRoot, kind === "job" ? "remote-worker-staging" : "remote-worker-fetch-staging", ownerId);
    fs.mkdirSync(directory, { recursive: true });
    return {
      id,
      kind,
      ownerId,
      expectedSize,
      name: safeName,
      mimeType: mimeType.slice(0, 200) || "application/octet-stream",
      temporaryPath: path.join(directory, `${id}.part`),
      finalPath: path.join(directory, `${id}-${safeName}`),
    };
  }

  private handleConnection(socket: WebSocket): void {
    let authenticatedWorkerId: string | null = null;
    let protocolErrors = 0;
    const authTimer = setTimeout(() => socket.close(4001, "authentication timeout"), 10_000);
    socket.on("message", (data, isBinary) => {
      const payload = websocketTextPayload(data, isBinary);
      if (!payload || payload.bytes > REMOTE_WORKER_MAX_MESSAGE_BYTES) {
        socket.close(payload ? 1009 : 1003, payload ? "message too large" : "text messages required");
        return;
      }
      const parsed = parseRemoteWorkerMessage(payload.text);
      if (!parsed.ok) {
        protocolErrors += 1;
        if (!authenticatedWorkerId || protocolErrors >= REMOTE_WORKER_MAX_PROTOCOL_ERRORS) {
          socket.close(authenticatedWorkerId ? 1008 : 4002, "invalid protocol message");
        } else {
          this.send(socket, { type: "request_failed", message: "远程 Worker 消息格式无效；连续三次将断开连接" });
        }
        return;
      }
      const message = parsed.message;
      if (!authenticatedWorkerId) {
        if (message.type !== "hello") { socket.close(4003, "hello required"); return; }
        try {
          authenticatedWorkerId = this.authenticate(socket, message);
          clearTimeout(authTimer);
        } catch (error) {
          socket.close(4004, error instanceof Error ? error.message.slice(0, 100) : "authentication failed");
        }
        return;
      }
      const current = this.connections.get(authenticatedWorkerId);
      if (!current || current.socket !== socket) return;
      this.handleMessage(authenticatedWorkerId, message);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!authenticatedWorkerId) return;
      const current = this.connections.get(authenticatedWorkerId);
      if (current && current.socket !== socket) return;
      if (current?.socket === socket) this.connections.delete(authenticatedWorkerId);
      if (this.closing) return;
      this.db.markRemoteWorkerOffline(authenticatedWorkerId);
      this.armJobDisconnectTimers(authenticatedWorkerId);
      for (const [requestId, pending] of this.pendingFileFetches) {
        if (pending.workerId !== authenticatedWorkerId) continue;
        clearTimeout(pending.timer);
        this.pendingFileFetches.delete(requestId);
        if (pending.artifact) this.removeStagedArtifact(pending.artifact);
        pending.reject(new Error("远程电脑当前离线，暂时无法获取文件"));
      }
      for (const [requestId, pending] of this.pendingTitleAgents) {
        if (pending.workerId !== authenticatedWorkerId) continue;
        clearTimeout(pending.timer); this.pendingTitleAgents.delete(requestId); pending.reject(new Error("远程电脑在命名过程中离线"));
      }
      for (const [requestId, pending] of this.pendingCodexAccounts) {
        if (pending.workerId !== authenticatedWorkerId) continue;
        clearTimeout(pending.timer); this.pendingCodexAccounts.delete(requestId); pending.reject(new Error("远程电脑在 Codex 账号操作期间离线"));
      }
      this.emit("status", authenticatedWorkerId);
    });
  }

  private authenticate(socket: WebSocket, hello: Extract<RemoteWorkerToServer, { type: "hello" }>): string {
    if (!this.config.remoteWorkerEnrollmentToken || !safeEqual(this.config.remoteWorkerEnrollmentToken, hello.enrollmentToken)) throw new Error("远程 Worker 凭据无效");
    if (![4, REMOTE_WORKER_PROTOCOL_VERSION].includes(hello.protocolVersion)) throw new Error("远程 Worker 协议版本不兼容");
    if (!/^[0-9a-f-]{36}$/i.test(hello.workerId)) throw new Error("远程 Worker ID 无效");
    const machineName = hello.machineName.trim();
    if (!machineName || machineName.length > 32 || /[\r\n\[\]]/.test(machineName)) throw new Error("远程机器名无效");
    const previous = this.connections.get(hello.workerId);
    if (previous) {
      this.armJobDisconnectTimers(hello.workerId);
      previous.socket.close(4000, "replaced by new connection");
    }
    const worker = this.db.registerRemoteWorker({
      id: hello.workerId,
      machine_name: machineName,
      platform: hello.platform.slice(0, 40),
      protocol_version: hello.protocolVersion,
      worker_version: hello.workerVersion.slice(0, 40),
      worker_release: typeof hello.workerRelease === "string" ? hello.workerRelease.slice(0, 100) : null,
      worker_commit: typeof hello.workerCommit === "string" ? hello.workerCommit.slice(0, 64) : null,
      worker_update_capable: hello.capabilities?.workerUpdate ? 1 : 0,
      codex_version: hello.codexVersion.slice(0, 80),
      capacity: normalizeRemoteWorkerCapacity(hello.capacity),
    });
    this.connections.set(hello.workerId, {
      socket,
      workerId: hello.workerId,
      capacity: worker.capacity,
      lastHeartbeat: Date.now(),
      activeJobs: new Set(),
      heartbeatSeen: false,
      waitAutomation: Boolean(hello.capabilities?.waitAutomation),
      capacityConfig: Boolean(hello.capabilities?.capacityConfig),
      dynamicWaitTool: Boolean(hello.capabilities?.dynamicWaitTool),
      agentTurnContext: Boolean(hello.capabilities?.agentTurnContext),
      accountSkills: Boolean(hello.capabilities?.accountSkills),
      titleAgent: Boolean(hello.capabilities?.titleAgent),
      codexAccounts: Boolean(hello.capabilities?.codexAccounts),
      accountSwitching: false,
    });
    this.send(socket, { type: "authenticated", workerId: hello.workerId, heartbeatIntervalMs: 15_000 });
    this.refreshProjectWatches(remoteExecutorId(hello.workerId));
    this.reconcileWorkerUpdateOnConnect(hello.workerId);
    this.maybeQueueAutomaticWorkerUpdate(hello.workerId);
    this.emit("status", hello.workerId);
    return hello.workerId;
  }

  private handleMessage(workerId: string, message: RemoteWorkerToServer): void {
    if (message.type === "quota_usage") {
      if (!message.usage || typeof message.usage.remainingPercent !== "number" || !Number.isFinite(message.usage.remainingPercent)) return;
      const executorId = remoteExecutorId(workerId);
      if (this.db.setExecutorCodexQuota(executorId, message.usage, message.accountId)) {
        this.emit("quota_usage", { workerId, executorId, usage: message.usage });
      }
      return;
    }
    if (message.type === "thread_activity") {
      const project = this.db.getProject(message.projectId);
      if (!project || project.archived_at || workerIdFromExecutor(project.executor_id) !== workerId || !validThreadSnapshot(message.thread)) return;
      this.emit("thread_activity", {
        workerId,
        executorId: project.executor_id,
        projectId: project.id,
        thread: message.thread,
      } satisfies { workerId: string; executorId: string; projectId: string; thread: RemoteThreadSnapshot });
      return;
    }
    if (message.type === "heartbeat") {
      const connection = this.connections.get(workerId);
      if (connection) {
        connection.lastHeartbeat = Date.now();
        connection.activeJobs = new Set(message.activeJobs);
        connection.heartbeatSeen = true;
      }
      this.reconcileWorkerJobs(workerId, message.activeJobs);
      this.db.updateRemoteWorkerPresence(workerId, "online", message.activeJobs.length);
      if (connection) this.send(connection.socket, { type: "heartbeat_ack", at: new Date().toISOString() });
      this.maybeQueueAutomaticWorkerUpdate(workerId);
      this.maybeDispatchWorkerUpdate(workerId);
      this.emit("status", workerId);
      return;
    }
    if (message.type === "worker_update_ack") {
      const update = this.db.getRemoteWorkerUpdate(workerId);
      if (!update || update.request_id !== message.requestId || update.state !== "dispatching") return;
      this.db.updateRemoteWorkerUpdate(workerId, message.accepted ? "updating" : "failed", message.accepted ? null : message.message || "Worker 拒绝了升级请求");
      this.emit("status", workerId);
      return;
    }
    if (message.type === "worker_update_result") {
      const update = this.db.getRemoteWorkerUpdate(workerId);
      const worker = this.db.getRemoteWorker(workerId);
      if (update?.request_id === message.requestId) {
        const verified = Boolean(message.ok && worker
          && worker.worker_version === update.target_version
          && worker.worker_release === update.target_ref
          && (!this.targetRelease || update.target_version !== this.targetRelease.version || worker.worker_commit === this.targetRelease.commit)
          && message.installedVersion === update.target_version
          && message.installedRef === update.target_ref
          && (!this.targetRelease || update.target_version !== this.targetRelease.version || message.installedCommit === this.targetRelease.commit));
        this.db.updateRemoteWorkerUpdate(workerId, verified ? "succeeded" : "failed", verified ? null : message.message || "Worker 重连后的版本校验失败");
        this.emit("status", workerId);
      }
      const connection = this.connections.get(workerId);
      if (connection) this.send(connection.socket, { type: "worker_update_result_ack", requestId: message.requestId });
      return;
    }
    if (message.type === "worker_config_result") {
      const pending = this.pendingWorkerConfigs.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer);
      this.pendingWorkerConfigs.delete(message.requestId);
      if (!message.ok || message.capacity !== pending.capacity) {
        pending.reject(new Error(message.message || "远程 Worker 未确认新的并发容量"));
        return;
      }
      const connection = this.connections.get(workerId);
      if (!connection) {
        pending.reject(new Error("远程 Worker 在保存容量后离线"));
        return;
      }
      connection.capacity = pending.capacity;
      const worker = this.db.updateRemoteWorkerCapacity(workerId, pending.capacity);
      if (!worker) {
        pending.reject(new Error("远程 Worker 容量状态未能持久化"));
        return;
      }
      this.emit("status", workerId);
      pending.resolve(this.workerView(worker));
      return;
    }
    if (message.type === "codex_accounts_result") {
      const pending = this.pendingCodexAccounts.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer);
      this.pendingCodexAccounts.delete(message.requestId);
      if (!message.ok) pending.reject(new Error(message.message || "远程 Codex 账号操作失败"));
      else pending.resolve({ state: message.state, login: message.login, restart: message.restart });
      return;
    }
    if (message.type === "title_agent_result") {
      const pending = this.pendingTitleAgents.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer); this.pendingTitleAgents.delete(message.requestId);
      if (message.ok && typeof message.output === "string") pending.resolve(message.output);
      else pending.reject(new Error(message.message || "远程 Codex 命名失败"));
      return;
    }
    if (message.type === "project_fs_result" || message.type === "request_failed") {
      const requestId = message.requestId;
      if (!requestId) return;
      const pending = this.pendingFs.get(requestId);
      if (pending && pending.workerId === workerId) {
        clearTimeout(pending.timer);
        this.pendingFs.delete(requestId);
        if (message.type === "request_failed") pending.reject(new Error(message.message));
        else pending.resolve({ directory: message.directory, parent: message.parent, directories: message.directories, virtualRoot: message.virtualRoot });
      }
      if (message.type === "request_failed") {
        const sync = this.pendingThreadSyncs.get(requestId);
        if (sync && sync.workerId === workerId) {
          clearTimeout(sync.timer);
          this.pendingThreadSyncs.delete(requestId);
          sync.reject(new Error(message.message));
        }
        const runtime = this.pendingRuntimes.get(requestId);
        if (runtime && runtime.workerId === workerId) {
          clearTimeout(runtime.timer); this.pendingRuntimes.delete(requestId); runtime.reject(new Error(message.message));
        }
      }
      return;
    }
    if (message.type === "runtime_status") {
      const runtime = this.db.upsertExecutorRuntime(remoteExecutorId(workerId), {
        installedVersion: message.installedVersion,
        latestVersion: message.latestVersion,
        versionCheckedAt: message.versionCheckedAt,
        catalogUpdatedAt: message.catalogUpdatedAt,
        agentOptions: message.agentOptions,
        updateState: "idle",
        updateError: null,
      });
      if (message.requestId) {
        const pending = this.pendingRuntimes.get(message.requestId);
        if (pending && pending.workerId === workerId) {
          clearTimeout(pending.timer); this.pendingRuntimes.delete(message.requestId); pending.resolve(runtime);
        }
      }
      this.emit("status", workerId);
      return;
    }
    if (message.type === "codex_upgrade_result") {
      const pending = this.pendingUpgrades.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer); this.pendingUpgrades.delete(message.requestId);
      if (!message.ok || !message.runtime) {
        this.db.upsertExecutorRuntime(remoteExecutorId(workerId), { updateState: "failed", updateError: message.message || "Codex 升级失败" });
        pending.reject(new Error(message.message || "Codex 升级失败"));
      } else {
        const runtime = this.db.upsertExecutorRuntime(remoteExecutorId(workerId), { ...message.runtime, updateState: "idle", updateError: null });
        pending.resolve(runtime);
      }
      this.emit("status", workerId);
      return;
    }
    if (message.type === "thread_sync_result") {
      const pending = this.pendingThreadSyncs.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer);
      this.pendingThreadSyncs.delete(message.requestId);
      pending.resolve({ threads: message.threads, nextCursor: message.nextCursor });
      return;
    }
    if (message.type === "thread_rename_result") {
      const pending = this.pendingRenames.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer);
      this.pendingRenames.delete(message.requestId);
      if (message.ok) pending.resolve(); else pending.reject(new Error(message.message || "远程会话改名失败"));
      return;
    }
    if (message.type === "file_fetch_result") {
      const pending = this.pendingFileFetches.get(message.requestId);
      if (!pending || pending.workerId !== workerId) return;
      clearTimeout(pending.timer);
      this.pendingFileFetches.delete(message.requestId);
      if (message.ok && pending.artifact) pending.resolve(pending.artifact);
      else {
        if (pending.artifact) this.removeStagedArtifact(pending.artifact);
        pending.reject(new Error(message.message || "远程文件未能成功获取"));
      }
      return;
    }
    if (message.type !== "event") return;
    const pending = this.pendingJobs.get(message.jobId);
    if (!pending || pending.workerId !== workerId) return;
    pending.observedActive = true;
    this.handleJobEvent(message.jobId, pending, message.event);
  }

  private armJobDisconnectTimers(workerId: string): void {
    for (const [jobId, pending] of this.pendingJobs) {
      if (pending.workerId !== workerId || pending.disconnectTimer) continue;
      pending.disconnectTimer = setTimeout(() => this.failJob(jobId, new Error("远程电脑断线超过 90 秒")), 90_000);
    }
  }

  private reconcileWorkerJobs(workerId: string, activeJobIds: string[]): void {
    const active = new Set(activeJobIds);
    for (const [jobId, pending] of [...this.pendingJobs]) {
      if (pending.workerId !== workerId) continue;
      if (active.has(jobId)) {
        pending.observedActive = true;
        if (pending.disconnectTimer) clearTimeout(pending.disconnectTimer);
        pending.disconnectTimer = undefined;
        continue;
      }
      if (!pending.observedActive && !pending.disconnectTimer) continue;
      this.failJob(jobId, new Error("远程电脑重连后未恢复该任务，请重新发送"));
    }
  }

  private handleJobEvent(jobId: string, pending: PendingJob, event: TenantWorkerEvent): void {
    if (event.type === "thread_started") pending.onThreadStarted(event.threadId);
    if (event.type === "context_usage") pending.onContextUsage(event.usage);
    if (event.type === "quota_usage") pending.onQuotaUsage(event.usage);
    if (event.type === "progress") pending.onProgress(event.payload);
    if (event.type === "steer_completed" || event.type === "steer_failed") {
      const steer = this.pendingSteers.get(event.requestId);
      if (!steer || steer.jobId !== jobId || steer.workerId !== pending.workerId) return;
      clearTimeout(steer.timer);
      this.pendingSteers.delete(event.requestId);
      if (event.type === "steer_completed") steer.resolve(event.turnId);
      else steer.reject(new Error(event.message));
      return;
    }
    if (event.type === "completed") {
      this.persistPendingJob(jobId, pending, event);
      if (pending.disconnectTimer) clearTimeout(pending.disconnectTimer);
      this.pendingJobs.delete(jobId);
      this.updatePresence(pending.workerId);
      pending.resolve({
        finalResponse: event.finalResponse,
        artifacts: [...pending.artifacts.values()],
        omittedArtifacts: event.omittedArtifacts ?? [],
      });
    }
    if (event.type === "failed") {
      this.persistPendingJob(jobId, pending, event);
      const error = new Error(event.message);
      if (event.cancelled) error.name = "AbortError";
      this.failJob(jobId, error);
    }
  }

  private failJob(jobId: string, error: Error): void {
    const pending = this.pendingJobs.get(jobId);
    if (!pending) return;
    if (pending.disconnectTimer) clearTimeout(pending.disconnectTimer);
    this.pendingJobs.delete(jobId);
    for (const [requestId, steer] of this.pendingSteers) {
      if (steer.jobId !== jobId) continue;
      clearTimeout(steer.timer);
      this.pendingSteers.delete(requestId);
      steer.reject(error);
    }
    this.updatePresence(pending.workerId);
    pending.reject(error);
  }

  private recoveryPath(jobId: string): string {
    if (!isTransferScopeId(jobId)) throw new Error("远程任务 ID 无效");
    return path.join(this.config.dataRoot, "remote-worker-recovery", `${jobId}.json`);
  }

  private persistPendingJob(jobId: string, pending: PendingJob, terminalEvent?: PersistedRemoteJob["terminalEvent"]): void {
    const destination = this.recoveryPath(jobId);
    const previous = this.readRecoveryState(jobId);
    const state: PersistedRemoteJob = {
      version: 1,
      jobId,
      workerId: pending.workerId,
      transferToken: pending.transferToken,
      inputFileIds: [...pending.inputFiles.keys()],
      artifacts: [...pending.artifacts.values()],
      uploadedBytes: pending.uploadedBytes,
      ...(terminalEvent ? { terminalEvent } : previous?.terminalEvent ? { terminalEvent: previous.terminalEvent } : {}),
    };
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { fs.renameSync(temporary, destination); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  private readRecoveryState(jobId: string): PersistedRemoteJob | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.recoveryPath(jobId), "utf8")) as Partial<PersistedRemoteJob>;
      if (value.version !== 1 || value.jobId !== jobId || typeof value.workerId !== "string"
        || typeof value.transferToken !== "string" || value.transferToken.length < 32
        || !Array.isArray(value.inputFileIds) || !value.inputFileIds.every(isTransferScopeId)
        || !Array.isArray(value.artifacts) || !value.artifacts.every(validStoredArtifact)
        || !Number.isSafeInteger(value.uploadedBytes) || (value.uploadedBytes ?? -1) < 0) return undefined;
      return value as PersistedRemoteJob;
    } catch { return undefined; }
  }

  private connection(workerId: string): Connection {
    const connection = this.connections.get(workerId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) throw new Error("远程电脑当前离线");
    return connection;
  }

  private updatePresence(workerId: string): void {
    const connection = this.connections.get(workerId);
    const active = this.activeJobCount(workerId, connection);
    this.db.updateRemoteWorkerPresence(workerId, connection ? "online" : "offline", active);
    this.emit("status", workerId);
  }

  private activeJobCount(workerId: string, connection?: Connection): number {
    const activeJobIds = new Set(connection?.activeJobs ?? []);
    for (const [jobId, pending] of this.pendingJobs) {
      if (pending.workerId === workerId) activeJobIds.add(jobId);
    }
    return activeJobIds.size;
  }

  private removeStagedArtifact(artifact: StoredFetchedArtifact): void {
    try { cleanupOwnedStagingDirectory(this.config.dataRoot, "remote-worker-fetch-staging", path.basename(path.dirname(artifact.tempPath))); }
    catch { /* Fetch staging cleanup must not mask the caller's result. */ }
  }

  private checkHeartbeats(): void {
    const cutoff = Date.now() - 45_000;
    for (const connection of this.connections.values()) {
      if (connection.lastHeartbeat < cutoff) connection.socket.terminate();
    }
    const now = Date.now();
    for (const update of this.db.listRemoteWorkerUpdates()) {
      const age = now - Date.parse(update.updated_at);
      const timedOut = (update.state === "dispatching" && age > 2 * 60_000)
        || (update.state === "updating" && age > REMOTE_WORKER_UPDATE_TIMEOUT_MS);
      if (!timedOut) continue;
      this.db.updateRemoteWorkerUpdate(update.worker_id, "failed", "Worker 升级在 15 分钟内未完成，请检查节点 worker-update.log 后重试");
      this.emit("status", update.worker_id);
    }
    for (const worker of this.db.listRemoteWorkers()) this.maybeQueueAutomaticWorkerUpdate(worker.id);
  }

  private workerView(worker: RemoteWorkerRow): ExecutorView {
    const connection = this.connections.get(worker.id);
    const active = Math.max(worker.active_jobs, this.activeJobCount(worker.id, connection));
    const update = this.db.getRemoteWorkerUpdate(worker.id);
    return {
      id: remoteExecutorId(worker.id), machineName: worker.machine_name, kind: "remote_worker",
      status: this.connections.has(worker.id) && worker.status !== "disabled" ? "online" : worker.status,
      platform: worker.platform, capacity: worker.capacity, activeJobs: active, lastSeenAt: worker.last_seen_at,
      runtime: this.db.getExecutorRuntime(remoteExecutorId(worker.id)) ?? null,
      securityBoundary: {
        mode: "danger_full_access",
        label: "远程电脑本机用户高权限（非隔离）",
        description: "命令继承 Worker 所在 Windows 用户权限；本轮开始后不允许透明整轮重放。",
      },
      retryCapability: { transparentBeforeStart: true, replayAfterStart: false, idempotencyReceipts: false },
      codexAccountManagementCapable: Boolean(connection?.codexAccounts),
      worker: {
        installedVersion: worker.worker_version,
        installedRef: worker.worker_release,
        installedCommit: worker.worker_commit,
        updaterCapable: Boolean(worker.worker_update_capable),
        capacityConfigurable: Boolean(connection?.capacityConfig),
        targetVersion: REMOTE_WORKER_TARGET_VERSION,
        targetRef: REMOTE_WORKER_TARGET_REF,
        update: update ? {
          requestId: update.request_id, state: update.state, requestedAt: update.requested_at,
          dispatchedAt: update.dispatched_at, completedAt: update.completed_at, error: update.error,
        } : null,
      },
    };
  }

  private reconcileWorkerUpdateOnConnect(workerId: string): void {
    const worker = this.db.getRemoteWorker(workerId);
    const update = this.db.getRemoteWorkerUpdate(workerId);
    if (!worker || !update || !["queued", "dispatching", "updating"].includes(update.state)) return;
    if (worker.worker_version === update.target_version && worker.worker_release === update.target_ref
      && (!this.targetRelease || update.target_version !== this.targetRelease.version || worker.worker_commit === this.targetRelease.commit)) {
      this.db.updateRemoteWorkerUpdate(workerId, "succeeded");
    }
  }

  /** Queue and retry the formal Worker upgrade for every outdated capable node after deployment. */
  private maybeQueueAutomaticWorkerUpdate(workerId: string): void {
    if (!this.config.containerized || !this.targetRelease) return;
    const worker = this.db.getRemoteWorker(workerId);
    if (!worker?.worker_update_capable) return;
    const onTarget = worker.worker_version === REMOTE_WORKER_TARGET_VERSION
      && worker.worker_release === REMOTE_WORKER_TARGET_REF
      && worker.worker_commit === this.targetRelease.commit;
    if (onTarget) return;
    const current = this.db.getRemoteWorkerUpdate(workerId);
    if (current && ["queued", "dispatching", "updating"].includes(current.state)) return;
    if (current) {
      const updatedAt = Date.parse(current.updated_at);
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt < REMOTE_WORKER_AUTO_RETRY_COOLDOWN_MS) return;
    }
    this.db.requestRemoteWorkerUpdate(workerId, crypto.randomUUID(), REMOTE_WORKER_TARGET_VERSION, REMOTE_WORKER_TARGET_REF);
    this.emit("status", workerId);
    this.maybeDispatchWorkerUpdate(workerId);
  }

  private maybeDispatchWorkerUpdate(workerId: string): void {
    const update = this.db.getRemoteWorkerUpdate(workerId);
    if (!update || update.state !== "queued") return;
    const connection = this.connections.get(workerId);
    const worker = this.db.getRemoteWorker(workerId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || !connection.heartbeatSeen || !worker?.worker_update_capable) return;
    if (connection.activeJobs.size > 0 || worker.active_jobs > 0) return;
    if ([...this.pendingJobs.values()].some((job) => job.workerId === workerId)) return;
    if (this.db.countRunningJobsForExecutor(remoteExecutorId(workerId)) > 0) return;
    this.db.updateRemoteWorkerUpdate(workerId, "dispatching");
    this.send(connection.socket, {
      type: "worker_update", requestId: update.request_id,
      targetVersion: update.target_version, targetRef: update.target_ref,
    });
    this.emit("status", workerId);
  }

  private send(socket: WebSocket, message: ServerToRemoteWorker): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

function validStoredArtifact(value: unknown): value is StoredArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<StoredArtifact>;
  return typeof artifact.id === "string" && isTransferScopeId(artifact.id)
    && typeof artifact.name === "string" && artifact.name.length > 0 && artifact.name.length <= 500
    && typeof artifact.mimeType === "string" && artifact.mimeType.length <= 200
    && Number.isSafeInteger(artifact.size) && (artifact.size ?? -1) >= 0
    && typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/i.test(artifact.sha256)
    && typeof artifact.tempPath === "string" && artifact.tempPath.length > 0;
}

function validThreadSnapshot(thread: RemoteThreadSnapshot): boolean {
  return Boolean(
    thread
    && typeof thread.id === "string"
    && thread.id.length > 0
    && thread.id.length <= 200
    && typeof thread.name === "string"
    && thread.name.length <= 500
    && (thread.nameSource === undefined || ["explicit", "preview", "fallback"].includes(thread.nameSource))
    && Number.isFinite(thread.createdAt)
    && Number.isFinite(thread.updatedAt)
    && ["idle", "running"].includes(thread.status)
    && Array.isArray(thread.messages)
    && thread.messages.length <= 5_000
    && thread.messages.every((item) => item
      && typeof item.turnId === "string"
      && item.turnId.length <= 200
      && typeof item.itemId === "string"
      && item.itemId.length <= 200
      && ["user", "assistant"].includes(item.role)
      && typeof item.content === "string"
      && item.content.length <= 2_000_000
      && typeof item.createdAt === "string"
      && item.createdAt.length <= 80)
    && Array.isArray(thread.activities)
    && thread.activities.length <= 5_000
    && thread.activities.every((activity) => activity
      && typeof activity.turnId === "string"
      && activity.turnId.length <= 200
      && typeof activity.itemId === "string"
      && activity.itemId.length <= 200
      && ["reasoning", "update", "command", "file", "search", "tool"].includes(activity.kind)
      && typeof activity.label === "string"
      && activity.label.length <= 1_000
      && (activity.detail === undefined || (typeof activity.detail === "string" && activity.detail.length <= 200_000))
      && (activity.files === undefined || (Array.isArray(activity.files)
        && activity.files.length <= 200
        && activity.files.every((file) => typeof file === "string" && file.length <= 2_000)))
      && typeof activity.createdAt === "string"
      && activity.createdAt.length <= 80)
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function websocketTextPayload(data: RawData, isBinary: boolean): { text: string; bytes: number } | null {
  if (isBinary) return null;
  const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
  return { text: buffer.toString("utf8"), bytes: buffer.byteLength };
}

function isTransferScopeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeTransferName(value: string, fallback: string): string {
  return path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180) || fallback;
}
