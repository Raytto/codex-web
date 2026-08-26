import readline from "node:readline";
import { startTenantTurn, validateTenantWorkerRequest } from "./tenant-worker-execution.js";
import type { AppServerTurnExecution } from "./app-server-turn.js";
import type { TenantWorkerEvent, TenantWorkerInput } from "./tenant-worker-protocol.js";
import { cleanupJobRuntime } from "./python-runtime.js";

const expectedUserId = process.env.CWW_TENANT_USER_ID ?? "";
const expectedTenantRoot = process.env.CWW_TENANT_ROOT ?? "";
const expectedUid = Number(process.env.CWW_TENANT_UID ?? "NaN");
const expectedGid = Number(process.env.CWW_TENANT_GID ?? "NaN");
const controller = new AbortController();
let started = false;
let activeExecution: AppServerTurnExecution | null = null;

function send(event: TenantWorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message: TenantWorkerInput;
  try {
    message = JSON.parse(line) as TenantWorkerInput;
  } catch {
    send({ type: "failed", message: "Invalid worker input" });
    process.exitCode = 1;
    return;
  }
  if (message.type === "cancel") {
    controller.abort();
    activeExecution?.interrupt();
    return;
  }
  if (message.type === "steer") {
    if (!activeExecution) {
      send({ type: "steer_failed", requestId: message.requestId, message: "当前任务尚未开始或已经结束" });
      return;
    }
    void activeExecution.steer(message.prompt, message.imagePaths).then(
      (turnId) => send({ type: "steer_completed", requestId: message.requestId, turnId }),
      (error) => send({ type: "steer_failed", requestId: message.requestId, message: error instanceof Error ? error.message : "引导失败" }),
    );
    return;
  }
  if (message.type !== "run" || started) return;
  started = true;
  void (async () => {
    let terminalEvent: Extract<TenantWorkerEvent, { type: "completed" | "failed" }>;
    try {
      if (process.platform !== "win32" && (process.getuid?.() !== expectedUid || process.getgid?.() !== expectedGid)) {
        throw new Error("Worker Unix identity mismatch");
      }
      validateTenantWorkerRequest(message.request, expectedUserId, expectedTenantRoot);
      activeExecution = startTenantTurn(message.request, {
        signal: controller.signal,
        onAuthReady: () => send({ type: "auth_ready" }),
        onThreadStarted: (threadId) => send({ type: "thread_started", threadId }),
        onContextUsage: (usage) => send({ type: "context_usage", usage }),
        onQuotaUsage: (usage) => send({ type: "quota_usage", usage }),
        onProgress: (payload) => send({ type: "progress", payload }),
      });
      const finalResponse = await activeExecution.result;
      terminalEvent = { type: "completed", finalResponse };
      process.exitCode = 0;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      terminalEvent = {
        type: "failed",
        message: cancelled ? "任务已停止" : error instanceof Error ? error.message : "Agent 任务失败",
        cancelled,
      };
      process.exitCode = cancelled ? 0 : 1;
    } finally {
      activeExecution = null;
      cleanupJobRuntime(message.request.runtimeRoot);
      send(terminalEvent!);
      input.close();
    }
  })();
});

input.on("close", () => {
  if (!started) process.exitCode = 1;
});
