import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { antigravityLaunch, ANTIGRAVITY_MODEL_PREFIX } from "./antigravity-runtime.js";
import { runDirectoryEnvironment, type RunDirectories } from "./run-directories.js";
import type { ContextUsage, CodexQuotaUsage } from "./protocol.js";

type JsonObject = Record<string, unknown>;
export type AntigravityTurnOptions = {
  executablePath?: string;
  /** Dedicated tool-free naming agent in an isolated temporary workspace. */
  titleOnly?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  threadId: string | null;
  threadInstructions?: string;
  prompt: string;
  imagePaths?: string[];
  outputSchema?: Record<string, unknown>;
  /** Exact CLI slug resolved against the authenticated account's catalog. */
  model: string;
  reasoningEffort: string;
  shellEnvironment?: Record<string, string>;
  directories?: RunDirectories;
  runtimeWorkspaceRoots?: string[];
  sandbox?: "workspace-write" | "danger-full-access";
  optionalCapabilities?: Record<string, boolean>;
};
export type AntigravityCallbacks = {
  signal: AbortSignal;
  onAuthReady?(): void | Promise<void>;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
  onContextUsage?(usage: ContextUsage): void;
  onQuotaUsage?(usage: CodexQuotaUsage): void;
  onChangedFile?(filePath: string): void;
};

const asObject = (value: unknown): JsonObject | null => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const text = (value: unknown): string => typeof value === "string" ? value : "";
function aborted(): Error { const error = new Error("任务已停止"); error.name = "AbortError"; return error; }

export function buildAntigravityArguments(options: AntigravityTurnOptions): string[] {
  if (!options.model || options.model.startsWith(ANTIGRAVITY_MODEL_PREFIX)) throw new Error("Gemini 模型尚未解析为此账号支持的原生模型，请刷新模型目录。");
  if (options.imagePaths?.length) throw new Error("当前 Gemini 接入尚不支持直接预载图片；请通过附件文件路径处理，或选择 Codex 的视觉模型。");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(options.model)) throw new Error("Gemini 模型标识无效。");
  if (options.threadId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.threadId)) throw new Error("Gemini 会话标识无效。");
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0", "--disable-slash-commands", "--model", options.model];
  if (options.reasoningEffort && options.reasoningEffort !== "default") args.push("--effort", options.reasoningEffort);
  if (options.threadId) args.push("--conversation", options.threadId);
  if (options.sandbox === "workspace-write") args.push("--sandbox");
  // Codex Web already authorizes unattended execution at this node. AGY still
  // enforces explicit deny rules; those are surfaced below, never overridden.
  if (options.titleOnly) args.push("--agent", "codex-web-title", "--mode", "plan");
  else args.push("--dangerously-skip-permissions");
  for (const root of new Set(options.runtimeWorkspaceRoots ?? [])) args.push("--add-dir", root);
  if (options.outputSchema) args.push("--json-schema", JSON.stringify(options.outputSchema));
  return args;
}

/** One Codex Web request owns exactly one native AGY process and one turn. */
export class AntigravityExecution {
  private child?: ChildProcessWithoutNullStreams;
  private terminal = false;
  private cancellationRequested = false;
  private threadId: string | null = null;
  private resultEnvelope: JsonObject | null = null;
  private stderr = "";
  private permissionFailure = "";
  private partialFailure = "";
  private readonly responseSteps = new Map<number, string>();
  private readonly reportedFiles = new Set<string>();
  private timer?: NodeJS.Timeout;
  private authReady = false;
  private authReadyPromise: Promise<void> = Promise.resolve();
  private resolveCompletion!: (value: string) => void;
  private rejectCompletion!: (error: Error) => void;
  private readonly onAbort = () => this.interrupt();
  readonly result: Promise<string>;

  constructor(private readonly options: AntigravityTurnOptions, private readonly callbacks: AntigravityCallbacks) {
    this.result = new Promise<string>((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; }).finally(() => this.dispose());
    callbacks.signal.addEventListener("abort", this.onAbort, { once: true });
    if (callbacks.signal.aborted) { this.interrupt(); return; }
    try {
      const args = buildAntigravityArguments(options);
      const env = { ...(options.env ?? process.env), ...options.shellEnvironment, ...runDirectoryEnvironment(options.directories) };
      const launch = antigravityLaunch(args, env, options.executablePath);
      const child = this.child = spawn(launch.command, launch.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => this.handleLine(line));
      child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk.toString("utf8")));
      child.stdin.on("error", (error) => { if (!this.resultEnvelope && !this.cancellationRequested) this.fail(error); });
      child.on("error", (error) => this.fail(error));
      child.on("close", (code, signal) => { lines.close(); void this.finish(code, signal); });
      this.timer = setTimeout(() => this.fail(new Error("Gemini 引擎启动超过 120 秒未响应，请检查账号登录与节点网络。")), 120_000);
      callbacks.onProgress({ kind: "status", label: options.threadId ? "正在恢复 Gemini 会话" : "正在启动 Gemini" });
      const prompt = options.threadInstructions
        ? `<codex_web_runtime_instructions>\n${options.threadInstructions}\n</codex_web_runtime_instructions>\n\n${options.prompt}`
        : options.prompt;
      // The official stream input accepts text only. Sending one event and then
      // closing stdin after result prevents accidental multi-turn execution.
      child.stdin.write(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  async steer(_prompt: string, _imagePaths: string[] = []): Promise<string> {
    throw new Error("Gemini 当前不支持执行中的实时调整；请停止本次请求后发送新消息，或等待本次完成。");
  }

  interrupt(): void {
    if (this.terminal || this.cancellationRequested) return;
    this.cancellationRequested = true;
    this.fail(aborted());
  }

  private handleStderr(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-16_000);
    if (/(?:permission[^\n]{0,100}(?:denied|blocked|refused)|(?:denied|blocked|refused)[^\n]{0,100}permission|requires?[^\n]{0,40}approval)/i.test(this.stderr)) {
      this.permissionFailure = "Gemini 的工具操作被权限规则拒绝，任务未完整完成。";
    }
    if (/(?:print.?timeout|timed? out|timeout[^\n]{0,50}(?:partial|reached|expir)|partial[^\n]{0,50}(?:timeout|time limit))/i.test(this.stderr)) {
      this.partialFailure = "Gemini 达到执行时限并只返回了部分结果，任务未完整完成。";
    }
  }

  private handleLine(line: string): void {
    if (this.terminal || !line.trim()) return;
    let event: JsonObject | null;
    try { event = asObject(JSON.parse(line)); } catch { this.fail(new Error("Gemini 引擎返回了无效的流数据，任务未确认完成。")); return; }
    if (!event) return;
    if (this.resultEnvelope) { this.fail(new Error("Gemini 引擎在本次结果之后继续执行，已停止异常会话。")); return; }
    if (event.event === "init") {
      const id = text(event.conversation_id);
      if (!id || (this.options.threadId && id !== this.options.threadId)) { this.fail(new Error("Gemini 会话标识与请求不一致，未继续执行。")); return; }
      this.setThread(id);
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      return;
    }
    if (event.event === "step_update") {
      const step = asObject(event.step_update);
      if (step) this.step(step);
      return;
    }
    if (event.event === "result") {
      const result = asObject(event.result);
      if (!result) { this.fail(new Error("Gemini 引擎缺少最终结果。")); return; }
      const id = text(result.conversation_id);
      if (id && ((this.threadId && id !== this.threadId) || (this.options.threadId && id !== this.options.threadId))) { this.fail(new Error("Gemini 返回了其他会话的结果，已拒绝。")); return; }
      if (id) this.setThread(id);
      this.resultEnvelope = result;
      this.child?.stdin.end();
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fail(new Error("Gemini 返回结果后未结束本次执行，请检查节点上的 CLI。")), 8_000);
    }
  }

  private setThread(id: string): void {
    if (this.threadId) return;
    this.threadId = id;
    this.callbacks.onThreadStarted(id);
  }

  private step(step: JsonObject): void {
    const id = text(step.conversation_id);
    if (id && id !== this.threadId) return; // Subagent steps cannot overwrite root output.
    const index = typeof step.step_index === "number" ? step.step_index : 0;
    if (!this.authReady) {
      this.authReady = true;
      this.authReadyPromise = Promise.resolve().then(() => this.callbacks.onAuthReady?.()).then(() => undefined);
      void this.authReadyPromise.catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
    }
    if (step.step_type === "user_input") {
      this.callbacks.onProgress({ kind: "input_accepted", threadId: this.threadId, turnId: `${this.threadId}:${index}` });
    } else if (step.step_type === "agent_response") {
      const content = `${this.responseSteps.get(index) ?? ""}${text(step.text_delta)}`.slice(-200_000);
      this.responseSteps.set(index, content);
      this.callbacks.onProgress({ kind: "assistant_stream", label: "正在生成回答", detail: content });
      const usage = asObject(step.usage);
      if (step.state === "DONE" && this.threadId && typeof usage?.input_tokens === "number") {
        this.callbacks.onContextUsage?.({ threadId: this.threadId, inputTokens: usage.input_tokens + (typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : 0), modelContextWindow: null });
      }
    } else if (step.step_type === "tool") {
      const tool = asObject(step.tool_info) ?? {};
      const name = text(step.tool_name) || text(tool.name);
      const error = asObject(tool.error);
      if (error && /permission|denied|approval/i.test(`${text(error.type)} ${text(error.message)}`)) this.permissionFailure = "Gemini 的工具操作被权限规则拒绝，任务未完整完成。";
      const parameters = asObject(tool.parameters) ?? {};
      const done = step.state === "DONE";
      if (name === "run_command") {
        this.callbacks.onProgress({ kind: "command", label: error ? "Gemini 处理步骤执行失败" : done ? "本机处理步骤完成" : "正在执行本机处理步骤", detail: text(parameters.CommandLine ?? parameters.command) });
      } else if (["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(name)) {
        const target = text(parameters.TargetFile ?? parameters.AbsolutePath ?? parameters.path);
        if (done && !error && target) {
          if (!this.reportedFiles.has(target)) { this.reportedFiles.add(target); this.callbacks.onChangedFile?.(target); }
          this.callbacks.onProgress({ kind: "file", label: "已更新文件", files: [target] });
        }
      } else {
        this.callbacks.onProgress({ kind: "tool", label: done ? "Gemini 工具步骤完成" : "Gemini 正在使用工具", detail: name });
      }
      if (error) this.callbacks.onProgress({ kind: "error", label: text(error.message).slice(0, 1000) || "Gemini 工具步骤失败" });
    }
    const subagents = asObject(step.subagent_info)?.subagents;
    if (Array.isArray(subagents)) {
      const agents = subagents.map(asObject).filter((item): item is JsonObject => Boolean(item)).map((item) => ({ id: text(item.conversation_id), path: text(item.role ?? item.type_name), status: step.state === "DONE" ? "completed" : "running" })).filter((item) => item.id);
      if (agents.length) this.callbacks.onProgress({ kind: "agent", label: "协作 Agent 状态更新", agents });
    }
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.terminal) return;
    if (this.cancellationRequested) { this.fail(aborted()); return; }
    const result = this.resultEnvelope;
    if (!result) { this.fail(new Error(`Gemini 引擎退出但未返回最终结果（${signal ?? code ?? "unknown"}）。${safeDiagnostic(this.stderr)}`)); return; }
    const status = text(result.status);
    if (status === "CANCELED" || status === "INTERRUPTED") { this.fail(aborted()); return; }
    if (code !== 0 || status !== "SUCCESS") { this.fail(new Error(safeDiagnostic(text(result.error)) || `Gemini 任务未完成（${status || signal || code || "未知状态"}）。${safeDiagnostic(this.stderr)}`)); return; }
    if (this.permissionFailure || this.partialFailure) { this.fail(new Error(this.permissionFailure || this.partialFailure)); return; }
    const response = text(result.response);
    if (!response.trim()) { this.fail(new Error("Gemini 返回空结果，任务未确认完成。请重试或检查账号额度。")); return; }
    try { await this.authReadyPromise; } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
    if (this.terminal) return;
    this.terminal = true;
    this.callbacks.onProgress({ kind: "status", label: "工作已完成，正在整理结果" });
    this.resolveCompletion(response);
  }

  private fail(error: Error): void { if (!this.terminal) { this.terminal = true; this.rejectCompletion(error); } }
  private async dispose(): Promise<void> {
    this.callbacks.signal.removeEventListener("abort", this.onAbort);
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => child.kill("SIGKILL"));
    } else {
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { child.kill(signal); } };
      kill("SIGTERM");
      const force = setTimeout(() => kill("SIGKILL"), 2_000);
      try { await exited; } finally { clearTimeout(force); }
      return;
    }
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await exited; } finally { clearTimeout(force); }
  }
}

function safeDiagnostic(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/g, "[链接已隐藏]").replace(/(?:access_token|refresh_token|authorization|bearer)[=: ]+[^\s]+/gi, "[凭据已隐藏]").trim().slice(-1500);
}

export function startAntigravityTurn(options: AntigravityTurnOptions, callbacks: AntigravityCallbacks): AntigravityExecution {
  return new AntigravityExecution(options, callbacks);
}
