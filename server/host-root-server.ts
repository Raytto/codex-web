import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { HOST_ROOT_USER_ID } from "./host-root-user.js";
import type { HostRootClientMessage, HostRootExecutionRequest, HostRootJobInput, HostRootRunRequest, HostRootServerMessage } from "./host-root-protocol.js";
import { isOptionalAgentCapabilities } from "./optional-capabilities.js";
import { codexThreadRolloutBytes, removeCodexThreadFiles } from "./paths.js";
import type { TenantWorkerEvent } from "./tenant-worker-protocol.js";
import { buildHostThreadInstructions } from "./agent-context.js";
import { installProjectInstructions } from "./project-instructions.js";
import { syncManagedSkills } from "./managed-skills.js";
import { ensureAccountSkillLibrary, isAccountSkillBundle, loadAccountSkillBundle, syncAccountSkills } from "./account-skills.js";
import { agentOptionsFromAppServer, type AgentOptions, type ExecutorRuntimeStatus } from "./model-options.js";
import { cleanupJobRuntime, jobRuntimeRoot } from "./python-runtime.js";
import { acquireSharedCodexAuth, sharedCodexAuthPolicyFromEnv } from "./shared-codex-auth.js";
import { validateCodexVoiceReviewRequest, type CodexVoiceReviewWorkerEvent } from "./codex-voice-review.js";
import { validateConversationTitleRequest, type ConversationTitleWorkerEvent } from "./conversation-title.js";
import { CodexAccountManager } from "./codex-account-manager.js";
import { defaultColdStorageRoots, restoreColdConversation } from "./conversation-cold-storage.js";

const socketPath = process.env.CODEX_WEB_HOST_SOCKET_PATH?.trim() || "";
const hostTenantRoot = path.resolve(process.env.CODEX_WEB_HOST_TENANT_ROOT?.trim() || "");
const knowledgeRoot = path.resolve(process.env.CODEX_WEB_KNOWLEDGE_ROOT?.trim() || "");
const codexHome = path.resolve(process.env.CODEX_WEB_CODEX_HOME?.trim() || "");
const webUid = Number(process.env.CODEX_WEB_WEB_UID || "10001");
const webGid = Number(process.env.CODEX_WEB_WEB_GID || "10001");
const workers = new Map<string, { child: ChildProcess; socket: Socket; workspace: string; runtimeRoot: string; terminal: boolean; timers: NodeJS.Timeout[] }>();
const voiceReviewWorkers = new Map<string, ChildProcess>();
const titleAgentWorkers = new Map<string, ChildProcess>();
let stopping = false;

if (!socketPath || !process.env.CODEX_WEB_HOST_TENANT_ROOT || !process.env.CODEX_WEB_KNOWLEDGE_ROOT || !process.env.CODEX_WEB_CODEX_HOME) {
  throw new Error("Host bridge is disabled until CODEX_WEB_HOST_SOCKET_PATH, CODEX_WEB_HOST_TENANT_ROOT, CODEX_WEB_KNOWLEDGE_ROOT, and CODEX_WEB_CODEX_HOME are configured");
}
if (process.platform !== "win32" && process.getuid?.() !== 0) throw new Error("CODEX_WEB host bridge must run as root");
for (const directory of [hostTenantRoot, knowledgeRoot, codexHome]) {
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Required CODEX_WEB host directory is unavailable: ${directory}`);
}
syncManagedSkills(codexHome);
const hostLibraryRoot = path.join(hostTenantRoot, HOST_ROOT_USER_ID, "library");
ensureAccountSkillLibrary(hostLibraryRoot, HOST_ROOT_USER_ID);
syncAccountSkills(codexHome, loadAccountSkillBundle(hostLibraryRoot));
const sharedAuthPolicy = sharedCodexAuthPolicyFromEnv();
if (!sharedAuthPolicy) throw new Error("CODEX_WEB host bridge requires shared Codex authentication");
const sharedAuthRoot = path.dirname(path.dirname(sharedAuthPolicy.sourceFile));
const codexAccountManager = new CodexAccountManager({
  authorityFile: sharedAuthPolicy.sourceFile,
  lockFile: sharedAuthPolicy.lockFile,
  policyFile: process.env.CWW_SHARED_CODEX_AUTH_POLICY_FILE || path.join(sharedAuthRoot, "policy.json"),
  codexExecutable: process.env.CODEX_RUNTIME_PATH || "codex",
  assertSwitchAllowed: assertCodexAccountSwitchAllowed,
});
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });

const server = net.createServer((socket) => handleConnection(socket));
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o660);
  if (process.platform !== "win32") fs.chownSync(socketPath, 0, webGid);
  process.stdout.write(`CODEX_WEB host bridge listening on ${socketPath}\n`);
});

server.on("error", (error) => {
  process.stderr.write(`CODEX_WEB host bridge error: ${error.message}\n`);
  process.exitCode = 1;
});

function handleConnection(socket: Socket): void {
  let activeJobId: string | null = null;
  const input = readline.createInterface({ input: socket, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (Buffer.byteLength(line, "utf8") > 2_000_000) {
      send(socket, { type: "request_failed", message: "Host request is too large" });
      socket.destroy();
      return;
    }
    let message: HostRootClientMessage;
    try { message = JSON.parse(line) as HostRootClientMessage; }
    catch {
      send(socket, { type: "request_failed", message: "Invalid host request" });
      socket.destroy();
      return;
    }
    try {
      if (message.type === "run") {
        if (activeJobId) throw new Error("A host job is already attached to this connection");
        activeJobId = startWorker(socket, message.request);
        return;
      }
      if (message.type === "delete_thread") {
        if (activeJobId) throw new Error("Cannot delete a thread through an active job connection");
        validateHostUser(message.userId);
        if (!/^[0-9a-f-]{20,80}$/i.test(message.threadId)) throw new Error("Invalid Codex thread id");
        const removed = removeCodexThreadFiles(codexHome, message.threadId);
        send(socket, { type: "delete_thread_result", requestId: message.requestId, removed });
        socket.end();
        return;
      }
      if (message.type === "thread_rollout_size") {
        if (activeJobId) throw new Error("Cannot inspect a thread through an active job connection");
        validateHostUser(message.userId);
        const bytes = codexThreadRolloutBytes(codexHome, message.threadId);
        send(socket, { type: "thread_rollout_size_result", requestId: message.requestId, bytes });
        socket.end();
        return;
      }
      if (message.type === "restore_cold_conversation") {
        if (activeJobId) throw new Error("Cannot restore cold conversation through an active job connection");
        if (!/^[0-9a-f-]{36}$/i.test(message.userId) || !/^[0-9a-f-]{36}$/i.test(message.conversationId)) throw new Error("Invalid cold conversation identity");
        const roots = defaultColdStorageRoots({
          databasePath: process.env.CWW_DATABASE_PATH || path.join(process.cwd(), ".state", "data", "codex-web.sqlite"),
          tenantRoot: hostTenantRoot,
          hostRootCodexHome: codexHome,
          dataRoot: path.dirname(process.env.CWW_DATABASE_PATH || path.join(process.cwd(), ".state", "data", "codex-web.sqlite")),
        });
        void Promise.resolve().then(() => restoreColdConversation(roots, message.conversationId, message.userId)).then(
          () => { send(socket, { type: "restore_cold_conversation_result", requestId: message.requestId, conversationId: message.conversationId, restored: true }); socket.end(); },
          (error) => { send(socket, { type: "request_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "冷存储恢复失败" }); socket.end(); },
        );
        return;
      }
      if (message.type === "project_fs") {
        if (activeJobId) throw new Error("Cannot browse folders through an active job connection");
        validateHostUser(message.userId);
        const result = handleProjectFs(message.action, message.path, message.name, message.content);
        send(socket, { type: "project_fs_result", requestId: message.requestId, ...result });
        socket.end();
        return;
      }
      if (message.type === "runtime_status") {
        if (activeJobId) throw new Error("Cannot inspect Codex through an active job connection");
        validateHostUser(message.userId);
        void readHostRuntime(message.checkLatest).then(
          (runtime) => { send(socket, { type: "runtime_status_result", requestId: message.requestId, ...runtime }); socket.end(); },
          (error) => { send(socket, { type: "request_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "Codex 信息读取失败" }); socket.end(); },
        );
        return;
      }
      if (message.type === "cleanup_runtimes") {
        if (activeJobId) throw new Error("Cannot clean runtimes through an active job connection");
        validateHostUser(message.userId);
        if (!Array.isArray(message.targets) || message.targets.length > 10_000) throw new Error("Invalid host runtime cleanup batch");
        let removed = 0;
        let absent = 0;
        const failed: Array<{ jobId: string; message: string }> = [];
        for (const target of message.targets) {
          try {
            if (workers.has(target.jobId)) throw new Error("Runtime still belongs to an active job");
            const runtimeRoot = jobRuntimeRoot(hostTenantRoot, {
              userId: HOST_ROOT_USER_ID,
              conversationId: target.conversationId,
              jobId: target.jobId,
            });
            const result = cleanupJobRuntime(runtimeRoot);
            if (result.status === "removed") removed += 1;
            else if (result.status === "absent") absent += 1;
            else failed.push({ jobId: target.jobId, message: result.error?.message ?? "Runtime cleanup failed" });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            process.stderr.write(`Host runtime cleanup validation failed for ${target.jobId}: ${detail}\n`);
            failed.push({ jobId: target.jobId, message: detail });
          }
        }
        send(socket, { type: "cleanup_runtimes_result", requestId: message.requestId, removed, absent, failed });
        socket.end();
        return;
      }
      if (message.type === "voice_review") {
        if (activeJobId) throw new Error("Cannot review voice lexicon through an active job connection");
        validateHostUser(message.request.userId);
        validateCodexVoiceReviewRequest(message.request, HOST_ROOT_USER_ID);
        void startVoiceReview(socket, message.requestId, message.request);
        return;
      }
      if (message.type === "title_agent") {
        if (activeJobId) throw new Error("Cannot run title agent through an active job connection");
        validateHostUser(message.request.userId);
        validateConversationTitleRequest(message.request, HOST_ROOT_USER_ID);
        void startTitleAgent(socket, message.requestId, message.request);
        return;
      }
      if (message.type === "codex_upgrade") {
        if (activeJobId || workers.size > 0 || voiceReviewWorkers.size > 0 || titleAgentWorkers.size > 0) throw new Error("CODEX_WEB 仍有任务执行，暂不能升级 Codex");
        validateHostUser(message.userId);
        if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(message.version)) throw new Error("目标 Codex 版本无效");
        void runCodexUpdater().then(async () => {
          const runtime = await readHostRuntime(true);
          if (runtime.installedVersion !== runtime.latestVersion) {
            throw new Error(`Codex 升级后版本未收敛：installed=${runtime.installedVersion} latest=${runtime.latestVersion ?? "unknown"}`);
          }
          send(socket, { type: "codex_upgrade_result", requestId: message.requestId, accepted: true, ...runtime });
          socket.end();
        }).catch((error) => {
          send(socket, { type: "request_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "Codex 升级失败" });
          socket.end();
        });
        return;
      }
      if (message.type === "codex_accounts_list") {
        if (activeJobId) throw new Error("Cannot manage Codex accounts through an active job connection");
        validateHostUser(message.userId);
        void codexAccountManager.listAccounts().then(
          (result) => { send(socket, { type: "codex_accounts_result", requestId: message.requestId, ...result }); socket.end(); },
          (error) => sendRequestFailure(socket, message.requestId, error),
        );
        return;
      }
      if (message.type === "codex_account_login_start") {
        if (activeJobId) throw new Error("Cannot manage Codex accounts through an active job connection");
        validateHostUser(message.userId);
        void codexAccountManager.beginLogin(message.label).then(
          (login) => { send(socket, { type: "codex_account_login_result", requestId: message.requestId, login }); socket.end(); },
          (error) => sendRequestFailure(socket, message.requestId, error),
        );
        return;
      }
      if (message.type === "codex_account_login_status" || message.type === "codex_account_login_cancel") {
        if (activeJobId) throw new Error("Cannot manage Codex accounts through an active job connection");
        validateHostUser(message.userId);
        const login = message.type === "codex_account_login_status"
          ? codexAccountManager.loginStatus(message.loginId)
          : codexAccountManager.cancelLogin(message.loginId);
        send(socket, { type: "codex_account_login_result", requestId: message.requestId, login });
        socket.end();
        return;
      }
      if (message.type === "codex_account_activate" || message.type === "codex_account_delete") {
        if (activeJobId) throw new Error("Cannot manage Codex accounts through an active job connection");
        validateHostUser(message.userId);
        const operation = message.type === "codex_account_activate"
          ? codexAccountManager.activate(message.accountId)
          : codexAccountManager.delete(message.accountId);
        void operation.then(
          (result) => { send(socket, { type: "codex_accounts_result", requestId: message.requestId, ...result }); socket.end(); },
          (error) => sendRequestFailure(socket, message.requestId, error),
        );
        return;
      }
      if (!activeJobId) throw new Error("No host job is attached to this connection");
      const worker = workers.get(activeJobId);
      if (!worker || !worker.child.stdin?.writable) throw new Error("当前任务已经结束");
      if (message.type === "cancel") {
        writeWorker(worker.child, { type: "cancel" });
        scheduleForcedCancellation(activeJobId, worker.child);
        return;
      }
      const prompt = validatePrompt(message.prompt);
      const imagePaths = message.imageRelativePaths.map((relativePath) => resolveWorkspaceFile(worker.workspace, relativePath));
      writeWorker(worker.child, { type: "steer", requestId: message.requestId, prompt, imagePaths });
    } catch (error) {
      send(socket, { type: "request_failed", requestId: "requestId" in message ? message.requestId : undefined, message: error instanceof Error ? error.message : "Host request failed" });
    }
  });
  socket.on("close", () => {
    input.close();
    if (!activeJobId) return;
    const worker = workers.get(activeJobId);
    if (!worker || worker.terminal) return;
    writeWorker(worker.child, { type: "cancel" });
    scheduleForcedCancellation(activeJobId, worker.child);
  });
}

async function startVoiceReview(socket: Socket, requestId: string, request: import("./codex-voice-review.js").CodexVoiceReviewRequest): Promise<void> {
  if (voiceReviewWorkers.has(requestId)) {
    send(socket, { type: "request_failed", requestId, message: "Duplicate Codex voice review request" });
    socket.end();
    return;
  }
  let lease: Awaited<ReturnType<typeof acquireSharedCodexAuth>> | null = null;
  try {
    const sharedAuthPolicy = sharedCodexAuthPolicyFromEnv();
    if (sharedAuthPolicy) {
      lease = await acquireSharedCodexAuth({
        sourceFile: sharedAuthPolicy.sourceFile,
        lockFile: sharedAuthPolicy.lockFile,
        targetFile: path.join(codexHome, "auth.json"),
      });
    }
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist-server", "server", "codex-voice-review-worker.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: "/root",
        CODEX_HOME: codexHome,
        CWW_TENANT_USER_ID: HOST_ROOT_USER_ID,
        CWW_TENANT_UID: String(process.getuid?.() ?? 0),
        CWW_TENANT_GID: String(process.getgid?.() ?? 0),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "inherit"],
    });
    voiceReviewWorkers.set(requestId, child);
    let terminal = false;
    const output = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const cancelOnDisconnect = () => {
      if (terminal || !child.pid) return;
      try { if (process.platform === "win32") child.kill("SIGTERM"); else process.kill(-child.pid, "SIGTERM"); } catch {}
    };
    socket.once("close", cancelOnDisconnect);
    const releaseAuth = async () => {
      const active = lease;
      lease = null;
      if (active) await active.commitAndRelease();
    };
    output.on("line", (line) => {
      let event: CodexVoiceReviewWorkerEvent;
      try { event = JSON.parse(line) as CodexVoiceReviewWorkerEvent; } catch { return; }
      if (event.type === "auth_ready") {
        void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for host voice review: ${error instanceof Error ? error.message : String(error)}\n`));
        return;
      }
      if (terminal) return;
      if (event.type === "completed") {
        terminal = true;
        send(socket, { type: "voice_review_result", requestId, output: event.output });
        socket.end();
      }
      if (event.type === "failed") {
        terminal = true;
        send(socket, { type: "request_failed", requestId, message: event.message });
        socket.end();
      }
    });
    child.once("error", (error) => {
      if (!terminal) { terminal = true; send(socket, { type: "request_failed", requestId, message: error.message }); socket.end(); }
    });
    child.once("exit", (code, signal) => {
      socket.removeListener("close", cancelOnDisconnect);
      output.close();
      voiceReviewWorkers.delete(requestId);
      void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for host voice review: ${error instanceof Error ? error.message : String(error)}\n`));
      if (!terminal) {
        terminal = true;
        send(socket, { type: "request_failed", requestId, message: `Codex voice review worker exited before completion (${signal ?? code ?? "unknown"})` });
        socket.end();
      }
    });
    child.stdin!.end(`${JSON.stringify(request)}\n`);
  } catch (error) {
    await lease?.releaseWithoutCommit();
    send(socket, { type: "request_failed", requestId, message: error instanceof Error ? error.message : "Codex voice review could not start" });
    socket.end();
  }
}

async function startTitleAgent(socket: Socket, requestId: string, request: import("./conversation-title.js").ConversationTitleAgentRequest): Promise<void> {
  if (titleAgentWorkers.has(requestId)) { send(socket, { type: "request_failed", requestId, message: "Duplicate Codex title request" }); socket.end(); return; }
  let lease: Awaited<ReturnType<typeof acquireSharedCodexAuth>> | null = null;
  try {
    const sharedAuthPolicy = sharedCodexAuthPolicyFromEnv();
    if (sharedAuthPolicy) lease = await acquireSharedCodexAuth({ sourceFile: sharedAuthPolicy.sourceFile, lockFile: sharedAuthPolicy.lockFile, targetFile: path.join(codexHome, "auth.json") });
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist-server", "server", "codex-conversation-title-worker.js")], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: "/root", CODEX_HOME: codexHome, CWW_TENANT_USER_ID: HOST_ROOT_USER_ID, CWW_TENANT_UID: String(process.getuid?.() ?? 0), CWW_TENANT_GID: String(process.getgid?.() ?? 0) },
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "inherit"],
    });
    titleAgentWorkers.set(requestId, child);
    let terminal = false;
    const output = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const cancelOnDisconnect = () => { if (!terminal && child.pid) { try { if (process.platform === "win32") child.kill("SIGTERM"); else process.kill(-child.pid, "SIGTERM"); } catch {} } };
    socket.once("close", cancelOnDisconnect);
    const releaseAuth = async () => { const active = lease; lease = null; if (active) await active.commitAndRelease(); };
    output.on("line", (line) => {
      let event: ConversationTitleWorkerEvent;
      try { event = JSON.parse(line) as ConversationTitleWorkerEvent; } catch { return; }
      if (event.type === "auth_ready") { void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for host title agent: ${error instanceof Error ? error.message : String(error)}\n`)); return; }
      if (terminal) return;
      if (event.type === "completed") { terminal = true; send(socket, { type: "title_agent_result", requestId, output: event.output }); socket.end(); }
      if (event.type === "failed") { terminal = true; send(socket, { type: "request_failed", requestId, message: event.message }); socket.end(); }
    });
    child.once("error", (error) => { if (!terminal) { terminal = true; send(socket, { type: "request_failed", requestId, message: error.message }); socket.end(); } });
    child.once("exit", (code, signal) => {
      socket.removeListener("close", cancelOnDisconnect); output.close(); titleAgentWorkers.delete(requestId);
      void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for host title agent: ${error instanceof Error ? error.message : String(error)}\n`));
      if (!terminal) { terminal = true; send(socket, { type: "request_failed", requestId, message: `Codex title worker exited before completion (${signal ?? code ?? "unknown"})` }); socket.end(); }
    });
    child.stdin!.end(`${JSON.stringify(request)}\n`);
  } catch (error) {
    await lease?.releaseWithoutCommit();
    send(socket, { type: "request_failed", requestId, message: error instanceof Error ? error.message : "Codex title request could not start" }); socket.end();
  }
}

function runCodexUpdater(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/systemctl", ["start", "codex-web-update-codex.service"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-8000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `Codex 升级服务失败（exit ${code ?? "unknown"}）`));
    });
  });
}

async function readHostRuntime(checkLatest: boolean): Promise<ExecutorRuntimeStatus> {
  const executable = process.env.CODEX_RUNTIME_PATH || "/usr/bin/codex";
  const versionOutput = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (versionOutput.status !== 0) throw new Error((versionOutput.stderr || "Codex 版本读取失败").trim());
  const installedVersion = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(versionOutput.stdout)?.[1] ?? versionOutput.stdout.trim();
  const now = new Date().toISOString();
  const [agentOptions, latestVersion] = await Promise.all([
    readHostAgentOptions(executable),
    checkLatest ? Promise.resolve(readLatestCodexVersion()) : Promise.resolve(null),
  ]);
  return {
    installedVersion, latestVersion, versionCheckedAt: checkLatest ? now : null,
    catalogUpdatedAt: now, updateState: "idle", updateError: null, agentOptions,
  };
}

function readLatestCodexVersion(): string {
  const result = spawnSync("npm", ["view", "@openai/codex", "dist-tags.latest", "--json", "--silent"], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error((result.stderr || "无法确认最新 Codex 版本").trim());
  const parsed = JSON.parse(result.stdout) as unknown;
  if (typeof parsed !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed)) throw new Error("最新 Codex 版本响应无效");
  return parsed;
}

async function readHostAgentOptions(executable: string): Promise<AgentOptions> {
  const policy = sharedCodexAuthPolicyFromEnv();
  const lease = policy ? await acquireSharedCodexAuth({
    sourceFile: policy.sourceFile,
    lockFile: policy.lockFile,
    targetFile: path.join(codexHome, "auth.json"),
  }) : null;
  try {
    return await new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], { env: { ...process.env, HOME: "/root", CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"] });
    const output = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let nextId = 1;
    let stderr = "";
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000); });
    output.on("line", (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || "Codex app-server request failed")); else request.resolve(message.result);
    });
    const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((requestResolve, requestReject) => {
      const id = nextId++; pending.set(id, { resolve: requestResolve, reject: requestReject });
      child.stdin?.write(`${JSON.stringify({ method, id, params })}\n`);
    });
    const finish = () => { output.close(); child.stdin?.end(); if (!child.killed) child.kill("SIGTERM"); };
    child.once("error", reject);
    void request("initialize", { clientInfo: { name: "codex-web-host-bridge", title: "Codex Web Host Bridge", version: "1.0.0" }, capabilities: { experimentalApi: true } })
      .then(() => {
        child.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
        return request("model/list", { includeHidden: false, limit: 100 });
      })
      .then((result) => {
        const options = agentOptionsFromAppServer(result);
        if (!options) throw new Error("Codex 未返回可用模型目录");
        resolve(options);
      })
      .catch((error) => reject(new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)))
      .finally(finish);
    });
  } finally {
    await lease?.commitAndRelease();
  }
}

function startWorker(socket: Socket, request: HostRootRunRequest): string {
  validateRunRequest(request);
  syncAccountSkills(codexHome, request.accountSkills);
  if (workers.has(request.jobId)) throw new Error("Duplicate host job");
  const workspace = expectedWorkspace(request.conversationId);
  if (!fs.statSync(workspace).isDirectory()) throw new Error("CODEX_WEB conversation workspace is unavailable on the host");
  const runtimeRoot = path.join(workspace, ".runtime", "jobs", request.jobId);
  const projectRoot = resolveProjectDirectory(request.projectRoot);
  const trusted: HostRootExecutionRequest = {
    ...request,
    workspace,
    runtimeRoot,
    knowledgeRoot: projectRoot,
    codexHome,
    threadInstructions: buildHostThreadInstructions(),
    imagePaths: request.imageRelativePaths.map((relativePath) => resolveWorkspaceFile(workspace, relativePath)),
    automation: request.automation ? {
      ...request.automation,
      receiptDirectory: path.join(workspace, ".automation", "wake-receipts"),
    } : undefined,
  };
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist-server", "server", "host-root-job.js")], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: "/root", CODEX_HOME: codexHome },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "inherit"],
  });
  const worker = { child, socket, workspace, runtimeRoot, terminal: false, timers: [] as NodeJS.Timeout[] };
  workers.set(request.jobId, worker);
  const output = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  output.on("line", (line) => {
    let event: TenantWorkerEvent;
    try { event = JSON.parse(line) as TenantWorkerEvent; }
    catch { return; }
    if (event.type === "completed" || event.type === "failed") worker.terminal = true;
    send(socket, { type: "event", jobId: request.jobId, event });
  });
  child.on("error", (error) => send(socket, { type: "request_failed", message: error.message }));
  child.on("exit", (code, signal) => {
    output.close();
    clearTimers(worker);
    workers.delete(request.jobId);
    cleanupJobRuntime(worker.runtimeRoot);
    repairWorkspaceOwnership(workspace);
    if (!worker.terminal) {
      send(socket, { type: "event", jobId: request.jobId, event: { type: "failed", message: `CODEX_WEB 宿主任务异常退出（${signal ?? code ?? "unknown"}）`, cancelled: signal === "SIGTERM" || signal === "SIGKILL" } });
    }
    socket.end();
  });
  writeWorker(child, { type: "run", request: trusted });
  return request.jobId;
}

function validateRunRequest(request: HostRootRunRequest): void {
  validateHostUser(request.userId);
  if (!isUuid(request.jobId) || !isUuid(request.conversationId)) throw new Error("Invalid host job identifiers");
  validatePrompt(request.effectivePrompt);
  resolveProjectDirectory(request.projectRoot);
  if (request.codexThreadId !== null && !/^[0-9a-f-]{20,80}$/i.test(request.codexThreadId)) throw new Error("Invalid Codex thread id");
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(request.selection?.model ?? "")) throw new Error("Invalid model selection");
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(request.selection?.reasoningEffort ?? "")) throw new Error("Invalid reasoning selection");
  if (!isOptionalAgentCapabilities(request.optionalCapabilities)) throw new Error("Invalid optional capabilities");
  if (!isAccountSkillBundle(request.accountSkills)) throw new Error("Invalid account skills");
  if (request.codexEgressKind && !["primary", "backup", "unchanged"].includes(request.codexEgressKind)) throw new Error("Invalid Codex egress");
  if (!Array.isArray(request.imageRelativePaths) || request.imageRelativePaths.length > 12) throw new Error("Invalid host image list");
  if (request.outputSchema && Buffer.byteLength(JSON.stringify(request.outputSchema), "utf8") > 64_000) throw new Error("Output schema is too large");
}

function handleProjectFs(action: "list" | "create" | "validate" | "initialize", rawPath: string, name?: string, content?: string) {
  let directory = resolveProjectDirectory(rawPath);
  if (action === "create") {
    if (typeof name !== "string") throw new Error("请输入文件夹名称");
    const safeName = name.trim();
    if (!safeName || safeName.length > 100 || safeName === "." || safeName === ".." || /[\\/\0-\x1f]/.test(safeName)) {
      throw new Error("文件夹名称无效");
    }
    const target = path.join(directory, safeName);
    fs.mkdirSync(target);
    directory = resolveProjectDirectory(target);
  }
  if (action === "initialize") {
    if (typeof content !== "string") throw new Error("缺少项目规则模板");
    installProjectInstructions(directory, content);
  }
  const directories = action === "validate" || action === "initialize" ? [] : fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .slice(0, 500)
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const parsed = path.parse(directory);
  return { directory, parent: directory === parsed.root ? null : path.dirname(directory), directories };
}

function resolveProjectDirectory(rawPath: string): string {
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath) || rawPath.length > 4096 || rawPath.includes("\0")) {
    throw new Error("项目路径必须是服务器上的绝对路径");
  }
  let canonical: string;
  try { canonical = fs.realpathSync(rawPath); }
  catch { throw new Error("项目文件夹不存在或无法访问"); }
  if (!fs.statSync(canonical).isDirectory()) throw new Error("项目路径不是文件夹");
  return canonical;
}

function validateHostUser(userId: string): void {
  if (userId !== HOST_ROOT_USER_ID) throw new Error("This account is not allowed to use the host root bridge");
}

function assertCodexAccountSwitchAllowed(): void {
  if (workers.size > 0 || voiceReviewWorkers.size > 0 || titleAgentWorkers.size > 0) {
    throw new Error("CODEX_WEB 仍有任务执行，暂不能切换全局 Codex 账号。");
  }
  const database = process.env.CWW_DATABASE_PATH || path.join(process.cwd(), ".state", "data", "codex-web.sqlite");
  const query = spawnSync("sqlite3", [database, "SELECT count(1) FROM jobs WHERE status='running';"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (query.status !== 0 || !/^\d+\s*$/.test(query.stdout)) throw new Error("无法确认任务状态，已拒绝切换全局 Codex 账号。");
  if (Number(query.stdout.trim()) > 0) throw new Error("仍有任务执行，暂不能切换全局 Codex 账号；任务完成后可立即重试。");
}

function validatePrompt(prompt: string): string {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 500_000) throw new Error("Invalid host prompt");
  return prompt;
}

function expectedWorkspace(conversationId: string): string {
  const tenant = path.join(hostTenantRoot, HOST_ROOT_USER_ID);
  const workspace = path.resolve(tenant, "conversations", conversationId);
  const expectedParent = path.resolve(tenant, "conversations");
  if (!workspace.startsWith(`${expectedParent}${path.sep}`)) throw new Error("Host workspace escapes the CODEX_WEB tenant");
  return workspace;
}

function resolveWorkspaceFile(workspace: string, relativePath: string): string {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("Invalid host attachment path");
  const normalized = path.posix.normalize(relativePath);
  if (!normalized.startsWith("uploads/") || normalized.includes("../")) throw new Error("Host attachment must be an uploaded file");
  const resolved = path.resolve(workspace, ...normalized.split("/"));
  if (!resolved.startsWith(`${path.resolve(workspace)}${path.sep}`)) throw new Error("Host attachment escapes the conversation workspace");
  if (!fs.statSync(resolved).isFile()) throw new Error("Host attachment is unavailable");
  return resolved;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function writeWorker(child: ChildProcess, message: HostRootJobInput): void {
  if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
}

function scheduleForcedCancellation(jobId: string, child: ChildProcess): void {
  const worker = workers.get(jobId);
  if (!worker || worker.timers.length > 0) return;
  for (const [delay, signal] of [[5_000, "SIGTERM"], [8_000, "SIGKILL"]] as const) {
    const timer = setTimeout(() => signalWorker(jobId, child, signal), delay);
    timer.unref();
    worker.timers.push(timer);
  }
}

function signalWorker(jobId: string, child: ChildProcess, signal: NodeJS.Signals): void {
  if (workers.get(jobId)?.child !== child || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function clearTimers(worker: { timers: NodeJS.Timeout[] }): void {
  for (const timer of worker.timers) clearTimeout(timer);
  worker.timers.length = 0;
}

function repairWorkspaceOwnership(workspace: string): void {
  for (const [command, args] of [
    ["chown", ["-R", `${webUid}:${webGid}`, "--", workspace]],
    ["chmod", ["-R", "u+rwX", "--", workspace]],
  ] as const) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.status !== 0) process.stderr.write(`Failed to repair CODEX_WEB workspace with ${command}\n`);
  }
}

function send(socket: Socket, message: HostRootServerMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function sendRequestFailure(socket: Socket, requestId: string, error: unknown): void {
  send(socket, { type: "request_failed", requestId, message: error instanceof Error ? error.message : "Codex 账号操作失败" });
  socket.end();
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const [jobId, worker] of workers) signalWorker(jobId, worker.child, "SIGTERM");
  for (const child of voiceReviewWorkers.values()) {
    if (!child.pid) continue;
    try { if (process.platform === "win32") child.kill("SIGTERM"); else process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  for (const child of titleAgentWorkers.values()) {
    if (!child.pid) continue;
    try { if (process.platform === "win32") child.kill("SIGTERM"); else process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  codexAccountManager.close();
  try { if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true }); } catch {}
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
