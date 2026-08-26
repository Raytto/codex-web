import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { isModelCapacityError, isRetryableUpstreamError } from "./retry-policy.js";
import { buildOptionalCapabilityConfig, type OptionalAgentCapabilities } from "./optional-capabilities.js";
import { applyCodexProxyEnvironment, CODEX_EGRESS_FALLBACK_NOTICE, resolveCodexEgressChoice, selectCodexEgress, type CodexEgressKind } from "./codex-egress.js";
import { callWaitDynamicTool, WAIT_DYNAMIC_TOOL_NAME, WAIT_DYNAMIC_TOOL_SPEC, type WaitDynamicToolConfig } from "./wait-dynamic-tool.js";

type JsonObject = Record<string, unknown>;

type AppServerCallbacks = {
  signal: AbortSignal;
  onAuthReady?(): void | Promise<void>;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onContextUsage?(usage: ContextTokenUsage): void;
  onQuotaUsage?(usage: CodexQuotaUsage): void;
};

export type ContextTokenUsage = {
  threadId: string;
  inputTokens: number;
  modelContextWindow: number | null;
};

export type CodexQuotaUsage = {
  remainingPercent: number;
  resetAt?: string | null;
};

export type AppServerTurnOptions = {
  executablePath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  threadId: string | null;
  threadInstructions?: string;
  prompt: string;
  imagePaths: string[];
  outputSchema?: Record<string, unknown>;
  model: string;
  reasoningEffort: string;
  library: string;
  shellEnvironment: Record<string, string>;
  networkAccessEnabled: boolean;
  webSearchMode: "cached" | "live";
  sandbox?: "workspace-write" | "danger-full-access";
  runtimeWorkspaceRoots?: string[];
  optionalCapabilities: OptionalAgentCapabilities;
  codexEgressKind?: CodexEgressKind;
  waitAutomation?: WaitDynamicToolConfig;
};

export type AppServerTurnExecution = {
  result: Promise<string>;
  steer(prompt: string, imagePaths?: string[]): Promise<string>;
  interrupt(): void;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type RpcResponse = { id: number; result?: unknown; error?: { message?: string; data?: unknown } };
type RpcNotification = { method: string; params?: JsonObject };
type RpcServerRequest = { id: number; method: string; params?: JsonObject };

export function appServerNotificationBelongsToThread(threadId: string | null, params: JsonObject): boolean {
  const notificationThreadId = typeof params.threadId === "string" ? params.threadId : null;
  // Older app-server versions did not attach threadId to every notification.
  // When it is present, keep child-agent threads from mutating the parent turn state.
  return !threadId || !notificationThreadId || notificationThreadId === threadId;
}

class AppServerTurnClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private finalResponse = "";
  private streamingAgentItemId: string | null = null;
  private streamingAgentText = "";
  private readonly subagents = new Map<string, { path?: string; summary?: string }>();
  private terminal = false;
  private quotaRefreshInFlight = false;
  private authReadyNotified = false;
  private stderr = "";
  private readonly completion: Promise<string>;
  private resolveCompletion!: (value: string) => void;
  private rejectCompletion!: (error: Error) => void;

  constructor(private readonly options: AppServerTurnOptions, private readonly callbacks: AppServerCallbacks) {
    this.completion = new Promise<string>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.child = spawn(options.executablePath || process.env.CODEX_RUNTIME_PATH || "codex", ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      output.close();
      if (!this.terminal) this.fail(new Error(this.stderr.trim() || `Codex app server exited before completion (${signal ?? code ?? "unknown"})`));
      for (const request of this.pending.values()) request.reject(new Error("Codex app server disconnected"));
      this.pending.clear();
    });
    callbacks.signal.addEventListener("abort", () => this.interrupt(), { once: true });
  }

  run(): Promise<string> {
    void this.start();
    return this.completion.finally(() => this.dispose());
  }

  async steer(prompt: string, imagePaths: string[] = []): Promise<string> {
    if (this.terminal || !this.threadId || !this.activeTurnId) throw new Error("当前任务已结束，无法引导");
    const result = await this.request("turn/steer", {
      threadId: this.threadId,
      input: makeUserInput(prompt, imagePaths),
      expectedTurnId: this.activeTurnId,
    }) as { turnId?: string };
    if (!result?.turnId) throw new Error("引导未被正在运行的任务接受");
    this.activeTurnId = result.turnId;
    return result.turnId;
  }

  interrupt(): void {
    if (this.terminal) return;
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    if (threadId && turnId && this.child.stdin.writable) {
      void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    }
  }

  private async start(): Promise<void> {
    try {
      await this.request("initialize", {
        clientInfo: { name: "codex-web", title: "Codex Web", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify("initialized");
      void this.refreshQuotaUsage();
      const common = {
        model: this.options.model,
        cwd: this.options.cwd,
        runtimeWorkspaceRoots: this.options.runtimeWorkspaceRoots ?? [this.options.cwd, this.options.library],
        approvalPolicy: "never",
        sandbox: this.options.sandbox ?? "workspace-write",
        config: {
          sandbox_workspace_write: {
            writable_roots: [this.options.library],
            network_access: this.options.networkAccessEnabled,
          },
          shell_environment_policy: { inherit: "core", set: this.options.shellEnvironment },
          model_reasoning_summary: "auto",
          hide_agent_reasoning: false,
          show_raw_agent_reasoning: false,
          web_search: this.options.webSearchMode,
          tool_output_token_limit: 8_000,
          tools: { view_image: true },
          ...buildOptionalCapabilityConfig(this.options.optionalCapabilities, this.options.prompt),
        },
      };
      const threadResult = this.options.threadId
        ? await this.request("thread/resume", { threadId: this.options.threadId, ...common, excludeTurns: true })
        : await this.request("thread/start", {
            ...common,
            ...(this.options.threadInstructions ? { developerInstructions: this.options.threadInstructions } : {}),
            ...(this.options.waitAutomation ? { dynamicTools: [WAIT_DYNAMIC_TOOL_SPEC] } : {}),
          });
      const thread = (threadResult as { thread?: { id?: string } })?.thread;
      if (!thread?.id) throw new Error("Codex app server did not return a thread id");
      this.threadId = thread.id;
      this.callbacks.onThreadStarted(thread.id);
      const turnResult = await this.request("turn/start", {
        threadId: thread.id,
        input: makeUserInput(this.options.prompt, this.options.imagePaths),
        model: this.options.model,
        effort: this.options.reasoningEffort,
        ...(this.options.sandbox === "danger-full-access"
          ? { cwd: this.options.cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
          : {}),
        ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
      }) as { turn?: { id?: string } };
      if (!turnResult?.turn?.id) throw new Error("Codex app server did not return a turn id");
      this.activeTurnId = turnResult.turn.id;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (!this.child.stdin.writable) return Promise.reject(new Error("Codex app server is unavailable"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcResponse | RpcNotification | RpcServerRequest;
    try { message = JSON.parse(line) as RpcResponse | RpcNotification | RpcServerRequest; }
    catch { return; }
    if ("id" in message && "method" in message) {
      void this.handleServerRequest(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app server request failed"));
      else pending.resolve(message.result);
      return;
    }
    this.handleNotification(message);
  }

  private async handleServerRequest(message: RpcServerRequest): Promise<void> {
    if (!this.child.stdin.writable) return;
    const reply = (result: unknown) => this.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
    if (message.method !== "item/tool/call" || !this.options.waitAutomation) {
      reply({ contentItems: [{ type: "inputText", text: "Unsupported dynamic tool request" }], success: false });
      return;
    }
    const params = message.params ?? {};
    if (params.tool !== WAIT_DYNAMIC_TOOL_NAME) {
      reply({ contentItems: [{ type: "inputText", text: "Unknown dynamic tool" }], success: false });
      return;
    }
    try {
      const result = await callWaitDynamicTool(this.options.waitAutomation, params.arguments);
      reply({ contentItems: [{ type: "inputText", text: result }], success: true });
    } catch (error) {
      reply({ contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false });
    }
  }

  private handleNotification(message: RpcNotification): void {
    const params = message.params ?? {};
    if (!appServerNotificationBelongsToThread(this.threadId, params)) {
      this.handleSubagentNotification(message.method, params);
      return;
    }
    if (message.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.activeTurnId = turn.id;
      this.callbacks.onProgress({ kind: "status", label: "已开始分析" });
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const usage = normalizeContextTokenUsage(params);
      if (usage) this.callbacks.onContextUsage?.(usage);
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      // Notifications are sparse rolling updates. Refetch the complete snapshot
      // instead of treating omitted windows or buckets as empty quota.
      void this.refreshQuotaUsage();
      return;
    }
    if (message.method === "error") {
      const error = params.error as { message?: string } | undefined;
      const detail = error?.message || "上游处理发生错误";
      this.callbacks.onProgress(isModelCapacityError(detail)
        ? { kind: "error", label: redactBrand(detail) }
        : isRetryableUpstreamError(detail)
        ? { kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" }
        : { kind: "error", label: redactBrand(detail) });
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!itemId || !delta || (turnId && this.activeTurnId && turnId !== this.activeTurnId)) return;
      if (this.streamingAgentItemId !== itemId) {
        this.streamingAgentItemId = itemId;
        this.streamingAgentText = "";
      }
      this.streamingAgentText = `${this.streamingAgentText}${delta}`.slice(-100_000);
      this.callbacks.onProgress({
        kind: "assistant_stream",
        label: "正在生成回答",
        detail: redactBrand(sanitizeAgentMarkdown(this.streamingAgentText)),
      });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      void this.markAuthReady();
      const item = params.item as JsonObject | undefined;
      if (!item) return;
      this.registerSubagent(item);
      if (item.type === "agentMessage" && message.method === "item/completed") {
        this.finalResponse = typeof item.text === "string" ? item.text : this.finalResponse;
        this.streamingAgentItemId = null;
        this.streamingAgentText = "";
        if (this.options.outputSchema) return;
      }
      const progress = summarizeAppServerItem(item, message.method === "item/completed");
      if (progress) this.callbacks.onProgress(progress);
      return;
    }
    if (message.method !== "turn/completed") return;
    void this.markAuthReady();
    const turn = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
    if (turn?.id && this.activeTurnId && turn.id !== this.activeTurnId) return;
    this.terminal = true;
    this.activeTurnId = null;
    if (turn?.status === "completed") {
      this.callbacks.onProgress({ kind: "status", label: "工作已完成，正在整理结果" });
      this.resolveCompletion(this.finalResponse);
      return;
    }
    const error = new Error(turn?.error?.message || (turn?.status === "interrupted" ? "上游报告本轮已中断" : "Agent 任务失败"));
    if (this.callbacks.signal.aborted) error.name = "AbortError";
    else if (turn?.status === "interrupted") error.name = "TurnInterruptedError";
    this.rejectCompletion(error);
  }

  private registerSubagent(item: JsonObject): void {
    if (item.type !== "subAgentActivity") return;
    const id = typeof item.agentThreadId === "string" ? item.agentThreadId.trim().slice(0, 200) : "";
    if (!id) return;
    const path = typeof item.agentPath === "string" ? item.agentPath.trim().slice(0, 500) : "";
    const current = this.subagents.get(id) ?? {};
    this.subagents.set(id, { ...current, ...(path ? { path } : {}) });
  }

  private handleSubagentNotification(method: string, params: JsonObject): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const tracked = this.subagents.get(threadId);
    if (!tracked) return;
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (!item) return;
      if (item.type === "subAgentActivity") {
        this.registerSubagent(item);
        const progress = summarizeAppServerItem(item, method === "item/completed");
        if (progress) this.callbacks.onProgress(progress);
        return;
      }
      if (method === "item/completed" && item.type === "agentMessage"
        && (item.phase === "final_answer" || item.phase === undefined) && typeof item.text === "string") {
        const summary = redactBrand(sanitizeAgentMarkdown(item.text)).trim().slice(0, 2_000);
        if (summary) this.subagents.set(threadId, { ...tracked, summary });
      }
      return;
    }
    if (method !== "turn/completed") return;
    const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
    const latest = this.subagents.get(threadId) ?? tracked;
    const status = turn?.status === "completed" ? "completed"
      : turn?.status === "interrupted" ? "interrupted"
      : "failed";
    const errorSummary = status === "failed" && turn?.error?.message
      ? redactBrand(sanitizeAgentMarkdown(turn.error.message)).trim().slice(0, 2_000)
      : "";
    this.callbacks.onProgress({
      kind: "agent",
      label: "协作 Agent 状态更新",
      agents: [{
        id: threadId.slice(0, 200),
        ...(latest.path ? { path: latest.path } : {}),
        status,
        ...(latest.summary || errorSummary ? { summary: latest.summary || errorSummary } : {}),
      }],
    });
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.rejectCompletion(error);
  }

  private async refreshQuotaUsage(): Promise<void> {
    if (!this.callbacks.onQuotaUsage || this.quotaRefreshInFlight || !this.child.stdin.writable) return;
    this.quotaRefreshInFlight = true;
    try {
      const usage = normalizeCodexQuotaUsage(await this.request("account/rateLimits/read", {}));
      await this.markAuthReady();
      if (usage) this.callbacks.onQuotaUsage(usage);
    } catch {
      // Quota is informational and must not fail an otherwise healthy turn.
    } finally {
      this.quotaRefreshInFlight = false;
    }
  }

  private async markAuthReady(): Promise<void> {
    if (this.authReadyNotified) return;
    this.authReadyNotified = true;
    try { await this.callbacks.onAuthReady?.(); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private dispose(): void {
    if (this.child.stdin.writable) this.child.stdin.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

export function normalizeContextTokenUsage(params: JsonObject): ContextTokenUsage | null {
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  const tokenUsage = params.tokenUsage && typeof params.tokenUsage === "object"
    ? params.tokenUsage as JsonObject
    : null;
  const last = tokenUsage?.last && typeof tokenUsage.last === "object"
    ? tokenUsage.last as JsonObject
    : null;
  const inputTokens = finiteNonNegativeInteger(last?.inputTokens);
  if (!threadId || inputTokens === null) return null;
  const modelContextWindow = finitePositiveInteger(tokenUsage?.modelContextWindow);
  return { threadId, inputTokens, modelContextWindow };
}

export function normalizeCodexQuotaUsage(value: unknown): CodexQuotaUsage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as JsonObject;
  const byLimitId = source.rateLimitsByLimitId && typeof source.rateLimitsByLimitId === "object"
    ? source.rateLimitsByLimitId as JsonObject
    : null;
  const explicitCodexLimit = byLimitId?.codex && typeof byLimitId.codex === "object"
    ? byLimitId.codex as JsonObject
    : null;
  const rateLimits = explicitCodexLimit
    ?? (source.rateLimits && typeof source.rateLimits === "object" ? source.rateLimits as JsonObject : source);
  const windows = [rateLimits.primary, rateLimits.secondary].flatMap((window): JsonObject[] => {
    if (!window || typeof window !== "object") return [];
    const usedPercent = quotaUsedPercent(window as JsonObject);
    return usedPercent !== null
      ? [window as JsonObject]
      : [];
  });
  if (windows.length === 0) return null;
  const selected = windows.reduce((current, window) => (quotaUsedPercent(window) ?? 0) > (quotaUsedPercent(current) ?? 0) ? window : current);
  const usedPercent = quotaUsedPercent(selected) ?? 0;
  const resetAt = normalizeQuotaResetAt(selected.resetAt ?? selected.reset_at ?? selected.resetsAt ?? selected.resets_at);
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    ...(resetAt ? { resetAt } : {}),
  };
}

function quotaUsedPercent(window: JsonObject): number | null {
  const value = window.usedPercent ?? window.used_percent;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeQuotaResetAt(value: unknown): string | null {
  let timestamp: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    timestamp = value > 10_000_000_000 ? value : value * 1_000;
  } else if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    timestamp = Number.isFinite(numeric)
      ? (numeric > 10_000_000_000 ? numeric : numeric * 1_000)
      : Date.parse(value);
  } else {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function startAppServerTurn(options: AppServerTurnOptions, callbacks: AppServerCallbacks): AppServerTurnExecution {
  let client: AppServerTurnClient | null = null;
  let interrupted = false;
  const result = (async () => {
    const choice = options.codexEgressKind
      ? resolveCodexEgressChoice(options.codexEgressKind)
      : await selectCodexEgress({ signal: callbacks.signal });
    if (!options.codexEgressKind && choice.kind === "backup") {
      callbacks.onProgress({ kind: "status", status: "warning", label: CODEX_EGRESS_FALLBACK_NOTICE });
    }
    const selectedOptions = {
      ...options,
      env: applyCodexProxyEnvironment({ ...options.env }, choice.proxyUrl),
      shellEnvironment: applyCodexProxyEnvironment({ ...options.shellEnvironment }, choice.proxyUrl),
    };
    client = new AppServerTurnClient(selectedOptions, callbacks);
    if (interrupted) client.interrupt();
    return client.run();
  })();
  return {
    result,
    steer: (prompt, imagePaths) => client
      ? client.steer(prompt, imagePaths)
      : Promise.reject(new Error("当前任务正在选择网络出口，请稍后再引导")),
    interrupt: () => { interrupted = true; client?.interrupt(); },
  };
}

function makeUserInput(prompt: string, imagePaths: string[]): JsonObject[] {
  const input: JsonObject[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const imagePath of imagePaths) input.push({ type: "localImage", path: imagePath });
  return input;
}

export function summarizeAppServerItem(item: JsonObject, completed: boolean): unknown | null {
  const subagent = summarizeSubagentItem(item);
  if (subagent) return subagent;
  if (item.type === "reasoning") {
    const summary = [...asStringArray(item.summary), ...asStringArray(item.content)].join("\n\n").trim();
    return summary ? { kind: "reasoning", label: "模型思路摘要", detail: redactBrand(sanitizeAgentMarkdown(summary)) } : null;
  }
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "";
    const status = typeof item.status === "string" ? item.status : completed ? "completed" : "inProgress";
    return { kind: "command", label: status === "failed" ? "本机步骤执行失败，正在调整" : status === "inProgress" ? "正在执行本机处理步骤" : "本机处理步骤完成", detail: redactBrand(command) };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes as JsonObject[] : [];
    return { kind: "file", label: "已更新文件", files: changes.map((change) => String(change.path ?? change.file_path ?? "")).filter(Boolean) };
  }
  if (item.type === "webSearch") return { kind: "search", label: "正在搜索资料" };
  if (item.type === "mcpToolCall") return { kind: "tool", label: `正在使用 ${redactBrand(String(item.server ?? "工具"))}`, detail: redactBrand(String(item.tool ?? "")) };
  if (item.type === "plan") return { kind: "update", label: "任务计划已更新", detail: String(item.text ?? "") };
  if (item.type === "agentMessage" && completed) {
    const detail = redactBrand(sanitizeAgentMarkdown(String(item.text ?? ""))).trim();
    return detail ? { kind: "update", label: "阶段反馈", detail } : null;
  }
  return null;
}

function summarizeSubagentItem(item: JsonObject): unknown | null {
  if (item.type === "subAgentActivity") {
    const id = typeof item.agentThreadId === "string" ? item.agentThreadId.trim() : "";
    if (!id) return null;
    const status = item.kind === "interrupted" ? "interrupted" : "running";
    return {
      kind: "agent",
      label: "协作 Agent 状态更新",
      agents: [{
        id,
        ...(typeof item.agentPath === "string" && item.agentPath.trim() ? { path: item.agentPath.trim().slice(0, 500) } : {}),
        status,
      }],
    };
  }
  if (item.type !== "collabAgentToolCall") return null;
  const rawStates = item.agentsStates && typeof item.agentsStates === "object" && !Array.isArray(item.agentsStates)
    ? item.agentsStates as JsonObject
    : {};
  const receiverIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())
    : [];
  const ids = [...new Set([...Object.keys(rawStates), ...receiverIds])];
  if (ids.length === 0) return null;
  const agents = ids.slice(0, 64).map((id) => {
    const rawState = rawStates[id] && typeof rawStates[id] === "object" && !Array.isArray(rawStates[id])
      ? rawStates[id] as JsonObject
      : {};
    const status = normalizeSubagentStatus(rawState.status, item.status);
    const summary = typeof rawState.message === "string"
      ? redactBrand(sanitizeAgentMarkdown(rawState.message)).trim().slice(0, 2_000)
      : "";
    return { id: id.slice(0, 200), status, ...(summary ? { summary } : {}) };
  });
  return { kind: "agent", label: "协作 Agent 状态更新", agents };
}

function normalizeSubagentStatus(agentStatus: unknown, toolStatus: unknown): "pending" | "running" | "completed" | "failed" | "interrupted" {
  if (agentStatus === "pendingInit") return "pending";
  if (agentStatus === "running") return "running";
  if (agentStatus === "completed" || agentStatus === "shutdown") return "completed";
  if (agentStatus === "interrupted") return "interrupted";
  if (agentStatus === "errored" || agentStatus === "notFound" || toolStatus === "failed") return "failed";
  return "pending";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function redactBrand(value: string): string {
  return value.replace(/chatgpt|codex/gi, "Codex Web");
}
