import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadEvent } from "@openai/codex-sdk";
import { startAppServerTurn, type AppServerTurnExecution, type CodexQuotaUsage, type ContextTokenUsage } from "./app-server-turn.js";
import { buildCodexEnvironment, buildShellEnvironment, resolvePythonRuntime } from "./python-runtime.js";
import { summarizeEvent } from "./codex-events.js";
import type { TenantWorkerRunRequest } from "./tenant-worker-protocol.js";
import { isOptionalAgentCapabilities } from "./optional-capabilities.js";

type ExecutionCallbacks = {
  signal: AbortSignal;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onContextUsage?(usage: ContextTokenUsage): void;
  onQuotaUsage?(usage: CodexQuotaUsage): void;
};

export async function executeTenantTurn(request: TenantWorkerRunRequest, callbacks: ExecutionCallbacks): Promise<string> {
  return startTenantTurn(request, callbacks).result;
}

export function startTenantTurn(request: TenantWorkerRunRequest, callbacks: ExecutionCallbacks): AppServerTurnExecution {
  const pythonRuntime = resolvePythonRuntime({
    projectRoot: request.projectRoot,
    pythonRuntimeRoot: request.pythonRuntimeRoot,
  });
  const codexEnvironment = buildCodexEnvironment(pythonRuntime, request.runtimeRoot);
  codexEnvironment.HOME = request.tenantRoot;
  codexEnvironment.CODEX_HOME = request.codexHome;
  if (process.platform === "win32") {
    codexEnvironment.CODEX_WINDOWS_SANDBOX = request.codexWindowsSandbox;
  }
  const shellEnvironment = buildShellEnvironment(pythonRuntime, request.runtimeRoot);
  if (request.automation) Object.assign(shellEnvironment, {
    CODEX_WEB_AUTOMATION_BASE_URL: request.automation.baseUrl,
    CODEX_WEB_AUTOMATION_TOKEN: request.automation.token,
    CODEX_WEB_AUTOMATION_JOB_ID: request.jobId,
    CODEX_WEB_WAIT_CLI: fileURLToPath(new URL("./wait-cli.js", import.meta.url)),
  });
  return startAppServerTurn({
    executablePath: process.env.CODEX_RUNTIME_PATH || undefined,
    cwd: request.workspace,
    env: codexEnvironment,
    threadId: request.codexThreadId,
    prompt: request.effectivePrompt,
    imagePaths: request.imagePaths,
    outputSchema: request.outputSchema,
    model: request.selection.model,
    reasoningEffort: request.selection.reasoningEffort,
    library: request.library,
    shellEnvironment,
    networkAccessEnabled: request.networkAccessEnabled,
    webSearchMode: request.webSearchMode,
    optionalCapabilities: request.optionalCapabilities,
  }, callbacks);
}

export async function consumeTenantTurnEvents(
  events: AsyncIterable<ThreadEvent>,
  callbacks: Pick<ExecutionCallbacks, "onThreadStarted" | "onProgress">,
): Promise<string> {
  let finalResponse = "";
  let turnCompleted = false;
  let lastStreamError = "";
  for await (const event of events) {
    if (event.type === "thread.started") callbacks.onThreadStarted(event.thread_id);
    const publicEvent = summarizeEvent(event);
    if (publicEvent) callbacks.onProgress(publicEvent);
    if ((event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
      finalResponse = event.item.text;
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    // A top-level error event is not necessarily terminal. The CLI may emit it
    // while reconnecting, then fall back from WebSockets to HTTPS and complete
    // the same turn. Only fail if the stream ends without turn.completed.
    if (event.type === "error") lastStreamError = event.message;
    if (event.type === "turn.completed") turnCompleted = true;
  }
  if (!turnCompleted) throw new Error(lastStreamError || "Upstream stream ended before response.completed");
  return finalResponse;
}

export function validateTenantWorkerRequest(request: TenantWorkerRunRequest, expectedUserId: string, expectedTenantRoot: string): void {
  if (request.userId !== expectedUserId) throw new Error("Worker user mismatch");
  if (!/^[0-9a-f-]{36}$/i.test(request.jobId) || !/^[0-9a-f-]{36}$/i.test(request.conversationId)) {
    throw new Error("Invalid worker identifiers");
  }
  if (!isOptionalAgentCapabilities(request.optionalCapabilities)) throw new Error("Invalid optional capabilities");
  if (request.automation) {
    let baseUrl: URL;
    try { baseUrl = new URL(request.automation.baseUrl); }
    catch { throw new Error("Invalid automation endpoint"); }
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.hash
      || request.automation.baseUrl.length > 2_000 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.automation.token)
      || request.automation.token.length > 4_096) throw new Error("Invalid automation endpoint or token");
  }
  const tenantRoot = path.resolve(expectedTenantRoot);
  const expectedWorkspace = path.join(tenantRoot, "conversations", request.conversationId);
  const expectedRuntime = path.join(expectedWorkspace, ".runtime", "jobs", request.jobId);
  const exactPaths: Array<[string, string]> = [
    [request.tenantRoot, tenantRoot],
    [request.workspace, expectedWorkspace],
    [request.runtimeRoot, expectedRuntime],
    [request.codexHome, path.join(tenantRoot, "codex-home")],
    [request.library, path.join(tenantRoot, "library")],
  ];
  for (const [actual, expected] of exactPaths) {
    if (path.resolve(actual) !== path.resolve(expected)) throw new Error("Worker path mismatch");
  }
  for (const imagePath of request.imagePaths) {
    const resolved = path.resolve(imagePath);
    if (!resolved.startsWith(`${path.resolve(expectedWorkspace)}${path.sep}`)) throw new Error("Worker image path escapes workspace");
  }
}
