import { spawnMemoryWorker } from "./memory-worker.js";
import { taskMemoryEnabled, assertTaskMemoryAvailable, taskMemoryErrorCode, MEMORY_LIMIT_MESSAGE } from "./task-memory.js";
import { HostRootWorkerClient } from "./host-root-worker-client.js";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { WEB_IDENTITY, tenantIdentityForUser } from "./tenant-identities.js";
import type { SupervisorToWebMessage, TenantWorkerEvent, TenantWorkerInput, WebToSupervisorMessage } from "./tenant-worker-protocol.js";
import type { JobRuntimeCleanupTarget } from "./python-runtime.js";
import { validateTenantWorkerRequest } from "./tenant-worker-execution.js";
import { acquireSharedCodexAuth, sharedCodexAuthPolicyFromEnv, type SharedCodexAuthLease, userUsesSharedCodexAuth } from "./shared-codex-auth.js";
import { validateCodexVoiceReviewRequest, type CodexVoiceReviewWorkerEvent } from "./codex-voice-review.js";
import { validateConversationTitleRequest, type ConversationTitleWorkerEvent } from "./conversation-title.js";

const projectRoot = process.cwd();
const workers = new Map<string, ChildProcess>();
const pendingWorkers = new Set<string>();
const cancelledPendingWorkers = new Set<string>();
const sharedAuthLeases = new Map<string, SharedCodexAuthLease>();
const cancellationTimers = new Map<string, NodeJS.Timeout[]>();
const voiceReviewWorkers = new Map<string, ChildProcess>();
const pendingVoiceReviews = new Set<string>();
const titleAgentWorkers = new Map<string, ChildProcess>();
const pendingTitleAgents = new Set<string>();
const cancelledTitleAgents = new Set<string>();
let stopping = false;

const web = spawn(process.execPath, [path.join(projectRoot, "dist-server", "server", "index.js")], {
  cwd: projectRoot,
  env: process.env,
  uid: WEB_IDENTITY.uid,
  gid: WEB_IDENTITY.gid,
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});

web.on("message", (message: WebToSupervisorMessage) => {
  if (!message || typeof message !== "object") return;
  if (message.kind === "tenant_steer") {
    const worker = workers.get(message.jobId);
    if (worker?.stdin?.writable) {
      const input: TenantWorkerInput = {
        type: "steer",
        requestId: message.requestId,
        prompt: message.prompt,
        imagePaths: message.imagePaths,
      };
      worker.stdin.write(`${JSON.stringify(input)}\n`);
    } else {
      sendToWeb({
        kind: "tenant_event",
        jobId: message.jobId,
        event: { type: "steer_failed", requestId: message.requestId, message: "当前任务已经结束" },
      });
    }
    return;
  }
  if (message.kind === "tenant_cancel") {
    const worker = workers.get(message.jobId);
    if (worker?.stdin?.writable) {
      const input: TenantWorkerInput = { type: "cancel" };
      worker.stdin.write(`${JSON.stringify(input)}\n`);
      scheduleForcedCancellation(message.jobId, worker);
    } else if (pendingWorkers.has(message.jobId)) {
      cancelledPendingWorkers.add(message.jobId);
    }
    return;
  }
  if (message.kind === "tenant_runtime_cleanup") {
    void cleanupTenantRuntimes(message.targets).then(
      (result) => sendToWeb({ kind: "tenant_runtime_cleanup_result", requestId: message.requestId, ...result }),
      (error) => sendToWeb({
        kind: "tenant_runtime_cleanup_result",
        requestId: message.requestId,
        removed: 0,
        absent: 0,
        failed: message.targets.map((target) => ({
          jobId: target.jobId,
          message: error instanceof Error ? error.message : "Tenant runtime cleanup failed",
        })),
      }),
    );
    return;
  }
  if (message.kind === "tenant_voice_review") {
    void startTenantVoiceReview(message);
    return;
  }
  if (message.kind === "tenant_title_cancel") {
    if (pendingTitleAgents.has(message.requestId)) cancelledTitleAgents.add(message.requestId);
    const child = titleAgentWorkers.get(message.requestId);
    if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    return;
  }
  if (message.kind === "tenant_title_agent") {
    void startTenantTitleAgent(message);
    return;
  }
  if (message.kind !== "tenant_run") return;
  void startTenantWorker(message);
});

web.on("exit", (code, signal) => {
  if (!stopping) {
    process.stderr.write(`Web process exited unexpectedly (${signal ?? code ?? "unknown"})\n`);
    stopAll("SIGTERM");
    process.exitCode = 1;
  }
});

function spawnTenantTask(executable: string, args: string[], options: import("node:child_process").SpawnOptions, userId: string) {
  const host = new HostRootWorkerClient(process.env.CODEX_WEB_HOST_SOCKET_PATH || "");
  return spawnMemoryWorker(executable, args, options, {
    protect: (pid, token) => host.protectTenantMemory({ userId, pid, token }),
    finish: token => host.finishTenantMemory(userId, token),
  });
}

async function startTenantWorker(message: Extract<WebToSupervisorMessage, { kind: "tenant_run" }>): Promise<void> {
  if (workers.has(message.jobId) || pendingWorkers.has(message.jobId) || message.request.jobId !== message.jobId || message.request.userId !== message.userId) {
    return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: "Invalid or duplicate tenant job" });
  }
  try { if (taskMemoryEnabled()) assertTaskMemoryAvailable(); }
  catch (error) { return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: error instanceof Error ? error.message : "Task memory unavailable", resourceCode: taskMemoryErrorCode(error) }); }
  pendingWorkers.add(message.jobId);
  const identity = tenantIdentityForUser(message.userId);
  if (!identity) {
    pendingWorkers.delete(message.jobId);
    return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: "No Unix identity is configured for this user" });
  }
  const tenantRoot = path.join(process.env.TENANT_ROOT ?? path.join(projectRoot, "tenants"), identity.userId);
  try {
    // The capability-restricted supervisor cannot traverse tenant-owned ACLs.
    // It verifies the lexical boundary here; the worker repeats validation with
    // lstat/realpath as the tenant UID immediately before Codex starts.
    validateTenantWorkerRequest(message.request, identity.userId, tenantRoot, false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid tenant worker request";
    void cleanupTenantRuntimes([{
      userId: message.userId,
      conversationId: message.request.conversationId,
      jobId: message.jobId,
    }]).then((result) => {
      logCleanupFailures("rejected tenant job", result);
      sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: detail });
    });
    pendingWorkers.delete(message.jobId);
    return;
  }
  let lease: SharedCodexAuthLease | null = null;
  try {
    const sharedAuthPolicy = sharedCodexAuthPolicyFromEnv();
    if (userUsesSharedCodexAuth(sharedAuthPolicy, message.userId)) {
      lease = await acquireSharedCodexAuth({
        sourceFile: sharedAuthPolicy!.sourceFile,
        lockFile: sharedAuthPolicy!.lockFile,
        targetFile: path.join(tenantRoot, "codex-home", "auth.json"),
        targetUid: identity.uid,
        targetGid: identity.gid,
      });
      sharedAuthLeases.set(message.jobId, lease);
    }
    if (cancelledPendingWorkers.delete(message.jobId)) {
      await lease?.releaseWithoutCommit();
      sharedAuthLeases.delete(message.jobId);
      pendingWorkers.delete(message.jobId);
      return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: "任务已停止" });
    }
  } catch (error) {
    pendingWorkers.delete(message.jobId);
    return sendToWeb({
      kind: "tenant_worker_exit",
      jobId: message.jobId,
      message: error instanceof Error ? error.message : "Shared Codex auth preparation failed",
    });
  }
  let protectedWorker: ReturnType<typeof spawnTenantTask>;
  try {
    protectedWorker = spawnTenantTask(process.execPath, [path.join(projectRoot, "dist-server", "server", "tenant-worker.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: tenantRoot,
      CODEX_HOME: path.join(tenantRoot, "codex-home"),
      CWW_TENANT_USER_ID: identity.userId,
      CWW_TENANT_ROOT: tenantRoot,
      CWW_TENANT_UID: String(identity.uid),
      CWW_TENANT_GID: String(identity.gid),
    },
    uid: identity.uid,
    gid: identity.gid,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "inherit"],
  }, identity.userId);
  } catch (error) {
    pendingWorkers.delete(message.jobId);
    await lease?.releaseWithoutCommit();
    sharedAuthLeases.delete(message.jobId);
    return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: error instanceof Error ? error.message : "Task memory protection unavailable", resourceCode: taskMemoryErrorCode(error) });
  }
  const worker = protectedWorker.child;
  pendingWorkers.delete(message.jobId);
  workers.set(message.jobId, worker);
  let terminalEvent: TenantWorkerEvent | undefined;
  const output = readline.createInterface({ input: worker.stdout!, crlfDelay: Infinity });
  output.on("line", (line) => {
    try {
      const event = JSON.parse(line) as TenantWorkerEvent;
      if (event.type === "auth_ready") {
        void commitSharedAuth(message.jobId);
        return;
      }
      if (event.type === "completed" || event.type === "failed") { terminalEvent = event; return; }
      sendToWeb({ kind: "tenant_event", jobId: message.jobId, event });
    } catch {
      // Ignore non-protocol stdout without exposing it to the browser or logs.
    }
  });
  worker.on("error", (error) => {
    void commitSharedAuth(message.jobId);
    sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: error.message });
  });
  worker.on("close", async (code, signal) => {
    clearCancellationTimers(message.jobId);
    const memory = await protectedWorker.finished;
    workers.delete(message.jobId);
    output.close();
    void commitSharedAuth(message.jobId);
    const cleanup = cleanupTenantRuntimes([{
      userId: message.userId,
      conversationId: message.request.conversationId,
      jobId: message.jobId,
    }]);
    await cleanup.then(result => logCleanupFailures("tenant worker exit", result));
    if (memory.startError) {
      sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: memory.startError instanceof Error ? memory.startError.message : "Task memory protection unavailable", resourceCode: taskMemoryErrorCode(memory.startError) ?? "MEMORY_GUARD_UNAVAILABLE" });
    } else if (memory.oom) {
      sendToWeb({ kind: "tenant_event", jobId: message.jobId, event: { type: "failed", message: MEMORY_LIMIT_MESSAGE, resourceCode: "MEMORY_LIMIT" } });
    } else if (terminalEvent) {
      sendToWeb({ kind: "tenant_event", jobId: message.jobId, event: terminalEvent });
    } else {
      sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: `Tenant worker exited before completion (${signal ?? code ?? "unknown"})` });
    }
  });
  try {
    await protectedWorker.ready;
    const input: TenantWorkerInput = { type: "run", request: message.request };
    worker.stdin!.write(`${JSON.stringify(input)}\n`);
  } catch { /* The exit listener persists the typed startup failure. */ }

}

async function startTenantVoiceReview(message: Extract<WebToSupervisorMessage, { kind: "tenant_voice_review" }>): Promise<void> {
  if (voiceReviewWorkers.has(message.requestId) || pendingVoiceReviews.has(message.requestId)) {
    return sendToWeb({ kind: "tenant_voice_review_result", requestId: message.requestId, error: "Duplicate Codex voice review request" });
  }
  pendingVoiceReviews.add(message.requestId);
  const identity = tenantIdentityForUser(message.request.userId);
  if (!identity) {
    pendingVoiceReviews.delete(message.requestId);
    return sendToWeb({ kind: "tenant_voice_review_result", requestId: message.requestId, error: "No Unix identity is configured for this user" });
  }
  const tenantRoot = path.join(process.env.TENANT_ROOT ?? path.join(projectRoot, "tenants"), identity.userId);
  let lease: SharedCodexAuthLease | null = null;
  try {
    validateCodexVoiceReviewRequest(message.request, identity.userId);
    const sharedAuthPolicy = sharedCodexAuthPolicyFromEnv();
    if (userUsesSharedCodexAuth(sharedAuthPolicy, identity.userId)) {
      lease = await acquireSharedCodexAuth({
        sourceFile: sharedAuthPolicy!.sourceFile,
        lockFile: sharedAuthPolicy!.lockFile,
        targetFile: path.join(tenantRoot, "codex-home", "auth.json"),
        targetUid: identity.uid,
        targetGid: identity.gid,
      });
    }
    const protectedWorker = spawnTenantTask(process.execPath, [path.join(projectRoot, "dist-server", "server", "codex-voice-review-worker.js")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: tenantRoot,
        CODEX_HOME: path.join(tenantRoot, "codex-home"),
        CWW_TENANT_USER_ID: identity.userId,
        CWW_TENANT_UID: String(identity.uid),
        CWW_TENANT_GID: String(identity.gid),
      },
      uid: identity.uid,
      gid: identity.gid,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "inherit"],
    }, identity.userId);
    const child = protectedWorker.child;

    voiceReviewWorkers.set(message.requestId, child);
    pendingVoiceReviews.delete(message.requestId);
    let terminal = false;
    const output = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const releaseAuth = async () => {
      const active = lease;
      lease = null;
      if (active) await active.commitAndRelease();
    };
    output.on("line", (line) => {
      let event: CodexVoiceReviewWorkerEvent;
      try { event = JSON.parse(line) as CodexVoiceReviewWorkerEvent; } catch { return; }
      if (event.type === "auth_ready") {
        void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for voice review: ${error instanceof Error ? error.message : String(error)}\n`));
        return;
      }
      if (event.type === "completed") {
        terminal = true;
        sendToWeb({ kind: "tenant_voice_review_result", requestId: message.requestId, output: event.output });
      }
      if (event.type === "failed") {
        terminal = true;
        sendToWeb({ kind: "tenant_voice_review_result", requestId: message.requestId, error: event.message });
      }
    });
    child.once("error", (error) => {
      if (!terminal) {
        terminal = true;
        sendToWeb({ kind: "tenant_voice_review_result", requestId: message.requestId, error: error.message });
      }
    });
    child.once("exit", (code, signal) => {
      output.close();
      voiceReviewWorkers.delete(message.requestId);
      void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for voice review: ${error instanceof Error ? error.message : String(error)}\n`));
      if (!terminal) {
        sendToWeb({
          kind: "tenant_voice_review_result",
          requestId: message.requestId,
          error: `Codex voice review worker exited before completion (${signal ?? code ?? "unknown"})`,
        });
      }
    });
    await protectedWorker.ready;
    child.stdin!.end(`${JSON.stringify(message.request)}\n`);
  } catch (error) {
    pendingVoiceReviews.delete(message.requestId);
    await lease?.releaseWithoutCommit();
    sendToWeb({
      kind: "tenant_voice_review_result",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : "Codex voice review could not start",
    });
  }
}

async function startTenantTitleAgent(message: Extract<WebToSupervisorMessage, { kind: "tenant_title_agent" }>): Promise<void> {
  if (titleAgentWorkers.has(message.requestId) || pendingTitleAgents.has(message.requestId)) {
    return sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: "Duplicate Codex title request" });
  }
  if (message.request.task === "personal_memory" && (workers.size || pendingWorkers.size || voiceReviewWorkers.size || pendingVoiceReviews.size || titleAgentWorkers.size || pendingTitleAgents.size)) {
    return sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: "personal_memory_resources_busy" });
  }
  pendingTitleAgents.add(message.requestId);
  const identity = tenantIdentityForUser(message.request.userId);
  if (!identity) {
    pendingTitleAgents.delete(message.requestId);
    return sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: "No Unix identity is configured for this user" });
  }
  const tenantRoot = path.join(process.env.TENANT_ROOT ?? path.join(projectRoot, "tenants"), identity.userId);
  let lease: SharedCodexAuthLease | null = null;
  try {
    validateConversationTitleRequest(message.request, identity.userId);
    const sharedAuthPolicy = sharedCodexAuthPolicyFromEnv();
    if (userUsesSharedCodexAuth(sharedAuthPolicy, identity.userId)) {
      lease = await acquireSharedCodexAuth({
        sourceFile: sharedAuthPolicy!.sourceFile, lockFile: sharedAuthPolicy!.lockFile,
        targetFile: path.join(tenantRoot, "codex-home", "auth.json"), targetUid: identity.uid, targetGid: identity.gid,
      });
    }
    if (stopping || cancelledTitleAgents.delete(message.requestId)) throw new Error("personal_memory_cancelled");
    const protectedWorker = spawnTenantTask(process.execPath, [path.join(projectRoot, "dist-server", "server", "codex-conversation-title-worker.js")], {
      cwd: projectRoot,
      env: { ...process.env, HOME: tenantRoot, CODEX_HOME: path.join(tenantRoot, "codex-home"), CWW_TENANT_USER_ID: identity.userId, CWW_TENANT_UID: String(identity.uid), CWW_TENANT_GID: String(identity.gid) },
      uid: identity.uid, gid: identity.gid, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "inherit"],
    }, identity.userId);
    const child = protectedWorker.child;

    titleAgentWorkers.set(message.requestId, child);
    pendingTitleAgents.delete(message.requestId);
    let terminal = false;
    const output = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const releaseAuth = async () => { const active = lease; lease = null; if (active) await active.commitAndRelease(); };
    output.on("line", (line) => {
      let event: ConversationTitleWorkerEvent;
      try { event = JSON.parse(line) as ConversationTitleWorkerEvent; } catch { return; }
      if (event.type === "auth_ready") { void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for title agent: ${error instanceof Error ? error.message : String(error)}\n`)); return; }
      if (terminal) return;
      if (event.type === "completed") { terminal = true; sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, output: event.output }); }
      if (event.type === "failed") { terminal = true; sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: event.message }); }
    });
    child.once("error", (error) => { if (!terminal) { terminal = true; sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: error.message }); } });
    child.once("exit", (code, signal) => {
      output.close(); titleAgentWorkers.delete(message.requestId);
      void releaseAuth().catch((error) => process.stderr.write(`Shared Codex auth commit failed for title agent: ${error instanceof Error ? error.message : String(error)}\n`));
      if (!terminal) sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: `Codex title worker exited before completion (${signal ?? code ?? "unknown"})` });
    });
    await protectedWorker.ready;
    child.stdin!.end(`${JSON.stringify(message.request)}\n`);
  } catch (error) {
    pendingTitleAgents.delete(message.requestId);
    cancelledTitleAgents.delete(message.requestId);
    await lease?.releaseWithoutCommit();
    sendToWeb({ kind: "tenant_title_agent_result", requestId: message.requestId, error: error instanceof Error ? error.message : "Codex title request could not start" });
  }
}

async function commitSharedAuth(jobId: string): Promise<void> {
  const lease = sharedAuthLeases.get(jobId);
  if (!lease) return;
  sharedAuthLeases.delete(jobId);
  try { await lease.commitAndRelease(); }
  catch (error) {
    process.stderr.write(`Shared Codex auth commit failed for ${jobId}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

type RuntimeCleanupSummary = {
  removed: number;
  absent: number;
  failed: Array<{ jobId: string; message: string }>;
};

async function cleanupTenantRuntimes(targets: JobRuntimeCleanupTarget[]): Promise<RuntimeCleanupSummary> {
  if (!Array.isArray(targets) || targets.length > 10_000) throw new Error("Invalid tenant runtime cleanup request");
  const grouped = new Map<string, JobRuntimeCleanupTarget[]>();
  const result: RuntimeCleanupSummary = { removed: 0, absent: 0, failed: [] };
  for (const target of targets) {
    if (workers.has(target.jobId)) {
      result.failed.push({ jobId: target.jobId, message: "Runtime still belongs to an active job" });
      continue;
    }
    const identity = tenantIdentityForUser(target.userId);
    if (!identity) {
      result.failed.push({ jobId: target.jobId, message: "No Unix identity is configured for this user" });
      continue;
    }
    const current = grouped.get(identity.userId) ?? [];
    current.push(target);
    grouped.set(identity.userId, current);
  }
  const summaries = await Promise.all([...grouped.entries()].map(([userId, userTargets]) => cleanupAsTenant(userId, userTargets)));
  for (const summary of summaries) {
    result.removed += summary.removed;
    result.absent += summary.absent;
    result.failed.push(...summary.failed);
  }
  return result;
}

function cleanupAsTenant(userId: string, targets: JobRuntimeCleanupTarget[]): Promise<RuntimeCleanupSummary> {
  const identity = tenantIdentityForUser(userId);
  if (!identity) return Promise.reject(new Error("No Unix identity is configured for this user"));
  const tenantRoot = path.join(process.env.TENANT_ROOT ?? path.join(projectRoot, "tenants"), identity.userId);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "server", "tenant-runtime-cleanup.js")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: tenantRoot,
        CWW_TENANT_USER_ID: identity.userId,
      },
      uid: identity.uid,
      gid: identity.gid,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let output = "";
    let settled = false;
    const finish = (summary: RuntimeCleanupSummary) => {
      if (settled) return;
      settled = true;
      resolve(summary);
    };
    child.stdout?.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-1_000_000); });
    child.once("error", (error) => finish({
      removed: 0,
      absent: 0,
      failed: targets.map((target) => ({ jobId: target.jobId, message: error.message })),
    }));
    child.once("exit", () => {
      try {
        const summary = JSON.parse(output.trim()) as RuntimeCleanupSummary;
        if (!Number.isInteger(summary.removed) || !Number.isInteger(summary.absent) || !Array.isArray(summary.failed)) {
          throw new Error("Invalid cleanup worker response");
        }
        finish(summary);
      } catch (error) {
        finish({
          removed: 0,
          absent: 0,
          failed: targets.map((target) => ({
            jobId: target.jobId,
            message: error instanceof Error ? error.message : "Cleanup worker response failed",
          })),
        });
      }
    });
    child.stdin?.end(`${JSON.stringify({ targets })}\n`);
  });
}

function logCleanupFailures(context: string, summary: RuntimeCleanupSummary): void {
  for (const failure of summary.failed) {
    process.stderr.write(`Tenant runtime cleanup failed after ${context} for ${failure.jobId}: ${failure.message}\n`);
  }
}

function scheduleForcedCancellation(jobId: string, worker: ChildProcess): void {
  if (cancellationTimers.has(jobId)) return;
  const terminate = setTimeout(() => signalWorkerTree(jobId, worker, "SIGTERM"), 5_000);
  const force = setTimeout(() => signalWorkerTree(jobId, worker, "SIGKILL"), 8_000);
  terminate.unref();
  force.unref();
  cancellationTimers.set(jobId, [terminate, force]);
}

function signalWorkerTree(jobId: string, worker: ChildProcess, signal: NodeJS.Signals): void {
  if (workers.get(jobId) !== worker || !worker.pid) return;
  try {
    if (process.platform === "win32") worker.kill(signal);
    else process.kill(-worker.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function clearCancellationTimers(jobId: string): void {
  for (const timer of cancellationTimers.get(jobId) ?? []) clearTimeout(timer);
  cancellationTimers.delete(jobId);
}

function sendToWeb(message: SupervisorToWebMessage): void {
  if (web.connected) web.send(message);
}

function stopAll(signal: NodeJS.Signals): void {
  stopping = true;
  if (!web.killed) web.kill(signal);
  for (const [jobId, worker] of workers) signalWorkerTree(jobId, worker, signal);
  for (const worker of voiceReviewWorkers.values()) {
    if (!worker.pid) continue;
    try { if (process.platform === "win32") worker.kill(signal); else process.kill(-worker.pid, signal); } catch {}
  }
  for (const worker of titleAgentWorkers.values()) {
    try { if (process.platform === "win32") worker.kill(signal); else if (worker.pid) process.kill(-worker.pid, signal); } catch {}
  }
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
