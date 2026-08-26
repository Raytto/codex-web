import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentOptions, CodexQuotaUsage, ContextUsage, ThreadSnapshot } from "./protocol.js";
import { WORKER_VERSION } from "./version.js";
import { buildRemoteOptionalCapabilityConfig, remoteThreadInstructions } from "./agent-context.js";
import { callWaitDynamicTool, WAIT_DYNAMIC_TOOL_NAME, WAIT_DYNAMIC_TOOL_SPEC, type WaitToolConfig } from "./wait-dynamic-tool.js";

type JsonObject = Record<string, unknown>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Callbacks = { signal: AbortSignal; onThreadStarted(threadId: string): void; onProgress(payload: unknown): void; onContextUsage(usage: ContextUsage): void; onQuotaUsage(usage: CodexQuotaUsage): void; onChangedFile(filePath: string): void };
export type ThreadHeader = { id: string; updatedAt: number };
export const PROJECT_SYNC_SOURCE_KINDS = ["cli", "vscode", "exec"] as const;
export const CODEX_QUOTA_REFRESH_INTERVAL_MS = 30_000;

export function codexNotificationBelongsToThread(threadId: string | null, params: JsonObject): boolean {
  const notificationThreadId = typeof params.threadId === "string" ? params.threadId : null;
  return !threadId || !notificationThreadId || notificationThreadId === threadId;
}

export function changedFilePaths(params: JsonObject): string[] {
  const item = params.item && typeof params.item === "object" ? params.item as JsonObject : null;
  if (item?.type !== "fileChange") return [];
  return (Array.isArray(item.changes) ? item.changes as JsonObject[] : [])
    .map((change) => String(change.path ?? change.file_path ?? ""))
    .filter(Boolean);
}

export function waitAutomationEnvironment(automation?: { baseUrl: string; token: string; jobId: string }): Record<string, string> {
  return automation ? {
    CODEX_WEB_AUTOMATION_BASE_URL: automation.baseUrl,
    CODEX_WEB_AUTOMATION_TOKEN: automation.token,
    CODEX_WEB_AUTOMATION_JOB_ID: automation.jobId,
    CODEX_WEB_WAIT_CLI: fileURLToPath(new URL("./wait-cli.js", import.meta.url)),
  } : {};
}

export class CodexExecution {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private finalResponse = "";
  private readonly subagents = new Map<string, { path?: string; summary?: string }>();
  private terminal = false;
  private quotaRefreshInFlight = false;
  private stderr = "";
  private resolveCompletion!: (value: string) => void;
  private rejectCompletion!: (error: Error) => void;
  readonly result: Promise<string>;

  constructor(private readonly options: { cwd: string; threadId: string | null; prompt: string; imagePaths: string[]; model: string; reasoningEffort: string; optionalCapabilities: Record<string, boolean>; automation?: { baseUrl: string; token: string; jobId: string; receiptDirectory: string; dynamicTool: boolean } }, private readonly callbacks: Callbacks) {
    this.result = new Promise<string>((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; }).finally(() => this.dispose());
    const launch = codexLaunch(["app-server", "--listen", "stdio://"]);
    this.child = spawn(launch.command, launch.args, { cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8000); });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      lines.close();
      if (!this.terminal) this.fail(new Error(this.stderr.trim() || `Codex app-server exited (${signal ?? code ?? "unknown"})`));
      for (const pending of this.pending.values()) pending.reject(new Error("Codex app-server disconnected"));
      this.pending.clear();
    });
    callbacks.signal.addEventListener("abort", () => this.interrupt(), { once: true });
    void this.start();
  }

  async steer(prompt: string, imagePaths: string[] = []): Promise<string> {
    if (!this.threadId || !this.turnId || this.terminal) throw new Error("当前任务尚未开始或已经结束");
    const input = makeUserInput(prompt, imagePaths);
    const result = await this.request("turn/steer", { threadId: this.threadId, input, expectedTurnId: this.turnId }) as { turnId?: string };
    if (!result.turnId) throw new Error("实时引导未被接受");
    this.turnId = result.turnId;
    return result.turnId;
  }

  interrupt(): void {
    if (this.threadId && this.turnId && !this.terminal) void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined);
  }

  private async start(): Promise<void> {
    try {
      await this.request("initialize", { clientInfo: { name: "codex-web-remote-worker", title: "Codex Web Remote Worker", version: WORKER_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.notify("initialized");
      void this.refreshQuotaUsage();
      const automationEnvironment = waitAutomationEnvironment(this.options.automation);
      const common = {
        model: this.options.model,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: {
          model_reasoning_summary: "auto",
          hide_agent_reasoning: false,
          show_raw_agent_reasoning: false,
          web_search: "live",
          tool_output_token_limit: 8_000,
          tools: { view_image: true },
          shell_environment_policy: { inherit: "core", set: automationEnvironment },
          ...buildRemoteOptionalCapabilityConfig(this.options.optionalCapabilities, this.options.prompt),
        },
      };
      const response = this.options.threadId
        ? await this.request("thread/resume", { threadId: this.options.threadId, ...common, excludeTurns: true })
        : await this.request("thread/start", {
            ...common,
            developerInstructions: remoteThreadInstructions(),
            ...(this.options.automation?.dynamicTool ? { dynamicTools: [WAIT_DYNAMIC_TOOL_SPEC] } : {}),
          });
      const thread = (response as { thread?: { id?: string } }).thread;
      if (!thread?.id) throw new Error("Codex app-server did not return a thread id");
      this.threadId = thread.id;
      this.callbacks.onThreadStarted(thread.id);
      const input = makeUserInput(this.options.prompt, this.options.imagePaths);
      const turn = await this.request("turn/start", { threadId: thread.id, input, model: this.options.model, effort: this.options.reasoningEffort, cwd: this.options.cwd, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }) as { turn?: { id?: string } };
      if (!turn.turn?.id) throw new Error("Codex app-server did not start a turn");
      this.turnId = turn.turn.id;
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }

  private notify(method: string): void { this.child.stdin.write(`${JSON.stringify({ method })}\n`); }
  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: JsonObject };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (typeof message.id === "number" && typeof message.method === "string") {
      void this.handleServerRequest(message.id, message.method, message.params ?? {});
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed")); else pending.resolve(message.result);
      return;
    }
    this.notification(String(message.method ?? ""), message.params ?? {});
  }

  private async handleServerRequest(id: number, method: string, params: JsonObject): Promise<void> {
    const reply = (result: unknown) => this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
    if (method !== "item/tool/call" || !this.options.automation?.dynamicTool || params.tool !== WAIT_DYNAMIC_TOOL_NAME) {
      reply({ contentItems: [{ type: "inputText", text: "Unsupported dynamic tool request" }], success: false });
      return;
    }
    try {
      const result = await callWaitDynamicTool(this.options.automation as WaitToolConfig, params.arguments);
      reply({ contentItems: [{ type: "inputText", text: result }], success: true });
    } catch (error) {
      reply({ contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false });
    }
  }

  private notification(method: string, params: JsonObject): void {
    if (method === "account/rateLimits/updated") { void this.refreshQuotaUsage(); return; }
    const belongsToRootThread = codexNotificationBelongsToThread(this.threadId, params);
    // Descendant agents run on separate app-server threads. Their state must not
    // replace the owning turn, but their file edits still belong to this job and
    // must remain eligible for Remote Worker artifact upload.
    if (!belongsToRootThread) {
      if (method === "item/started" || method === "item/completed") {
        for (const changed of changedFilePaths(params)) this.callbacks.onChangedFile(changed);
      }
      this.handleSubagentNotification(method, params);
      return;
    }
    if (method === "turn/started") { const turn = params.turn as { id?: string } | undefined; if (turn?.id) this.turnId = turn.id; this.callbacks.onProgress({ kind: "status", label: "已开始分析" }); return; }
    if (method === "thread/tokenUsage/updated") { const usage = normalizeContextUsage(params); if (usage) this.callbacks.onContextUsage(usage); return; }
    if (method === "error") { const error = params.error as { message?: string } | undefined; this.callbacks.onProgress({ kind: "error", label: error?.message || "上游处理发生错误" }); return; }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as JsonObject | undefined; if (!item) return;
      this.registerSubagent(item);
      if (item.type === "agentMessage" && method === "item/completed" && typeof item.text === "string") this.finalResponse = item.text;
      for (const changed of changedFilePaths(params)) this.callbacks.onChangedFile(changed);
      const progress = summarizeCodexItem(item, method === "item/completed"); if (progress) this.callbacks.onProgress(progress);
      return;
    }
    if (method !== "turn/completed") return;
    const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
    if (turn?.id && this.turnId && turn.id !== this.turnId) return;
    this.terminal = true;
    if (turn?.status === "completed") { this.callbacks.onProgress({ kind: "status", label: "工作已完成，正在整理结果" }); this.resolveCompletion(this.finalResponse || "任务已完成。"); }
    else { const error = new Error(turn?.error?.message || (turn?.status === "interrupted" ? "任务已停止" : "Agent 任务失败")); if (turn?.status === "interrupted") error.name = "AbortError"; this.rejectCompletion(error); }
  }

  private registerSubagent(item: JsonObject): void {
    if (item.type !== "subAgentActivity") return;
    const id = boundedText(item.agentThreadId, 200);
    if (!id) return;
    const path = boundedText(item.agentPath, 500);
    const current = this.subagents.get(id) ?? {};
    this.subagents.set(id, { ...current, ...(path ? { path } : {}) });
  }

  private handleSubagentNotification(method: string, params: JsonObject): void {
    const threadId = boundedText(params.threadId, 200);
    const tracked = this.subagents.get(threadId);
    if (!tracked) return;
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (!item) return;
      if (item.type === "subAgentActivity") {
        this.registerSubagent(item);
        const progress = summarizeCodexItem(item, method === "item/completed");
        if (progress) this.callbacks.onProgress(progress);
        return;
      }
      if (method === "item/completed" && item.type === "agentMessage"
        && (item.phase === "final_answer" || item.phase === undefined)) {
        const summary = boundedText(item.text, 2_000);
        if (summary) this.subagents.set(threadId, { ...tracked, summary });
      }
      return;
    }
    if (method !== "turn/completed") return;
    const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
    const latest = this.subagents.get(threadId) ?? tracked;
    const status = turn?.status === "completed" ? "completed"
      : turn?.status === "interrupted" ? "interrupted"
      : "failed";
    const errorSummary = status === "failed" ? boundedText(turn?.error?.message, 2_000) : "";
    this.callbacks.onProgress({
      kind: "agent",
      label: "协作 Agent 状态更新",
      agents: [{ id: threadId, ...(latest.path ? { path: latest.path } : {}), status, ...(latest.summary || errorSummary ? { summary: latest.summary || errorSummary } : {}) }],
    });
  }

  private fail(error: Error): void { if (!this.terminal) { this.terminal = true; this.rejectCompletion(error); } }
  private async refreshQuotaUsage(): Promise<void> {
    if (this.quotaRefreshInFlight || !this.child.stdin.writable) return;
    this.quotaRefreshInFlight = true;
    try {
      const usage = normalizeCodexQuotaUsage(await this.request("account/rateLimits/read", {}));
      if (usage) this.callbacks.onQuotaUsage(usage);
    } catch {
      // Quota is informational and must not fail an otherwise healthy turn.
    } finally {
      this.quotaRefreshInFlight = false;
    }
  }
  private dispose(): void { if (this.child.stdin.writable) this.child.stdin.end(); if (!this.child.killed) this.child.kill("SIGTERM"); }
}

export function normalizeContextUsage(params: JsonObject): ContextUsage | null {
  const tokenUsage = params.tokenUsage && typeof params.tokenUsage === "object" ? params.tokenUsage as JsonObject : null;
  const last = tokenUsage?.last && typeof tokenUsage.last === "object" ? tokenUsage.last as JsonObject : null;
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  const input = last?.inputTokens;
  if (!threadId || typeof input !== "number" || !Number.isFinite(input) || input < 0) return null;
  const window = tokenUsage?.modelContextWindow;
  return {
    threadId,
    inputTokens: Math.trunc(input),
    modelContextWindow: typeof window === "number" && Number.isFinite(window) && window > 0 ? Math.trunc(window) : null,
  };
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

export class CodexObserver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<string>;
  private nextId = 1;
  private stderr = "";
  private closed = false;
  private quotaRefreshInFlight = false;
  private quotaRefreshTimer?: ReturnType<typeof setInterval>;
  private lastQuotaPercent: number | null = null;
  private lastQuotaResetAt: string | null | undefined;

  constructor(
    private readonly onFailure?: (error: Error) => void,
    private readonly onQuotaUsage?: (usage: CodexQuotaUsage) => void,
  ) {
    const launch = codexLaunch(["app-server", "--listen", "stdio://"]);
    this.child = spawn(launch.command, launch.args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8000); });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      lines.close();
      this.fail(new Error(this.stderr.trim() || `Codex observer exited (${signal ?? code ?? "unknown"})`));
    });
    this.ready = this.initialize();
  }

  async codexHome(): Promise<string> {
    return this.ready;
  }

  async listProjectThreadHeaders(projectRoot: string, cursor: string | null, limit = 50): Promise<{ threads: ThreadHeader[]; nextCursor: string | null }> {
    await this.ready;
    const listed = await this.request("thread/list", {
      cwd: projectRoot,
      archived: false,
      cursor,
      limit: Math.max(1, Math.min(50, Math.trunc(limit))),
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [...PROJECT_SYNC_SOURCE_KINDS],
    }) as { data?: unknown[]; nextCursor?: string | null };
    const threads = (Array.isArray(listed.data) ? listed.data : []).flatMap((item): ThreadHeader[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      return typeof value.id === "string" ? [{ id: value.id, updatedAt: finiteNumber(value.updatedAt) }] : [];
    });
    return { threads, nextCursor: typeof listed.nextCursor === "string" ? listed.nextCursor : null };
  }

  async readThread(threadId: string): Promise<ThreadSnapshot | null> {
    await this.ready;
    const read = await this.request("thread/read", { threadId, includeTurns: true }) as { thread?: unknown };
    return normalizeThreadSnapshot(read.thread);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.quotaRefreshTimer) clearInterval(this.quotaRefreshTimer);
    for (const pending of this.pending.values()) pending.reject(new Error("Codex observer closed"));
    this.pending.clear();
    if (this.child.stdin.writable) this.child.stdin.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  private async initialize(): Promise<string> {
    const response = await this.request("initialize", {
      clientInfo: { name: "codex-web-remote-worker-observer", title: "Codex Web Remote Worker Observer", version: WORKER_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }) as { codexHome?: unknown };
    this.notify("initialized");
    if (this.onQuotaUsage) {
      void this.refreshQuotaUsage();
      this.quotaRefreshTimer = setInterval(() => void this.refreshQuotaUsage(), CODEX_QUOTA_REFRESH_INTERVAL_MS);
      this.quotaRefreshTimer.unref();
    }
    if (typeof response.codexHome !== "string" || !response.codexHome) throw new Error("Codex app-server did not return codexHome");
    return response.codexHome;
  }

  private async refreshQuotaUsage(): Promise<void> {
    if (this.closed || this.quotaRefreshInFlight || !this.onQuotaUsage) return;
    this.quotaRefreshInFlight = true;
    try {
      this.publishQuotaUsage(normalizeCodexQuotaUsage(await this.request("account/rateLimits/read", {})));
    } catch {
      // Thread synchronization remains useful when the account endpoint is temporarily unavailable.
    } finally {
      this.quotaRefreshInFlight = false;
    }
  }

  private publishQuotaUsage(usage: CodexQuotaUsage | null): void {
    if (!usage || !this.onQuotaUsage
      || (usage.remainingPercent === this.lastQuotaPercent && usage.resetAt === this.lastQuotaResetAt)) return;
    this.lastQuotaPercent = usage.remainingPercent;
    this.lastQuotaResetAt = usage.resetAt;
    this.onQuotaUsage(usage);
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex observer is closed"));
    const id = this.nextId++;
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
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: JsonObject };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex observer request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "account/rateLimits/updated") void this.refreshQuotaUsage();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFailure?.(error);
  }
}

export async function setThreadName(threadId: string, name: string): Promise<void> {
  await runThreadAction("thread/name/set", { threadId, name });
}

export async function archiveThread(threadId: string): Promise<void> {
  await runThreadAction("thread/archive", { threadId });
}

export async function readCodexAgentOptions(executablePath?: string): Promise<AgentOptions> {
  const result = await oneShotRequest("model/list", { includeHidden: false, limit: 100 }, executablePath) as { data?: unknown[] };
  const models = (Array.isArray(result.data) ? result.data : []).flatMap((item): AgentOptions["models"] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = typeof value.model === "string" ? value.model : typeof value.id === "string" ? value.id : "";
    if (value.hidden === true || !/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(id)) return [];
    const efforts = Array.isArray(value.supportedReasoningEfforts)
      ? value.supportedReasoningEfforts.flatMap((option): string[] => {
        const effort = option && typeof option === "object" && "reasoningEffort" in option
          ? String((option as { reasoningEffort: unknown }).reasoningEffort)
          : String(option ?? "");
        return /^[a-z][a-z0-9_-]{0,31}$/i.test(effort) ? [effort] : [];
      })
      : [];
    if (efforts.length === 0) return [];
    return [{
      id,
      label: typeof value.displayName === "string" && value.displayName.trim() ? value.displayName : id,
      description: typeof value.description === "string" ? value.description : "",
      reasoningEfforts: [...new Set(efforts)],
      isDefault: value.isDefault === true,
      defaultEffort: typeof value.defaultReasoningEffort === "string" ? value.defaultReasoningEffort : null,
    } as AgentOptions["models"][number] & { isDefault: boolean; defaultEffort: string | null }];
  }) as Array<AgentOptions["models"][number] & { isDefault?: boolean; defaultEffort?: string | null }>;
  if (models.length === 0) throw new Error("Codex did not return any selectable models");
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const defaultEffort = defaultModel.defaultEffort && defaultModel.reasoningEfforts.includes(defaultModel.defaultEffort)
    ? defaultModel.defaultEffort
    : defaultModel.reasoningEfforts.at(-1)!;
  const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const allEfforts = [...new Set(models.flatMap((model) => model.reasoningEfforts))]
    .sort((left, right) => {
      const leftIndex = effortOrder.indexOf(left); const rightIndex = effortOrder.indexOf(right);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right);
    });
  const labels: Record<string, string> = { none: "无", minimal: "最低", low: "较低", medium: "中等", high: "高", xhigh: "极高", max: "最大" };
  return {
    models: models.map(({ isDefault: _isDefault, defaultEffort: _defaultEffort, ...model }) => model),
    reasoningEfforts: allEfforts.map((id) => ({ id, label: labels[id] ?? id })),
    defaults: { model: defaultModel.id, reasoningEffort: defaultEffort },
  };
}

async function oneShotRequest(method: string, params: JsonObject, executablePath?: string): Promise<unknown> {
  const previous = process.env.CODEX_RUNTIME_PATH;
  if (executablePath) process.env.CODEX_RUNTIME_PATH = executablePath;
  const launch = codexLaunch(["app-server", "--listen", "stdio://"]);
  if (executablePath) {
    if (previous === undefined) delete process.env.CODEX_RUNTIME_PATH;
    else process.env.CODEX_RUNTIME_PATH = previous;
  }
  const child = spawn(launch.command, launch.args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000); });
  lines.on("line", (line) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "Codex app-server request failed")); else request.resolve(message.result);
  });
  const request = (requestMethod: string, requestParams: JsonObject) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ method: requestMethod, id, params: requestParams })}\n`);
  });
  try {
    await request("initialize", { clientInfo: { name: "codex-web-remote-worker", title: "Codex Web Remote Worker", version: WORKER_VERSION }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await request(method, params);
  } catch (error) {
    if (error instanceof Error && stderr.trim()) throw new Error(`${error.message}: ${stderr.trim()}`);
    throw error;
  } finally {
    lines.close();
    if (child.stdin.writable) child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }
}

export async function readProjectThreadPage(projectRoot: string, cursor: string | null, limit: number): Promise<{ threads: ThreadSnapshot[]; nextCursor: string | null }> {
  const launch = codexLaunch(["app-server", "--listen", "stdio://"]);
  const child = spawn(launch.command, launch.args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let id = 1;
  const pending = new Map<number, Pending>();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000); });
  lines.on("line", (line) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "request failed")); else request.resolve(message.result);
  });
  const request = (method: string, params: JsonObject) => new Promise<unknown>((resolve, reject) => {
    const requestId = id++;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`);
  });
  try {
    await request("initialize", { clientInfo: { name: "codex-web-remote-worker", title: "Codex Web Remote Worker", version: WORKER_VERSION }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const listed = await request("thread/list", {
      cwd: projectRoot, archived: false, cursor, limit: Math.max(1, Math.min(50, Math.trunc(limit))),
      sortKey: "updated_at", sortDirection: "desc", sourceKinds: [...PROJECT_SYNC_SOURCE_KINDS],
    }) as { data?: unknown[]; nextCursor?: string | null };
    const threads: ThreadSnapshot[] = [];
    for (const summary of listed.data ?? []) {
      const threadId = typeof (summary as { id?: unknown }).id === "string" ? String((summary as { id: string }).id) : "";
      if (!threadId) continue;
      const read = await request("thread/read", { threadId, includeTurns: true }) as { thread?: unknown };
      const normalized = normalizeThreadSnapshot(read.thread);
      if (normalized) threads.push(normalized);
    }
    return { threads, nextCursor: typeof listed.nextCursor === "string" ? listed.nextCursor : null };
  } catch (error) {
    if (error instanceof Error && !error.message && stderr.trim()) throw new Error(stderr.trim());
    throw error;
  } finally {
    lines.close();
    if (child.stdin.writable) child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }
}

export function normalizeThreadSnapshot(value: unknown): ThreadSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const thread = value as Record<string, unknown>;
  if (typeof thread.id !== "string") return null;
  const createdAt = finiteNumber(thread.createdAt);
  const updatedAt = finiteNumber(thread.updatedAt);
  const turns = Array.isArray(thread.turns) ? thread.turns.filter((turn): turn is Record<string, unknown> => Boolean(turn && typeof turn === "object")) : [];
  const supersededCompletedTurns = new Set<string>();
  let laterTerminalTurn = false;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnId = typeof turn.id === "string" ? turn.id : "";
    if (turnId && turn.status === "completed" && laterTerminalTurn) supersededCompletedTurns.add(turnId);
    const items = Array.isArray(turn.items) ? turn.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
    const latestAgent = [...items].reverse().find((item) => item.type === "agentMessage");
    const hasTerminalAgent = items.some((item) => item.type === "agentMessage" && item.phase === "final_answer")
      || Boolean(latestAgent && latestAgent.phase !== "commentary");
    if (turn.status === "completed" && hasTerminalAgent) laterTerminalTurn = true;
  }
  const messages: ThreadSnapshot["messages"] = [];
  const activities: ThreadSnapshot["activities"] = [];
  let running = false;
  for (const turn of turns) {
    const turnId = typeof turn.id === "string" ? turn.id : "";
    if (!turnId) continue;
    const items = Array.isArray(turn.items) ? turn.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
    const startedAt = finiteNumber(turn.startedAt) || createdAt || updatedAt;
    const recordedCompletedAt = finiteNumber(turn.completedAt);
    const latestAgent = [...items].reverse().find((item) => item.type === "agentMessage");
    const hasFinalAgent = items.some((item) => item.type === "agentMessage" && item.phase === "final_answer");
    // Older Codex rollouts predate assistant phases. On a completed turn, a
    // non-commentary assistant item is their terminal reply even when a stale
    // command item is still persisted as inProgress.
    const hasTerminalAgent = hasFinalAgent || Boolean(latestAgent && latestAgent.phase !== "commentary");
    const hasRunningItem = items.some((item) => item.status === "inProgress");
    // A separate observer app-server can read a still-growing external exec turn as
    // completed before its final answer is persisted. Keep explicit commentary and
    // in-progress items in the live activity surface until a real final answer arrives.
    const completedButStillActive = turn.status === "completed"
      && !hasTerminalAgent
      && (hasRunningItem || latestAgent?.phase === "commentary");
    const turnRunning = turn.status === "inProgress"
      || (turn.status === "completed" && !hasTerminalAgent
        && !supersededCompletedTurns.has(turnId)
        && ((!recordedCompletedAt && items.length > 0) || completedButStillActive));
    if (turnRunning) running = true;
    const completedAt = recordedCompletedAt || startedAt;
    let lastAgent: Record<string, unknown> | null = null;
    let finalAgent: Record<string, unknown> | null = null;
    let lastAgentActivityIndex: number | null = null;
    for (const [itemIndex, item] of items.entries()) {
      const itemId = typeof item.id === "string" ? item.id : `item-${itemIndex}`;
      const activity = persistedActivity(item, turnRunning, turnId, itemId, isoFromSeconds(completedAt, itemIndex));
      if (activity) activities.push(activity);
      if (item.type === "agentMessage") {
        lastAgent = item;
        if (item.phase === "final_answer") finalAgent = item;
        lastAgentActivityIndex = activity ? activities.length - 1 : null;
        continue;
      }
      if (item.type !== "userMessage") continue;
      const content = userMessageText(item);
      const userItemId = typeof item.id === "string" ? item.id : `user-${itemIndex}`;
      if (content) messages.push({ turnId, itemId: userItemId, role: "user", content, createdAt: isoFromSeconds(startedAt, itemIndex) });
    }
    // A commentary-only completed turn that was followed by a real terminal turn
    // remains historical activity; do not promote its last progress update into a
    // transcript reply merely because it no longer controls the thread status.
    const transcriptAgent = finalAgent ?? (supersededCompletedTurns.has(turnId) ? null : lastAgent);
    if (transcriptAgent && !turnRunning) {
      if (transcriptAgent === lastAgent && lastAgentActivityIndex !== null) activities.splice(lastAgentActivityIndex, 1);
      const content = boundedText(transcriptAgent.text, 2_000_000);
      const itemId = typeof transcriptAgent.id === "string" ? transcriptAgent.id : `assistant-${items.length}`;
      if (content) messages.push({ turnId, itemId, role: "assistant", content, createdAt: isoFromSeconds(completedAt, items.length) });
    }
  }
  const preview = typeof thread.preview === "string" ? thread.preview.trim().split(/\r?\n/, 1)[0] : "";
  const explicitName = typeof thread.name === "string" ? thread.name.trim() : "";
  let rolloutBytes: number | null = null;
  if (typeof thread.path === "string" && thread.path) {
    try { rolloutBytes = fs.statSync(thread.path).size; } catch { /* A moved or concurrently archived rollout is reported as unavailable. */ }
  }
  return {
    id: thread.id,
    name: (explicitName || preview || "本机任务").slice(0, 200),
    nameSource: explicitName ? "explicit" : preview ? "preview" : "fallback",
    createdAt,
    updatedAt,
    status: running ? "running" : "idle",
    rolloutBytes,
    messages: messages.slice(-1_000),
    activities: activities.slice(-2_000),
  };
}

function persistedActivity(item: Record<string, unknown>, turnRunning: boolean, turnId: string, itemId: string, createdAt: string): ThreadSnapshot["activities"][number] | null {
  const status = typeof item.status === "string" ? item.status : "";
  const itemCompleted = !turnRunning || ["completed", "failed", "declined", "interrupted"].includes(status)
    || (item.type === "agentMessage" && item.phase === "commentary");
  if (item.type === "plan") {
    const detail = boundedText(item.text);
    return detail ? { turnId, itemId, kind: "update", label: "任务计划已更新", detail, createdAt } : null;
  }
  const subagent = summarizeSubagentItem(item);
  if (subagent) return { turnId, itemId, ...subagent, createdAt };
  if (!itemCompleted) return null;
  if (item.type === "reasoning") {
    const detail = boundedText([...strings(item.summary), ...strings(item.content)].join("\n\n"));
    return detail ? { turnId, itemId, kind: "reasoning", label: "模型思路摘要", detail, createdAt } : null;
  }
  if (item.type === "commandExecution") {
    const command = boundedText(item.command);
    return { turnId, itemId, kind: "command", label: status === "failed" ? "本机处理步骤失败" : "本机处理步骤完成", detail: command, createdAt };
  }
  if (item.type === "fileChange") {
    const files = (Array.isArray(item.changes) ? item.changes as JsonObject[] : [])
      .map((change) => boundedText(change.path ?? change.file_path, 2_000))
      .filter(Boolean)
      .slice(0, 200);
    return { turnId, itemId, kind: "file", label: status === "failed" ? "文件更新失败" : "已更新文件", files, createdAt };
  }
  if (item.type === "webSearch") return { turnId, itemId, kind: "search", label: "资料搜索完成", detail: boundedText(item.query), createdAt };
  if (item.type === "mcpToolCall") return {
    turnId,
    itemId,
    kind: "tool",
    label: `已使用 ${String(item.server ?? "工具")}`,
    detail: boundedText(item.tool),
    createdAt,
  };
  if (item.type === "dynamicToolCall") return {
    turnId,
    itemId,
    kind: "tool",
    label: `已使用 ${String(item.namespace ?? "本机工具")}`,
    detail: boundedText(item.tool),
    createdAt,
  };
  if (item.type === "agentMessage") {
    if (item.phase === "final_answer" || !itemCompleted) return null;
    const detail = boundedText(item.text);
    return detail ? { turnId, itemId, kind: "update", label: "阶段反馈", detail, createdAt } : null;
  }
  return null;
}

function userMessageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return boundedText(item.content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
    ? [(part as { text: string }).text]
    : []).join("\n"), 2_000_000);
}

function finiteNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function isoFromSeconds(seconds: number, offsetMs = 0): string { return new Date(Math.max(0, seconds) * 1000 + offsetMs).toISOString(); }
function boundedText(value: unknown, maximum = 200_000): string { return String(value ?? "").trim().slice(0, maximum); }

async function runThreadAction(method: string, params: JsonObject): Promise<void> {
  const launch = codexLaunch(["app-server", "--listen", "stdio://"]);
  const child = spawn(launch.command, launch.args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let id = 1;
  const pending = new Map<number, Pending>();
  lines.on("line", (line) => { let message: { id?: number; result?: unknown; error?: { message?: string } }; try { message = JSON.parse(line); } catch { return; } if (typeof message.id !== "number") return; const request = pending.get(message.id); if (!request) return; pending.delete(message.id); if (message.error) request.reject(new Error(message.error.message || "request failed")); else request.resolve(message.result); });
  const request = (method: string, params: JsonObject) => new Promise<unknown>((resolve, reject) => { const requestId = id++; pending.set(requestId, { resolve, reject }); child.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`); });
  try { await request("initialize", { clientInfo: { name: "codex-web-remote-worker", title: "Codex Web Remote Worker", version: WORKER_VERSION }, capabilities: { experimentalApi: true } }); child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`); await request(method, params); }
  finally { lines.close(); child.stdin.end(); child.kill("SIGTERM"); }
}

export function codexLaunch(args: string[]): { command: string; args: string[] } {
  const runtime = process.env.CODEX_RUNTIME_PATH || "codex";
  return runtime.toLowerCase().endsWith(".js")
    ? { command: process.execPath, args: [runtime, ...args] }
    : { command: runtime, args };
}

function textInput(text: string): JsonObject[] { return [{ type: "text", text, text_elements: [] }]; }
export function makeUserInput(text: string, imagePaths: string[] = []): JsonObject[] {
  return [...textInput(text), ...imagePaths.map((imagePath) => ({ type: "localImage", path: imagePath }))];
}
export function summarizeCodexItem(item: JsonObject, completed: boolean): unknown | null {
  const subagent = summarizeSubagentItem(item);
  if (subagent) return subagent;
  if (item.type === "reasoning") { const detail = [...strings(item.summary), ...strings(item.content)].join("\n\n").trim(); return detail ? { kind: "reasoning", label: "模型思路摘要", detail } : null; }
  if (item.type === "commandExecution") return { kind: "command", label: completed ? "本机处理步骤完成" : "正在执行本机处理步骤", detail: String(item.command ?? "") };
  if (item.type === "fileChange") return { kind: "file", label: "已更新文件", files: (Array.isArray(item.changes) ? item.changes as JsonObject[] : []).map((change) => String(change.path ?? "")).filter(Boolean) };
  if (item.type === "webSearch") return { kind: "search", label: "正在搜索资料" };
  if (item.type === "mcpToolCall") return { kind: "tool", label: `正在使用 ${String(item.server ?? "工具")}`, detail: String(item.tool ?? "") };
  if (item.type === "agentMessage" && completed) { const detail = String(item.text ?? "").trim(); return detail ? { kind: "update", label: "阶段反馈", detail } : null; }
  return null;
}
function summarizeSubagentItem(item: JsonObject): { kind: "agent"; label: string; agents: Array<{ id: string; path?: string; status: "pending" | "running" | "completed" | "failed" | "interrupted"; summary?: string }> } | null {
  if (item.type === "subAgentActivity") {
    const id = boundedText(item.agentThreadId, 200);
    if (!id) return null;
    const path = boundedText(item.agentPath, 500);
    return { kind: "agent", label: "协作 Agent 状态更新", agents: [{ id, ...(path ? { path } : {}), status: item.kind === "interrupted" ? "interrupted" : "running" }] };
  }
  if (item.type !== "collabAgentToolCall") return null;
  const rawStates = item.agentsStates && typeof item.agentsStates === "object" && !Array.isArray(item.agentsStates) ? item.agentsStates as JsonObject : {};
  const receiverIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())
    : [];
  const ids = [...new Set([...Object.keys(rawStates), ...receiverIds])];
  if (ids.length === 0) return null;
  return {
    kind: "agent",
    label: "协作 Agent 状态更新",
    agents: ids.slice(0, 64).map((id) => {
      const rawState = rawStates[id] && typeof rawStates[id] === "object" && !Array.isArray(rawStates[id]) ? rawStates[id] as JsonObject : {};
      const status = normalizeSubagentStatus(rawState.status, item.status);
      const summary = boundedText(rawState.message, 2_000);
      return { id: id.slice(0, 200), status, ...(summary ? { summary } : {}) };
    }),
  };
}
function normalizeSubagentStatus(agentStatus: unknown, toolStatus: unknown): "pending" | "running" | "completed" | "failed" | "interrupted" {
  if (agentStatus === "pendingInit") return "pending";
  if (agentStatus === "running") return "running";
  if (agentStatus === "completed" || agentStatus === "shutdown") return "completed";
  if (agentStatus === "interrupted") return "interrupted";
  if (agentStatus === "errored" || agentStatus === "notFound" || toolStatus === "failed") return "failed";
  return "pending";
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
