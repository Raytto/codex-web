import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startAppServerTurn, type AppServerTurnExecution } from "./app-server-turn.js";
import type { HostRootJobInput } from "./host-root-protocol.js";
import type { TenantWorkerEvent } from "./tenant-worker-protocol.js";
import { cleanupJobRuntime } from "./python-runtime.js";
import { acquireSharedCodexAuth, sharedCodexAuthPolicyFromEnv, type SharedCodexAuthLease } from "./shared-codex-auth.js";
import { materializeHostLinkedFiles } from "./host-linked-files.js";

const controller = new AbortController();
let started = false;
let activeExecution: AppServerTurnExecution | null = null;
let sharedAuthLease: SharedCodexAuthLease | null = null;

async function commitSharedAuth(): Promise<void> {
  const lease = sharedAuthLease;
  if (!lease) return;
  sharedAuthLease = null;
  await lease.commitAndRelease();
}

function send(event: TenantWorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message: HostRootJobInput;
  try { message = JSON.parse(line) as HostRootJobInput; }
  catch {
    send({ type: "failed", message: "Invalid host worker input" });
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
      if (process.platform !== "win32" && process.getuid?.() !== 0) throw new Error("Host worker is not running as root");
      for (const directory of [message.request.runtimeRoot, path.join(message.request.runtimeRoot, "tmp"), path.join(message.request.runtimeRoot, "xdg-cache"), path.join(message.request.runtimeRoot, "xdg-config")]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      const sharedPolicy = sharedCodexAuthPolicyFromEnv();
      if (sharedPolicy) {
        sharedAuthLease = await acquireSharedCodexAuth({
          sourceFile: sharedPolicy.sourceFile,
          lockFile: sharedPolicy.lockFile,
          targetFile: path.join(message.request.codexHome, "auth.json"),
        });
      }
      const shellEnvironment = {
        HOME: "/root",
        CODEX_HOME: message.request.codexHome,
        TMPDIR: path.join(message.request.runtimeRoot, "tmp"),
        TMP: path.join(message.request.runtimeRoot, "tmp"),
        TEMP: path.join(message.request.runtimeRoot, "tmp"),
        XDG_CACHE_HOME: path.join(message.request.runtimeRoot, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(message.request.runtimeRoot, "xdg-config"),
        CWW_SHARED_PYTHON: process.env.CODEX_WEB_SPREADSHEET_PYTHON || "python3",
        CWW_WORKSPACE_ROOT: message.request.workspace,
        CWW_UPLOADS_DIR: path.join(message.request.workspace, "uploads"),
        CWW_OUTPUTS_DIR: path.join(message.request.workspace, "outputs"),
        CWW_JOB_RUNTIME: message.request.runtimeRoot,
        PYTHONDONTWRITEBYTECODE: "1",
        ...(message.request.automation ? {
          CODEX_WEB_AUTOMATION_BASE_URL: message.request.automation.baseUrl,
          CODEX_WEB_AUTOMATION_TOKEN: message.request.automation.token,
          CODEX_WEB_AUTOMATION_JOB_ID: message.request.jobId,
          CODEX_WEB_WAIT_CLI: fileURLToPath(new URL("./wait-cli.js", import.meta.url)),
        } : {}),
      };
      activeExecution = startAppServerTurn({
        executablePath: process.env.CODEX_RUNTIME_PATH || "/usr/bin/codex",
        cwd: message.request.knowledgeRoot,
        env: { ...process.env, HOME: "/root", CODEX_HOME: message.request.codexHome },
        threadId: message.request.codexThreadId,
        threadInstructions: message.request.threadInstructions,
        prompt: message.request.effectivePrompt,
        imagePaths: message.request.imagePaths,
        outputSchema: message.request.outputSchema,
        model: message.request.selection.model,
        reasoningEffort: message.request.selection.reasoningEffort,
        library: message.request.knowledgeRoot,
        shellEnvironment,
        networkAccessEnabled: true,
        webSearchMode: "live",
        sandbox: "danger-full-access",
        runtimeWorkspaceRoots: [message.request.knowledgeRoot, message.request.workspace],
        optionalCapabilities: message.request.optionalCapabilities,
        codexEgressKind: message.request.codexEgressKind,
        waitAutomation: message.request.automation ? {
          baseUrl: message.request.automation.baseUrl,
          token: message.request.automation.token,
          jobId: message.request.jobId,
          receiptDirectory: message.request.automation.receiptDirectory,
        } : undefined,
      }, {
        signal: controller.signal,
        onAuthReady: commitSharedAuth,
        onThreadStarted: (threadId) => send({ type: "thread_started", threadId }),
        onContextUsage: (usage) => send({ type: "context_usage", usage }),
        onQuotaUsage: (usage) => send({ type: "quota_usage", usage }),
        onProgress: (payload) => send({ type: "progress", payload }),
      });
      const finalResponse = await activeExecution.result;
      const linkedFiles = await materializeHostLinkedFiles(finalResponse, message.request.workspace, message.request.knowledgeRoot);
      const omissionNotice = linkedFiles.omissions.length > 0
        ? `\n\n> 本机文件附件提示：${linkedFiles.omissions.map((item) => `${item.label}（${hostLinkedFileOmissionLabel(item.reason)}）`).join("；")}`
        : "";
      terminalEvent = { type: "completed", finalResponse: `${linkedFiles.finalResponse}${omissionNotice}` };
      process.exitCode = 0;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      terminalEvent = { type: "failed", message: cancelled ? "任务已停止" : error instanceof Error ? error.message : "Agent 任务失败", cancelled };
      process.exitCode = cancelled ? 0 : 1;
    } finally {
      await commitSharedAuth().catch((error) => {
        process.stderr.write(`Shared Codex auth commit failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
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

function hostLinkedFileOmissionLabel(reason: "count_limit" | "missing" | "not_file" | "too_large" | "total_limit" | "copy_failed"): string {
  if (reason === "count_limit") return "单条回复附件数量超过上限";
  if (reason === "not_file") return "目标不是普通文件";
  if (reason === "too_large") return "单文件超过 2 GiB";
  if (reason === "total_limit") return "本条回复附件总量超过 4 GiB";
  if (reason === "copy_failed") return "复制失败";
  return "文件不存在或不可读取";
}
