import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { WebSocket, type RawData } from "ws";
import { archiveThread, CodexExecution, CodexObserver, readProjectThreadPage, setThreadName } from "./codex-client.js";
import { projectFilesystem, resolveDirectory, resolveReadableFile } from "./filesystem.js";
import { ProjectSyncMonitor } from "./project-sync-monitor.js";
import { PROTOCOL_VERSION, type RunRequest, type ServerMessage, type WorkerEvent, type WorkerMessage, type WorkerUpdateResult } from "./protocol.js";
import { RuntimeManager } from "./runtime-manager.js";
import { WORKER_VERSION } from "./version.js";
import { hasCapacity, isValidCapacity, normalizeCapacity } from "./capacity.js";
import { cleanupCurrentRunDirectory, sweepRunDirectories } from "./run-directories.js";
import { DurableOutbox } from "./durable-outbox.js";
import { isPersistableWorkerMessage, MAX_PROTOCOL_ERRORS, parseServerMessage, SERVER_MESSAGE_MAX_BYTES, WORKER_MESSAGE_MAX_BYTES } from "./protocol-validation.js";
import { collectChangedFiles, type OmittedArtifact } from "./changed-files.js";
import { collectGeneratedImages, snapshotGeneratedImages } from "./generated-images.js";
import { buildRemoteSteerPrompt, buildRemoteTurnPrompt } from "./agent-context.js";
import { syncAccountSkills } from "./account-skills.js";
import { runConversationTitleAgent } from "./conversation-title-agent.js";
import { RemoteCodexAccountManager } from "./codex-accounts.js";

type Config = { serverWsUrl: string; serverHttpUrl: string; enrollmentToken: string; machineName: string; workerId: string; capacity: number; stateRoot?: string; codexRuntimePath?: string; sourceRoot?: string; workerUpdateTaskName?: string };
type ActiveRun = { request: RunRequest; controller: AbortController; execution?: CodexExecution; changedFiles: Set<string> };
type WorkerRelease = { version: string; ref: string | null; commit: string | null };
const execFileAsync = promisify(execFile);
const OUTBOX_ACTIVITY_BUDGET = 8 * 1024 * 1024;

const configPath = argument("--config") || path.join(process.env.LOCALAPPDATA || os.homedir(), "CodexWebWorker", "config.json");
const config = loadConfig(configPath);
const stateRoot = config.stateRoot || path.dirname(configPath);
const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
fs.mkdirSync(stateRoot, { recursive: true });
const runtimeManager = new RuntimeManager(stateRoot, config.codexRuntimePath);
await runtimeManager.refresh(false).catch((error) => log(`initial Codex catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`));
const lockPath = path.join(stateRoot, "worker.lock");
const workerReleasePath = path.join(stateRoot, "worker-release.json");
const workerUpdateRequestPath = path.join(stateRoot, "worker-update-request.json");
const workerUpdateResultPath = path.join(stateRoot, "worker-update-result.json");
const workerOnlinePath = path.join(stateRoot, "worker-online.json");
const outboxPath = path.join(stateRoot, "worker-outbox-v1.json");
const lock = acquireLock(lockPath);
const activeRuns = new Map<string, ActiveRun>();
const activeTitleAgents = new Map<string, AbortController>();
const codexAccounts = new RemoteCodexAccountManager({
  stateRoot,
  codexHome,
  codexExecutable: () => runtimeManager.activePath(),
  assertSwitchAllowed: () => {
    if (workerUpdateStarting || activeRuns.size > 0 || activeTitleAgents.size > 0 || projectSyncMonitor?.hasRunningThreads()) {
      throw new Error("目标机器仍有 Codex 任务执行，暂不能切换账号。");
    }
  },
});
const startupSweep = await sweepRunDirectories(stateRoot, new Set(activeRuns.keys()));
if (startupSweep.removed.length) log(`removed ${startupSweep.removed.length} stale run director${startupSweep.removed.length === 1 ? "y" : "ies"}`);
for (const failure of startupSweep.failed) log(`stale run cleanup failed (${failure.jobId}): ${failure.message}`);
const outbox = new DurableOutbox(outboxPath, log);
let socket: WebSocket | null = null;
let authenticated = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1_000;
let shuttingDown = false;
let workerUpdateStarting = false;
let watchedProjects: Array<{ id: string; rootPath: string }> = [];
let projectSyncMonitor: ProjectSyncMonitor | null = null;
let projectSyncRestartTimer: ReturnType<typeof setTimeout> | null = null;
const runtimeRefreshTimer = setInterval(() => void refreshRuntime(true), 12 * 60 * 60 * 1000);
runtimeRefreshTimer.unref();

log(`starting ${config.machineName} (${config.workerId}) with Codex ${runtimeManager.snapshot().installedVersion}`);
connect();

function connect(): void {
  if (shuttingDown) return;
  authenticated = false;
  let protocolErrors = 0;
  socket = new WebSocket(config.serverWsUrl, { handshakeTimeout: 15_000, maxPayload: SERVER_MESSAGE_MAX_BYTES });
  socket.on("open", () => sendNow({
    type: "hello", protocolVersion: PROTOCOL_VERSION, workerId: config.workerId, machineName: config.machineName,
    enrollmentToken: config.enrollmentToken, platform: `${process.platform}-${process.arch}`,
    workerVersion: WORKER_VERSION, workerRelease: workerRelease().ref, workerCommit: workerRelease().commit,
    capabilities: { workerUpdate: Boolean(config.workerUpdateTaskName), waitAutomation: true, capacityConfig: true, dynamicWaitTool: true, agentTurnContext: true, accountSkills: true, titleAgent: true, codexAccounts: true },
    codexVersion: runtimeManager.snapshot().installedVersion, capacity: config.capacity,
  }));
  socket.on("message", (data, isBinary) => {
    const payload = websocketTextPayload(data, isBinary);
    if (!payload || payload.bytes > SERVER_MESSAGE_MAX_BYTES) {
      socket?.close(payload ? 1009 : 1003, payload ? "message too large" : "text messages required");
      return;
    }
    const parsed = parseServerMessage(payload.text);
    if (!parsed.ok) {
      protocolErrors += 1;
      log(`rejected invalid server protocol message (${parsed.reason}, ${protocolErrors}/${MAX_PROTOCOL_ERRORS})`);
      if (authenticated) send({ type: "request_failed", message: "服务器下发的 Worker 消息格式无效" });
      if (protocolErrors >= MAX_PROTOCOL_ERRORS) socket?.close(1008, "invalid protocol message");
      return;
    }
    void handle(parsed.message);
  });
  socket.on("close", (code, reason) => {
    authenticated = false;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    log(`connection closed (${code} ${reason.toString() || "no reason"}); reconnecting`);
    if (!shuttingDown) setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(30_000, reconnectDelay * 2);
  });
  socket.on("error", (error) => log(`connection error: ${error.message}`));
}

async function handle(message: ServerMessage): Promise<void> {
  if (message.type === "authenticated") {
    authenticated = true;
    reconnectDelay = 1_000;
    if (message.workerId !== config.workerId) throw new Error("server returned a different worker id");
    flushOutbox();
    const release = workerRelease();
    writeJsonAtomically(workerOnlinePath, { version: release.version, ref: release.ref, commit: release.commit, authenticatedAt: new Date().toISOString() });
    sendPendingWorkerUpdateResult();
    send({ type: "heartbeat", activeJobs: [...activeRuns.keys()] });
    send({ type: "runtime_status", ...runtimeManager.snapshot() });
    void refreshRuntime(true, undefined, false);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      sendPendingWorkerUpdateResult();
      send({ type: "heartbeat", activeJobs: [...activeRuns.keys()] });
    }, Math.max(5_000, message.heartbeatIntervalMs));
    log("authenticated and online");
    return;
  }
  if (message.type === "heartbeat_ack") return;
  if (message.type === "project_watch") {
    watchedProjects = message.projects;
    startProjectSyncMonitor();
    return;
  }
  if (message.type === "worker_update_result_ack") {
    const result = readJson<WorkerUpdateResult>(workerUpdateResultPath);
    if (result?.requestId === message.requestId) fs.rmSync(workerUpdateResultPath, { force: true });
    return;
  }
  if (message.type === "worker_update") {
    void beginWorkerUpdate(message);
    return;
  }
  if (message.type === "worker_config") {
    if (!isValidCapacity(message.capacity)) {
      send({ type: "worker_config_result", requestId: message.requestId, ok: false, message: "并发容量必须是 0 到 8 的整数；0 表示不限并发" });
      return;
    }
    try {
      updateConfigCapacity(configPath, message.capacity);
      config.capacity = message.capacity;
      send({ type: "worker_config_result", requestId: message.requestId, ok: true, capacity: config.capacity });
      send({ type: "heartbeat", activeJobs: [...activeRuns.keys()] });
    } catch (error) {
      send({ type: "worker_config_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "并发容量保存失败" });
    }
    return;
  }
  if (message.type === "codex_accounts") {
    try {
      let state;
      let login;
      let restart = false;
      if (message.action === "list") state = codexAccounts.listAccounts();
      else if (message.action === "login_start") login = codexAccounts.beginLogin(message.label ?? "");
      else if (message.action === "login_status") login = codexAccounts.loginStatus(message.loginId ?? "");
      else if (message.action === "login_cancel") login = codexAccounts.cancelLogin(message.loginId ?? "");
      else if (message.action === "activate") { state = codexAccounts.activate(message.accountId ?? ""); restart = true; }
      else if (message.action === "delete") state = codexAccounts.delete(message.accountId ?? "");
      const response: Extract<WorkerMessage, { type: "codex_accounts_result" }> = {
        type: "codex_accounts_result", requestId: message.requestId, ok: true,
      };
      if (state !== undefined) response.state = state;
      if (login !== undefined) response.login = login;
      if (restart) response.restart = true;
      send(response);
      if (restart) setTimeout(() => shutdown(75), 1_000).unref();
    } catch (error) {
      send({ type: "codex_accounts_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "Codex 账号操作失败" });
    }
    return;
  }
  if (message.type === "runtime_refresh") {
    void refreshRuntime(message.checkLatest, message.requestId, true);
    return;
  }
  if (message.type === "codex_upgrade") {
    if (activeRuns.size > 0 || activeTitleAgents.size > 0) {
      send({ type: "codex_upgrade_result", requestId: message.requestId, ok: false, message: "目标机器仍有任务执行，暂不能升级 Codex" });
      return;
    }
    void runtimeManager.upgrade(message.version, activeRuns.size).then((runtime) => {
      send({ type: "codex_upgrade_result", requestId: message.requestId, ok: true, runtime });
      setTimeout(() => shutdown(75), 1_000).unref();
    }, (error) => send({ type: "codex_upgrade_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "Codex 升级失败" }));
    return;
  }
  if (message.type === "project_fs") {
    try {
      const result = projectFilesystem(message.action, message.path, message.name, message.content);
      send({ type: "project_fs_result", requestId: message.requestId, ...result });
    } catch (error) { send({ type: "request_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "文件夹操作失败" }); }
    return;
  }
  if (message.type === "run") { void startRun(message.request); return; }
  if (message.type === "cancel") { const run = activeRuns.get(message.jobId); run?.controller.abort(); run?.execution?.interrupt(); return; }
  if (message.type === "steer") {
    void steerRun(message);
    return;
  }
  if (message.type === "thread_rename") {
    void setThreadName(message.threadId, message.name).then(
      () => send({ type: "thread_rename_result", requestId: message.requestId, ok: true }),
      (error) => send({ type: "thread_rename_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "改名失败" }),
    );
    return;
  }
  if (message.type === "thread_archive") {
    void archiveThread(message.threadId).then(
      () => send({ type: "thread_rename_result", requestId: message.requestId, ok: true }),
      (error) => send({ type: "thread_rename_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "归档失败" }),
    );
    return;
  }
  if (message.type === "thread_sync") {
    try {
      const projectRoot = resolveDirectory(message.projectRoot);
      const page = await readProjectThreadPage(projectRoot, message.cursor, message.limit);
      send({ type: "thread_sync_result", requestId: message.requestId, ...page });
    } catch (error) {
      send({ type: "request_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "Codex 任务同步失败" });
    }
    return;
  }
  if (message.type === "file_fetch") { void fetchProjectFile(message); return; }
  if (message.type === "title_agent") {
    if (activeTitleAgents.has(message.requestId)) return;
    if (workerUpdateStarting) { send({ type: "title_agent_result", requestId: message.requestId, ok: false, message: "Worker 已进入升级准备阶段" }); return; }
    const controller = new AbortController();
    activeTitleAgents.set(message.requestId, controller);
    void runConversationTitleAgent(message.prompt, message.timeoutMs, controller.signal).then(
      (output) => send({ type: "title_agent_result", requestId: message.requestId, ok: true, output }),
      (error) => send({ type: "title_agent_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "Codex title request failed" }),
    ).finally(() => activeTitleAgents.delete(message.requestId));
    return;
  }
}

async function fetchProjectFile(message: Extract<ServerMessage, { type: "file_fetch" }>): Promise<void> {
  try {
    const file = resolveReadableFile(message.projectRoot, message.path);
    const response = await uploadFile(
      `${config.serverHttpUrl}/api/remote-worker-files/fetch/${encodeURIComponent(message.requestId)}`,
      message.transferToken,
      file.path,
      file.name,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`文件回传失败（${response.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`);
    }
    send({ type: "file_fetch_result", requestId: message.requestId, ok: true });
  } catch (error) {
    send({ type: "file_fetch_result", requestId: message.requestId, ok: false, message: error instanceof Error ? error.message : "文件获取失败" });
  }
}

async function steerRun(message: Extract<ServerMessage, { type: "steer" }>): Promise<void> {
  const run = activeRuns.get(message.jobId);
  if (!run?.execution) {
    sendEvent(message.jobId, { type: "steer_failed", requestId: message.requestId, message: "当前任务尚未开始或已经结束" });
    return;
  }
  try {
    const uploadRoot = path.join(stateRoot, "runs", message.jobId, "uploads");
    fs.mkdirSync(uploadRoot, { recursive: true });
    const localAttachments: Array<{ name: string; path: string; mimeType: string }> = [];
    for (const attachment of message.attachments) {
      const destination = path.join(uploadRoot, `${message.requestId}-${attachment.id}-${safeFileName(attachment.name)}`);
      await downloadFile(
        `${config.serverHttpUrl}${attachment.downloadPath}`,
        message.transferToken,
        destination,
        attachment.size,
        run.controller.signal,
      ).catch((error) => {
        throw new Error(`补充附件下载失败：${attachment.name}（${error instanceof Error ? error.message : String(error)}）`);
      });
      localAttachments.push({ name: attachment.name, path: destination, mimeType: attachment.mimeType });
    }
    const steerInput = message.turnContext
      ? buildRemoteSteerPrompt(message.turnContext.userPrompt, localAttachments, message.turnContext.imageInput)
      : buildRemoteSteerPrompt(message.prompt, localAttachments, "preload");
    const turnId = await run.execution.steer(steerInput.prompt, steerInput.imagePaths);
    sendEvent(message.jobId, { type: "steer_completed", requestId: message.requestId, turnId });
  } catch (error) {
    sendEvent(message.jobId, { type: "steer_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "引导失败" });
  }
}

async function startRun(request: RunRequest): Promise<void> {
  if (activeRuns.has(request.jobId)) return;
  if (workerUpdateStarting) { sendEvent(request.jobId, { type: "failed", message: "Worker 已进入升级准备阶段，请等待节点重连" }); return; }
  if (!hasCapacity(activeRuns.size, config.capacity)) { sendEvent(request.jobId, { type: "failed", message: "远程电脑并发容量已满" }); return; }
  const controller = new AbortController();
  const run: ActiveRun = { request, controller, changedFiles: new Set() };
  let deferredFailure: Extract<WorkerEvent, { type: "failed" }> | undefined;
  activeRuns.set(request.jobId, run);
  send({ type: "heartbeat", activeJobs: [...activeRuns.keys()] });
  try {
    if (request.accountSkills) syncAccountSkills(codexHome, request.accountSkills);
    const projectRoot = resolveDirectory(request.projectRoot);
    const uploadRoot = path.join(stateRoot, "runs", request.jobId, "uploads");
    fs.mkdirSync(uploadRoot, { recursive: true });
    const localAttachments: Array<{ name: string; path: string; mimeType: string }> = [];
    for (const attachment of request.attachments) {
      const destination = path.join(uploadRoot, `${attachment.id}-${safeFileName(attachment.name)}`);
      await downloadFile(
        `${config.serverHttpUrl}${attachment.downloadPath}`,
        request.transferToken,
        destination,
        attachment.size,
        controller.signal,
      ).catch((error) => {
        throw new Error(`附件下载失败：${attachment.name}（${error instanceof Error ? error.message : String(error)}）`);
      });
      localAttachments.push({ name: attachment.name, path: destination, mimeType: attachment.mimeType });
    }
    const turnInput = buildRemoteTurnPrompt(request, localAttachments);
    const generatedImagesBeforeThreadId = request.codexThreadId;
    const generatedImagesBefore = generatedImagesBeforeThreadId
      ? await snapshotGeneratedImages(codexHome, generatedImagesBeforeThreadId)
      : new Map<string, string>();
    let generatedImageThreadId = generatedImagesBeforeThreadId;
    run.execution = new CodexExecution({
      cwd: projectRoot, threadId: request.codexThreadId, prompt: turnInput.prompt,
      imagePaths: turnInput.imagePaths, model: request.selection.model, reasoningEffort: request.selection.reasoningEffort,
      optionalCapabilities: request.optionalCapabilities,
      automation: request.automation ? {
        baseUrl: config.serverHttpUrl, token: request.automation.token, jobId: request.jobId,
        receiptDirectory: path.join(stateRoot, "wake-receipts"), dynamicTool: request.automation.dynamicTool === true,
      } : undefined,
    }, {
      signal: controller.signal,
      onThreadStarted: (threadId) => { generatedImageThreadId = threadId; sendEvent(request.jobId, { type: "thread_started", threadId }); },
      onContextUsage: (usage) => sendEvent(request.jobId, { type: "context_usage", usage }),
      onQuotaUsage: (usage) => sendEvent(request.jobId, { type: "quota_usage", usage }),
      onProgress: (payload) => sendEvent(request.jobId, { type: "progress", payload }),
      onChangedFile: (filePath) => run.changedFiles.add(filePath),
    });
    const finalResponse = await run.execution.result;
    const changed = await uploadChangedFiles(run, projectRoot);
    const generated = !changed.hasUploadedImage && generatedImageThreadId
      ? await collectGeneratedImages(
        codexHome,
        generatedImageThreadId,
        generatedImagesBeforeThreadId === generatedImageThreadId ? generatedImagesBefore : new Map(),
        async (realPath, name) => uploadResultFile(run, realPath, name),
        { maximumFiles: Math.max(0, 20 - changed.uploaded) },
      )
      : { uploaded: 0, omitted: [] };
    const omittedArtifacts = [...changed.omitted, ...generated.omitted].slice(0, 100);
    sendEvent(request.jobId, { type: "completed", finalResponse, omittedArtifacts });
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    deferredFailure = { type: "failed", message: cancelled ? "任务已停止" : error instanceof Error ? error.message : "远程任务失败", cancelled };
  } finally {
    try { await cleanupCurrentRunDirectory(stateRoot, request.jobId); }
    catch (error) { log(`run directory cleanup failed (${request.jobId}): ${error instanceof Error ? error.message : String(error)}`); }
    activeRuns.delete(request.jobId);
    send({ type: "heartbeat", activeJobs: [...activeRuns.keys()] });
    // Report failure only after the same Job ID can be accepted again. The
    // server may intentionally redispatch capacity failures after a delay.
    if (deferredFailure) sendEvent(request.jobId, deferredFailure);
  }
}

async function uploadChangedFiles(run: ActiveRun, projectRoot: string): Promise<{ uploaded: number; hasUploadedImage: boolean; omitted: OmittedArtifact[] }> {
  const result = await collectChangedFiles(projectRoot, run.changedFiles, async (realPath, name) => {
    await uploadResultFile(run, realPath, name);
  });
  return result;
}

async function uploadResultFile(run: ActiveRun, realPath: string, name: string): Promise<void> {
  const response = await uploadFile(
    `${config.serverHttpUrl}/api/remote-worker-files/${encodeURIComponent(run.request.jobId)}/output`,
    run.request.transferToken,
    realPath,
    name,
  );
  if (!response.ok) throw new Error(`结果文件上传失败：${name} (${response.status})`);
}

async function uploadFile(url: string, transferToken: string, filePath: string, name: string): Promise<Response> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size < 0 || stat.size > 100 * 1024 * 1024) throw new Error("文件大小不符合远程传输限制");
  const body = fs.createReadStream(filePath);
  try {
    return await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${transferToken}`,
        "content-type": mimeType(name),
        "content-length": String(stat.size),
        "x-file-name": encodeURIComponent(name),
      },
      body: body as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } finally {
    if (!body.destroyed) body.destroy();
  }
}

async function downloadFile(url: string, transferToken: string, destination: string, expectedSize: number, signal: AbortSignal): Promise<{ size: number; sha256: string }> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 100 * 1024 * 1024) throw new Error("附件声明大小无效");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${transferToken}`, "accept-encoding": "identity" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (!declared || !/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) !== expectedSize) throw new Error("Content-Length 与附件清单不一致");
  const temporary = path.join(path.dirname(destination), `${crypto.randomUUID()}.part`);
  let size = 0;
  const hash = crypto.createHash("sha256");
  const counter = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      size += bytes.length;
      if (size > expectedSize) { callback(new Error("实际附件超过声明大小")); return; }
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  try {
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      counter,
      fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (size !== expectedSize) throw new Error("实际附件大小与声明不一致");
    await fs.promises.rename(temporary, destination);
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sendEvent(jobId: string, event: Extract<WorkerMessage, { type: "event" }>["event"]): void { send({ type: "event", jobId, event }); }
async function refreshRuntime(checkLatest: boolean, requestId?: string, forceLatest = false): Promise<void> {
  try {
    const runtime = await runtimeManager.refresh(checkLatest, forceLatest);
    send(requestId === undefined ? { type: "runtime_status", ...runtime } : { type: "runtime_status", requestId, ...runtime });
  }
  catch (error) {
    if (requestId) send({ type: "request_failed", requestId, message: error instanceof Error ? error.message : "Codex 信息刷新失败" });
    else log(`Codex runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function send(message: WorkerMessage): void {
  if (!authenticated || !socket || socket.readyState !== WebSocket.OPEN) {
    if (message.type === "thread_activity") {
      const existing = outbox.findIndex((queued) => queued.type === "thread_activity"
        && queued.projectId === message.projectId
        && queued.thread.id === message.thread.id);
      if (existing >= 0) {
        const queued = outbox.at(existing) as Extract<WorkerMessage, { type: "thread_activity" }>;
        const merged: Extract<WorkerMessage, { type: "thread_activity" }> = {
          ...message,
          thread: {
            ...message.thread,
            messages: mergeThreadItems(queued.thread.messages, message.thread.messages),
            activities: mergeThreadItems(queued.thread.activities, message.thread.activities),
          },
        };
        if (Buffer.byteLength(JSON.stringify(merged), "utf8") <= OUTBOX_ACTIVITY_BUDGET) {
          if (outbox.replace(existing, merged).accepted) return;
        }
      }
    }
    const result = outbox.enqueue(message);
    if (!result.accepted) log(`discarded ${message.type} because it is ${result.reason === "oversize" ? "too large" : "not protocol-valid"}`);
    return;
  }
  sendNow(message);
}
function sendNow(message: WorkerMessage): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (message.type !== "hello" && !isPersistableWorkerMessage(message as unknown)) {
    log(`refused to send protocol-invalid ${message.type} message`);
    return;
  }
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body, "utf8") > WORKER_MESSAGE_MAX_BYTES) {
    log(`refused to send oversized ${message.type} message`);
    return;
  }
  socket.send(body, (error) => { if (error) log(`WebSocket send failed (${message.type}): ${error.message}`); });
}
function flushOutbox(): void {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return;
  try {
    const flushed = outbox.flush(sendNow);
    if (flushed) log(`replayed ${flushed} durable outbox message${flushed === 1 ? "" : "s"}`);
  } catch (error) { log(`durable outbox replay failed: ${error instanceof Error ? error.message : String(error)}`); }
}
function mergeThreadItems<T extends { turnId: string; itemId: string }>(previous: T[], current: T[]): T[] {
  const items = new Map<string, T>();
  for (const item of [...previous, ...current]) items.set(`${item.turnId}\u0000${item.itemId}`, item);
  return [...items.values()];
}

function startProjectSyncMonitor(): void {
  if (shuttingDown) return;
  if (projectSyncRestartTimer) {
    clearTimeout(projectSyncRestartTimer);
    projectSyncRestartTimer = null;
  }
  projectSyncMonitor?.close();
  projectSyncMonitor = null;
  if (watchedProjects.length === 0) return;
  const observer = new CodexObserver((error) => {
    log(`Codex observer stopped: ${error.message}; restarting`);
    projectSyncMonitor?.close();
    projectSyncMonitor = null;
    if (!shuttingDown) {
      projectSyncRestartTimer = setTimeout(startProjectSyncMonitor, 5_000);
      projectSyncRestartTimer.unref();
    }
  }, (usage) => send({ type: "quota_usage", usage, accountId: codexAccounts.activeAccountId() }));
  const monitor = new ProjectSyncMonitor(
    observer,
    (projectId, thread) => send({ type: "thread_activity", projectId, thread }),
    log,
  );
  projectSyncMonitor = monitor;
  void monitor.replaceProjects(watchedProjects);
}

async function beginWorkerUpdate(message: Extract<ServerMessage, { type: "worker_update" }>): Promise<void> {
  if (!config.workerUpdateTaskName) {
    send({ type: "worker_update_ack", requestId: message.requestId, accepted: false, message: "节点尚未安装独立更新计划任务" });
    return;
  }
  if (workerUpdateStarting || activeRuns.size > 0 || activeTitleAgents.size > 0) {
    send({ type: "worker_update_ack", requestId: message.requestId, accepted: false, message: "节点仍有任务执行或升级已经开始" });
    return;
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(message.targetVersion)
    || message.targetRef !== `remote-worker-v${message.targetVersion}`) {
    send({ type: "worker_update_ack", requestId: message.requestId, accepted: false, message: "服务器下发的 Worker 版本无效" });
    return;
  }
  workerUpdateStarting = true;
  writeJsonAtomically(workerUpdateRequestPath, {
    requestId: message.requestId, targetVersion: message.targetVersion, targetRef: message.targetRef,
    requestedAt: new Date().toISOString(),
  });
  try {
    await execFileAsync("schtasks.exe", ["/Run", "/TN", config.workerUpdateTaskName], { windowsHide: true });
    send({ type: "worker_update_ack", requestId: message.requestId, accepted: true });
  } catch (error) {
    workerUpdateStarting = false;
    fs.rmSync(workerUpdateRequestPath, { force: true });
    send({ type: "worker_update_ack", requestId: message.requestId, accepted: false, message: error instanceof Error ? error.message : "无法启动独立更新计划任务" });
  }
}

function workerRelease(): WorkerRelease {
  const release = readJson<Partial<WorkerRelease>>(workerReleasePath);
  return {
    version: typeof release?.version === "string" ? release.version : WORKER_VERSION,
    ref: typeof release?.ref === "string" ? release.ref : null,
    commit: typeof release?.commit === "string" ? release.commit : null,
  };
}

function sendPendingWorkerUpdateResult(): void {
  const result = readJson<WorkerUpdateResult>(workerUpdateResultPath);
  if (result?.requestId) send({ type: "worker_update_result", ...result });
}

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T; }
  catch { return null; }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try { fs.renameSync(temporary, filePath); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function updateConfigCapacity(filePath: string, capacity: number): void {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  parsed.capacity = capacity;
  writeJsonAtomically(filePath, parsed);
}

function loadConfig(filePath: string): Config {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as Partial<Config>;
  if (!parsed.serverWsUrl || !parsed.serverHttpUrl || !parsed.enrollmentToken || !parsed.machineName) throw new Error(`Worker config is incomplete: ${filePath}`);
  const config: Config = { serverWsUrl: parsed.serverWsUrl, serverHttpUrl: parsed.serverHttpUrl.replace(/\/$/, ""), enrollmentToken: parsed.enrollmentToken, machineName: parsed.machineName, workerId: parsed.workerId || crypto.randomUUID(), capacity: normalizeCapacity(parsed.capacity), stateRoot: parsed.stateRoot, codexRuntimePath: parsed.codexRuntimePath, sourceRoot: parsed.sourceRoot, workerUpdateTaskName: parsed.workerUpdateTaskName };
  if (!parsed.workerId) fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}
function acquireLock(filePath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(filePath, "wx");
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      return descriptor;
    } catch (error) {
      if (!(error instanceof Error) || !Object.hasOwn(error, "code") || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingPid = Number.parseInt(readLockPid(filePath), 10);
      if (existingPid > 0 && processExists(existingPid)) throw new Error(`Codex Web Remote Worker is already running (PID ${existingPid})`);
      fs.rmSync(filePath, { force: true });
    }
  }
  throw new Error("Unable to acquire the Codex Web Remote Worker lock");
}
function readLockPid(filePath: string): string { try { return fs.readFileSync(filePath, "utf8").trim(); } catch { return ""; } }
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function safeFileName(value: string): string { return path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 160) || "attachment.bin"; }
function mimeType(name: string): string { const ext = path.extname(name).toLowerCase(); return ({ ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip": "application/zip" } as Record<string, string>)[ext] || "application/octet-stream"; }
function log(message: string): void { process.stdout.write(`[${new Date().toISOString()}] ${message}\n`); }
function shutdown(exitCode = 0): void { if (shuttingDown) return; shuttingDown = true; if (heartbeat) clearInterval(heartbeat); if (projectSyncRestartTimer) clearTimeout(projectSyncRestartTimer); projectSyncMonitor?.close(); codexAccounts.close(); for (const run of activeRuns.values()) { run.controller.abort(); run.execution?.interrupt(); } for (const controller of activeTitleAgents.values()) controller.abort(); try { outbox.persist(); } catch (error) { log(`durable outbox persist failed during shutdown: ${error instanceof Error ? error.message : String(error)}`); } socket?.close(1000, "shutdown"); fs.closeSync(lock); fs.rmSync(lockPath, { force: true }); setTimeout(() => process.exit(exitCode), 500).unref(); }
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("exit", () => { try { fs.closeSync(lock); } catch { /* already closed */ } try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ } });

function websocketTextPayload(data: RawData, isBinary: boolean): { text: string; bytes: number } | null {
  if (isBinary) return null;
  const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
  return { text: buffer.toString("utf8"), bytes: buffer.byteLength };
}
