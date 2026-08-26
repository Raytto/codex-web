import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCodexProxyEnvironment, selectCodexEgress } from "./codex-egress.js";

export const CONVERSATION_TITLE_CODEX_MODEL = "gpt-5.6-luna";
export const CONVERSATION_TITLE_REASONING_EFFORT = "low";
export const CONVERSATION_TITLE_PROMPT_VERSION = "codex-title-v1";
export const CONVERSATION_TITLE_TIMEOUT_MS = 60_000;
const TITLE_LIMIT = 10;
const REQUEST_LIMIT = 12_000;

export type ConversationTitleAgentRequest = {
  userId: string;
  prompt: string;
  timeoutMs: number;
};

export type ConversationTitleContext = {
  requestText: string;
  projectName?: string | null;
  projectDirectory?: string | null;
  attachmentNames?: string[];
  trigger: "first_message" | "remote_import";
};

export type ConversationTitleGenerationInput = ConversationTitleContext & { userId: string; executorId: string };

export class ConversationTitleService {
  constructor(private readonly execute: (userId: string, executorId: string, prompt: string, timeoutMs: number) => Promise<string>) {}

  async generate(input: ConversationTitleGenerationInput): Promise<string | null> {
    const prompt = buildConversationTitlePrompt(input);
    if (!prompt) return null;
    const output = await this.execute(input.userId, input.executorId, prompt, CONVERSATION_TITLE_TIMEOUT_MS);
    return parseConversationTitleOutput(output);
  }
}

export type ConversationTitleWorkerEvent =
  | { type: "auth_ready" }
  | { type: "completed"; output: string }
  | { type: "failed"; message: string };

export const CONVERSATION_TITLE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { title: { type: "string", minLength: 2, maxLength: TITLE_LIMIT } },
  required: ["title"],
};

export function buildConversationTitlePrompt(context: ConversationTitleContext): string {
  const requestText = extractTitleRequestText(context.requestText);
  if (!requestText) return "";
  const project = cleanContext(context.projectName, 120);
  const directory = cleanContext(context.projectDirectory, 120);
  const attachments = [...new Set((context.attachmentNames ?? []).map((name) => cleanContext(name, 160)).filter(Boolean))].slice(0, 20);
  return [
    "你是 Codex Web 的专用会话命名器。只负责生成标题，不执行用户任务。",
    "生成一个看到后即可理解任务内容的简短中文标题。",
    "规则：",
    "1. 优先 6～10 个汉字，绝对不超过 10 个字符。",
    "2. 至少使用明确的动宾结构，最好表达‘对什么对象做什么处理’；项目、游戏、产品或对象名重要时应保留。",
    "3. 使用具体动作，如优化、修复、分析、整理、部署、验证、设计、制作；避免‘处理问题’‘执行任务’‘相关优化’等空泛标题。",
    "4. 不写主观语气、时间、序号、标点、引号或‘标题’前缀。",
    "5. 仅输出符合 schema 的 JSON。",
    "",
    `触发来源：${context.trigger === "remote_import" ? "本机 Codex 新任务同步" : "Codex Web 首条需求"}`,
    project ? `项目名：${project}` : "项目名：未提供",
    directory ? `项目目录名：${directory}` : "项目目录名：未提供",
    attachments.length ? `附件名：${attachments.join("、")}` : "附件名：无",
    "用户首条需求：",
    requestText,
  ].join("\n");
}

export function parseConversationTitleOutput(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { title?: unknown };
    return normalizeConversationTitle(parsed?.title);
  } catch {
    return normalizeConversationTitle(output);
  }
}

export function codexConversationTitleArguments(schemaPath: string, outputPath: string): string[] {
  return [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", CONVERSATION_TITLE_CODEX_MODEL,
    "--config", `model_reasoning_effort=${JSON.stringify(CONVERSATION_TITLE_REASONING_EFFORT)}`,
    "--config", "web_search=\"disabled\"", "--config", "tools.web_search=false",
    "--config", "tools.view_image=false", "--config", "features.shell_tool=false",
    "--config", "features.unified_exec=false", "--config", "agents.enabled=false",
    "--config", "approval_policy=\"never\"", "--config", "history.persistence=\"none\"",
    "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", "-",
  ];
}

export function validateConversationTitleRequest(request: ConversationTitleAgentRequest, expectedUserId?: string): void {
  if (!request || typeof request !== "object") throw new Error("Invalid Codex title request");
  if (!/^[0-9a-f-]{36}$/i.test(request.userId) || (expectedUserId && request.userId !== expectedUserId)) throw new Error("Codex title user mismatch");
  if (typeof request.prompt !== "string" || request.prompt.length < 1 || Buffer.byteLength(request.prompt, "utf8") > 100_000) throw new Error("Codex title prompt is invalid");
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 15_000 || request.timeoutMs > 120_000) throw new Error("Codex title timeout is invalid");
}

export async function runCodexConversationTitle(
  request: ConversationTitleAgentRequest,
  callbacks: { signal: AbortSignal; onAuthReady?(): void },
): Promise<string> {
  validateConversationTitleRequest(request, process.env.CWW_TENANT_USER_ID || undefined);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-title-"));
  const schemaPath = path.join(temporaryRoot, "schema.json");
  const outputPath = path.join(temporaryRoot, "output.json");
  fs.writeFileSync(schemaPath, JSON.stringify(CONVERSATION_TITLE_OUTPUT_SCHEMA), { encoding: "utf8", mode: 0o600 });
  try {
    const egress = await selectCodexEgress({ signal: callbacks.signal });
    const environment = applyCodexProxyEnvironment({ ...process.env }, egress.proxyUrl);
    return await runCodexProcess(request, callbacks, temporaryRoot, schemaPath, outputPath, environment);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCodexProcess(
  request: ConversationTitleAgentRequest,
  callbacks: { signal: AbortSignal; onAuthReady?(): void },
  cwd: string,
  schemaPath: string,
  outputPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.CODEX_RUNTIME_PATH || "codex", codexConversationTitleArguments(schemaPath, outputPath), {
      cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let authReady = false;
    let stderr = "";
    const stop = () => {
      if (child.exitCode !== null || child.signalCode) return;
      if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
      else child.kill("SIGTERM");
    };
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); callbacks.signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value ?? "");
    };
    const abort = () => { stop(); finish(Object.assign(new Error("Codex title request was cancelled"), { name: "AbortError" })); };
    const timer = setTimeout(() => { stop(); finish(new Error(`Codex title request timed out after ${Math.ceil(request.timeoutMs / 1000)} seconds`)); }, request.timeoutMs);
    callbacks.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", () => { if (!authReady) { authReady = true; callbacks.onAuthReady?.(); } });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString("utf8").slice(0, 8_000 - stderr.length); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`Codex title request failed (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${redact(stderr).slice(-1000)}` : ""}`));
      try {
        const output = fs.readFileSync(outputPath, "utf8").trim();
        if (!parseConversationTitleOutput(output)) throw new Error("Codex title request returned invalid output");
        finish(undefined, output);
      } catch (error) { finish(error instanceof Error ? error : new Error("Codex title output could not be read")); }
    });
    child.stdin.end(request.prompt, "utf8");
  });
}

export function extractTitleRequestText(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  const explicitQuestion = text.match(/(?:^|\n)我的问题：\s*([\s\S]*)$/u)?.[1]?.trim();
  if (explicitQuestion) text = explicitQuestion;
  return text.replace(/```[\s\S]*?```/g, " ").replace(/^>.*$/gm, " ").replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]{1,200}>/g, " ").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, REQUEST_LIMIT);
}

export function normalizeConversationTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = (value.trim().split(/\r?\n/, 1)[0] ?? "")
    .replace(/^\s*(?:任务名|任务名称|标题)\s*[：:]\s*/u, "")
    .replace(/^[`'"“”‘’《》【】\[\]()（）\s]+|[`'"“”‘’《》【】\[\]()（）。！？!?，,；;：:\s]+$/gu, "")
    .replace(/\s+/g, "").trim();
  if (!clean || clean === "新任务") return null;
  return Array.from(clean).slice(0, TITLE_LIMIT).join("");
}

function cleanContext(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function redact(value: string): string {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{48,})\b/g, "[REDACTED]")
    .replace(/((?:password|passwd|token|cookie|secret|api[ _-]?key|authorization|密码|口令|私钥|验证码)\s*[=:：]\s*)\S+/gi, "$1[REDACTED]");
}
