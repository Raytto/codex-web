import path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { startAppServerTurn, type AppServerTurnExecution } from "./app-server-turn.js";
import { buildCodexEnvironment, buildShellEnvironment, resolvePythonRuntime } from "./python-runtime.js";
import { summarizeEvent } from "./codex-events.js";
import type { TenantWorkerRunRequest } from "./tenant-worker-protocol.js";

type ExecutionCallbacks = {
  signal: AbortSignal;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
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
    shellEnvironment: buildShellEnvironment(pythonRuntime, request.runtimeRoot),
    networkAccessEnabled: request.networkAccessEnabled,
    webSearchMode: request.webSearchMode,
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
