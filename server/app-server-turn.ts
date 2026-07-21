import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { isRetryableUpstreamError } from "./retry-policy.js";
import { buildOptionalCapabilityConfig, type OptionalAgentCapabilities } from "./optional-capabilities.js";

type JsonObject = Record<string, unknown>;

type AppServerCallbacks = {
  signal: AbortSignal;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
};

export type AppServerTurnOptions = {
  executablePath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  threadId: string | null;
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

class AppServerTurnClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private finalResponse = "";
  private terminal = false;
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
          ...buildOptionalCapabilityConfig(this.options.optionalCapabilities),
        },
      };
      const threadResult = this.options.threadId
        ? await this.request("thread/resume", { threadId: this.options.threadId, ...common, excludeTurns: true })
        : await this.request("thread/start", common);
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
    let message: RpcResponse | RpcNotification;
    try { message = JSON.parse(line) as RpcResponse | RpcNotification; }
    catch { return; }
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

  private handleNotification(message: RpcNotification): void {
    const params = message.params ?? {};
    if (message.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.activeTurnId = turn.id;
      this.callbacks.onProgress({ kind: "status", label: "已开始分析" });
      return;
    }
    if (message.method === "error") {
      const error = params.error as { message?: string } | undefined;
      const detail = error?.message || "上游处理发生错误";
      this.callbacks.onProgress(isRetryableUpstreamError(detail)
        ? { kind: "status", status: "retrying", label: "上游连接短暂中断，正在自动重试" }
        : { kind: "error", label: redactBrand(detail) });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (!item) return;
      if (item.type === "agentMessage" && message.method === "item/completed") {
        this.finalResponse = typeof item.text === "string" ? item.text : this.finalResponse;
        if (this.options.outputSchema) return;
      }
      const progress = summarizeItem(item, message.method === "item/completed");
      if (progress) this.callbacks.onProgress(progress);
      return;
    }
    if (message.method !== "turn/completed") return;
    const turn = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
    if (turn?.id && this.activeTurnId && turn.id !== this.activeTurnId) return;
    this.terminal = true;
    this.activeTurnId = null;
    if (turn?.status === "completed") {
      this.callbacks.onProgress({ kind: "status", label: "工作已完成，正在整理结果" });
      this.resolveCompletion(this.finalResponse);
      return;
    }
    const error = new Error(turn?.error?.message || (turn?.status === "interrupted" ? "任务已停止" : "Agent 任务失败"));
    if (turn?.status === "interrupted" || this.callbacks.signal.aborted) error.name = "AbortError";
    this.rejectCompletion(error);
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.rejectCompletion(error);
  }

  private dispose(): void {
    if (this.child.stdin.writable) this.child.stdin.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

export function startAppServerTurn(options: AppServerTurnOptions, callbacks: AppServerCallbacks): AppServerTurnExecution {
  const client = new AppServerTurnClient(options, callbacks);
  return {
    result: client.run(),
    steer: (prompt, imagePaths) => client.steer(prompt, imagePaths),
    interrupt: () => client.interrupt(),
  };
}

function makeUserInput(prompt: string, imagePaths: string[]): JsonObject[] {
  const input: JsonObject[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const imagePath of imagePaths) input.push({ type: "localImage", path: imagePath });
  return input;
}

function summarizeItem(item: JsonObject, completed: boolean): unknown | null {
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function redactBrand(value: string): string {
  return value.replace(/chatgpt|codex/gi, "Codex Web");
}
