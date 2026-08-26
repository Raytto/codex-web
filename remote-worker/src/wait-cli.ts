#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Json = Record<string, unknown>;
type Receipt = { version: 1; wakePlanId: string; eventUrl: string; eventToken: string; deadlineAt: string };
const [command = "--help", ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

async function main(): Promise<void> {
  if (["--help", "-h", "help"].includes(command)) return help();
  if (command === "after") {
    const seconds = positive("seconds");
    return print(await agent("POST", "/wake-plans", selection({
      mode: "time", delaySeconds: seconds, label: optional("label") || `等待 ${duration(seconds)}后自动继续`,
      successPrompt: text("prompt", "prompt-file", true),
      newConversation: bool("new-conversation"),
    })));
  }
  if (command === "event") {
    const seconds = positive("deadline-seconds");
    const receiptPath = required("receipt");
    const response = await agent("POST", "/wake-plans", selection({
      mode: "event_or_deadline", delaySeconds: seconds,
      label: optional("label") || `等待外部事件，最晚 ${duration(seconds)}后检查`, runId: optional("run-id") || null,
      successPrompt: text("success-prompt", "success-prompt-file", true),
      failurePrompt: text("failure-prompt", "failure-prompt-file", true),
      timeoutPrompt: text("timeout-prompt", "timeout-prompt-file", true),
      newConversation: bool("new-conversation"),
    }));
    const wake = response.wakePlan as Json | undefined;
    const signal = response.signal as Json | undefined;
    if (typeof wake?.id !== "string" || typeof wake.deadline_at !== "string" || typeof signal?.url !== "string" || typeof signal.token !== "string") throw new Error("Codex Web 没有返回完整的事件等待凭据");
    writeReceipt(receiptPath, { version: 1, wakePlanId: wake.id, eventUrl: signal.url, eventToken: signal.token, deadlineAt: wake.deadline_at });
    return print({ wakePlan: wake, receipt: path.resolve(receiptPath), signalCredentialStored: true });
  }
  if (command === "signal") {
    const receipt = readReceipt(required("receipt"));
    const status = required("status");
    if (!["success", "failure", "heartbeat"].includes(status)) throw new Error("status 必须是 success、failure 或 heartbeat");
    const eventId = optional("event-id") || crypto.randomUUID();
    const retryUntil = Date.now() + Math.max(0, numeric("retry-seconds", 60)) * 1000;
    let delay = 1_000;
    for (;;) {
      try {
        const response = await request(receipt.eventUrl, {
          method: "POST", headers: { authorization: `Bearer ${receipt.eventToken}`, "content-type": "application/json" },
          body: JSON.stringify({ eventId, kind: status, summary: text("summary", "summary-file", false) || null }),
        });
        return print({ ...response, wakePlanId: receipt.wakePlanId, eventId });
      } catch (error) {
        if (Date.now() >= retryUntil || (error instanceof HttpError && error.status < 500 && error.status !== 429)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, retryUntil - Date.now()))));
        delay = Math.min(30_000, delay * 2);
      }
    }
  }
  if (command === "cancel") return print(await agent("POST", `/wake-plans/${encodeURIComponent(required("id"))}/cancel`, {}));
  throw new Error(`未知命令：${command}。使用 --help 查看用法。`);
}

async function agent(method: string, suffix: string, body: Json): Promise<Json> {
  const base = environment("CODEX_WEB_AUTOMATION_BASE_URL").replace(/\/$/, "");
  return request(`${base}/api/automation/jobs/${encodeURIComponent(environment("CODEX_WEB_AUTOMATION_JOB_ID"))}${suffix}`, {
    method, headers: { authorization: `Bearer ${environment("CODEX_WEB_AUTOMATION_TOKEN")}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function request(url: string, init: RequestInit): Promise<Json> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch (error) { throw new Error(`无法连接 Codex Web：${error instanceof Error ? error.message : String(error)}`); }
  const raw = await response.text();
  let body: Json = {};
  try { body = raw ? JSON.parse(raw) as Json : {}; } catch { body = {}; }
  if (!response.ok) throw new HttpError(response.status, typeof body.error === "string" ? body.error : `Codex Web 请求失败（${response.status}）`);
  return body;
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) throw new Error(`无法识别参数：${item}`);
    const [name, inline] = item.slice(2).split("=", 2);
    const value = inline ?? values[++index];
    if (!name || value === undefined || value.startsWith("--")) throw new Error(`参数 --${name || item} 缺少值`);
    result.set(name, value);
  }
  return result;
}
function optional(name: string): string { return args.get(name)?.trim() ?? ""; }
function required(name: string): string { const value = optional(name); if (!value) throw new Error(`缺少 --${name}`); return value; }
function positive(name: string): number { const value = Number(required(name)); if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} 必须是正整数秒数`); return value; }
function numeric(name: string, fallback: number): number { const raw = optional(name); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value)) throw new Error(`--${name} 必须是数字`); return value; }
function bool(name: string): boolean { const raw = optional(name).toLowerCase(); if (!raw) return false; if (raw === "true") return true; if (raw === "false") return false; throw new Error(`--${name} 必须是 true 或 false`); }
function selection(body: Json): Json { const model = optional("model"); const effort = optional("reasoning-effort"); if (model) body.model = model; if (effort) body.reasoningEffort = effort; return body; }
function text(inline: string, file: string, needed: boolean): string { const value = optional(inline) || (optional(file) ? fs.readFileSync(path.resolve(optional(file)), "utf8").replace(/^\uFEFF/, "").trim() : ""); if (needed && !value) throw new Error(`缺少 --${inline} 或 --${file}`); return value; }
function environment(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`当前任务没有 ${name}，请确认这是由新版 Codex Web 发起的回合`); return value; }
function duration(seconds: number): string { return seconds % 3600 === 0 ? `${seconds / 3600} 小时` : seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`; }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function writeReceipt(filePath: string, value: Receipt): void {
  const absolute = path.resolve(filePath); fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.rmSync(absolute, { force: true }); fs.renameSync(temporary, absolute); if (process.platform !== "win32") fs.chmodSync(absolute, 0o600);
}
function readReceipt(filePath: string): Receipt {
  const value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8").replace(/^\uFEFF/, "")) as Partial<Receipt>;
  if (value.version !== 1 || typeof value.wakePlanId !== "string" || typeof value.eventUrl !== "string" || typeof value.eventToken !== "string" || typeof value.deadlineAt !== "string") throw new Error("等待凭据文件无效");
  return value as Receipt;
}
function help(): void {
  process.stdout.write("Codex Web 持久等待 CLI\n\n");
  process.stdout.write("after --seconds 7200 --prompt-file continue.txt [--label 文本] [--new-conversation true] [--model MODEL] [--reasoning-effort EFFORT]\n");
  process.stdout.write("event --deadline-seconds 3600 --success-prompt-file success.txt --failure-prompt-file failure.txt --timeout-prompt-file timeout.txt --receipt wait.json [--run-id ID] [--new-conversation true] [--model MODEL] [--reasoning-effort EFFORT]\n");
  process.stdout.write("signal --receipt wait.json --status success|failure|heartbeat [--event-id ID] [--summary-file summary.txt] [--retry-seconds 3600]\n");
  process.stdout.write("cancel --id WAIT_ID\n");
}
