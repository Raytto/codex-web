import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { WEB_IDENTITY, tenantIdentityForUser } from "./tenant-identities.js";
import type { SupervisorToWebMessage, TenantWorkerEvent, TenantWorkerInput, WebToSupervisorMessage } from "./tenant-worker-protocol.js";

const projectRoot = process.cwd();
const workers = new Map<string, ChildProcess>();
const cancellationTimers = new Map<string, NodeJS.Timeout[]>();
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
    }
    return;
  }
  if (message.kind !== "tenant_run") return;
  startTenantWorker(message);
});

web.on("exit", (code, signal) => {
  if (!stopping) {
    process.stderr.write(`Web process exited unexpectedly (${signal ?? code ?? "unknown"})\n`);
    stopAll("SIGTERM");
    process.exitCode = 1;
  }
});

function startTenantWorker(message: Extract<WebToSupervisorMessage, { kind: "tenant_run" }>): void {
  if (workers.has(message.jobId) || message.request.jobId !== message.jobId || message.request.userId !== message.userId) {
    return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: "Invalid or duplicate tenant job" });
  }
  const identity = tenantIdentityForUser(message.userId);
  if (!identity) return sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: "No Unix identity is configured for this user" });
  const tenantRoot = path.join(process.env.TENANT_ROOT ?? path.join(projectRoot, "tenants"), identity.userId);
  const worker = spawn(process.execPath, [path.join(projectRoot, "dist-server", "server", "tenant-worker.js")], {
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
  });
  workers.set(message.jobId, worker);
  let terminalEvent = false;
  const output = readline.createInterface({ input: worker.stdout!, crlfDelay: Infinity });
  output.on("line", (line) => {
    try {
      const event = JSON.parse(line) as TenantWorkerEvent;
      if (event.type === "completed" || event.type === "failed") terminalEvent = true;
      sendToWeb({ kind: "tenant_event", jobId: message.jobId, event });
    } catch {
      // Ignore non-protocol stdout without exposing it to the browser or logs.
    }
  });
  worker.on("error", (error) => {
    sendToWeb({ kind: "tenant_worker_exit", jobId: message.jobId, message: error.message });
  });
  worker.on("exit", (code, signal) => {
    clearCancellationTimers(message.jobId);
    workers.delete(message.jobId);
    output.close();
    if (!terminalEvent) {
      sendToWeb({
        kind: "tenant_worker_exit",
        jobId: message.jobId,
        message: `Tenant worker exited before completion (${signal ?? code ?? "unknown"})`,
      });
    }
  });
  const input: TenantWorkerInput = { type: "run", request: message.request };
  worker.stdin!.write(`${JSON.stringify(input)}\n`);
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
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
