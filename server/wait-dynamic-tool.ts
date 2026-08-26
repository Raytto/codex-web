import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

export const WAIT_DYNAMIC_TOOL_NAME = "codex_web_schedule_wait";

export const WAIT_DYNAMIC_TOOL_SPEC = {
  type: "function" as const,
  name: WAIT_DYNAMIC_TOOL_NAME,
  description: "Schedule one durable continuation: after for timers, event_or_deadline for external completion with a deadline. Multiple independent plans are allowed in one turn. By default the continuation inherits this job's model and reasoning effort; only pass model or reasoningEffort when the user explicitly requested an override. Never sleep to hold a turn open.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "delaySeconds", "successPrompt"],
    properties: {
      mode: { type: "string", enum: ["after", "event_or_deadline"] },
      delaySeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
      successPrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      failurePrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      timeoutPrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      label: { type: "string", maxLength: 120, description: "Short purpose shown to the user." },
      runId: { type: "string", maxLength: 200 },
      newConversation: { type: "boolean", description: "Create and attach the wait to a new conversation now." },
      model: { type: "string", minLength: 1, maxLength: 100, description: "Optional explicit user-requested model override. Omit to inherit this job's model." },
      reasoningEffort: { type: "string", minLength: 1, maxLength: 32, description: "Optional explicit user-requested reasoning-effort override. Omit to inherit this job's effort." },
    },
  },
};

export type WaitDynamicToolConfig = {
  baseUrl: string;
  token: string;
  jobId: string;
  receiptDirectory: string;
};

export async function callWaitDynamicTool(config: WaitDynamicToolConfig, rawArguments: unknown): Promise<string> {
  const args = validateArguments(rawArguments);
  const mode = args.mode === "after" ? "time" : "event_or_deadline";
  const body: JsonObject = {
    mode,
    delaySeconds: args.delaySeconds,
    successPrompt: args.successPrompt,
    label: args.label || (mode === "time" ? "定时自动继续" : "等待外部事件"),
    runId: args.runId || null,
    newConversation: args.newConversation,
  };
  if (args.model) body.model = args.model;
  if (args.reasoningEffort) body.reasoningEffort = args.reasoningEffort;
  if (mode === "event_or_deadline") {
    body.failurePrompt = args.failurePrompt;
    body.timeoutPrompt = args.timeoutPrompt;
  }
  const response = await agentRequest(config, "POST", "/wake-plans", body);
  const wakePlan = object(response.wakePlan);
  const planId = stringValue(wakePlan?.id);
  const deadlineAt = stringValue(wakePlan?.deadline_at);
  const model = stringValue(wakePlan?.agent_model);
  const reasoningEffort = stringValue(wakePlan?.reasoning_effort);
  if (!planId || !deadlineAt) throw new Error("Codex Web 没有返回完整的等待计划");
  const newConversation = wakePlan?.new_conversation === 1;
  const targetConversation = object(response.targetConversation);
  const targetConversationId = stringValue(targetConversation?.id) || stringValue(wakePlan?.target_conversation_id);
  const targetConversationTitle = stringValue(targetConversation?.title);
  if (args.newConversation && !newConversation) {
    await cancelPlan(config, planId);
    throw new Error("当前 Codex Web 尚未启用新会话续跑，等待计划已取消");
  }
  if (args.newConversation && !targetConversationId) {
    await cancelPlan(config, planId);
    throw new Error("当前 Codex Web 没有立即创建新会话，等待计划已取消");
  }
  if (mode === "time") {
    return JSON.stringify({ scheduled: true, mode: "after", wakePlanId: planId, deadlineAt, newConversation, targetConversationId, targetConversationTitle, model, reasoningEffort });
  }

  const signal = object(response.signal);
  const eventUrl = stringValue(signal?.url);
  const eventToken = stringValue(signal?.token);
  if (!eventUrl || !eventToken) {
    await cancelPlan(config, planId);
    throw new Error("Codex Web 没有返回完整的事件等待凭据");
  }
  let receiptPath = "";
  try {
    receiptPath = writeProtectedReceipt(config.receiptDirectory, planId, {
      version: 1,
      wakePlanId: planId,
      eventUrl,
      eventToken,
      deadlineAt,
    });
  } catch (error) {
    await cancelPlan(config, planId);
    throw new Error(`事件等待回执保存失败，计划已取消：${error instanceof Error ? error.message : String(error)}`);
  }
  return JSON.stringify({
    scheduled: true,
    mode: "event_or_deadline",
    wakePlanId: planId,
    deadlineAt,
    newConversation,
    targetConversationId,
    targetConversationTitle,
    model,
    reasoningEffort,
    receiptPath,
    signalHint: "外部监督器完成后使用 CODEX_WEB_WAIT_CLI signal --receipt <receiptPath> 发回 success、failure 或 heartbeat。不要读取或展示 receipt 内容。",
  });
}

function validateArguments(value: unknown): {
  mode: "after" | "event_or_deadline";
  delaySeconds: number;
  successPrompt: string;
  failurePrompt: string;
  timeoutPrompt: string;
  label: string;
  runId: string;
  newConversation: boolean;
  model: string;
  reasoningEffort: string;
} {
  const record = object(value);
  if (!record || !["after", "event_or_deadline"].includes(String(record.mode))) throw new Error("mode 必须是 after 或 event_or_deadline");
  const mode = record.mode as "after" | "event_or_deadline";
  if (record.newConversation !== undefined && typeof record.newConversation !== "boolean") throw new Error("newConversation 必须是布尔值");
  const delaySeconds = Number(record.delaySeconds);
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 31_536_000) throw new Error("delaySeconds 必须是 1 到 31536000 的整数");
  const successPrompt = boundedText(record.successPrompt, 20_000);
  if (!successPrompt) throw new Error("successPrompt 不能为空");
  const failurePrompt = boundedText(record.failurePrompt, 20_000) || successPrompt;
  const timeoutPrompt = boundedText(record.timeoutPrompt, 20_000) || successPrompt;
  return {
    mode,
    delaySeconds,
    successPrompt,
    failurePrompt,
    timeoutPrompt,
    label: boundedText(record.label, 120),
    runId: boundedText(record.runId, 200),
    newConversation: record.newConversation === true,
    model: boundedText(record.model, 100),
    reasoningEffort: boundedText(record.reasoningEffort, 32),
  };
}

async function agentRequest(config: WaitDynamicToolConfig, method: string, suffix: string, body: JsonObject): Promise<JsonObject> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/automation/jobs/${encodeURIComponent(config.jobId)}${suffix}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`无法连接 Codex Web：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let parsed: JsonObject = {};
  try { parsed = text ? JSON.parse(text) as JsonObject : {}; } catch { parsed = {}; }
  if (!response.ok) throw new Error(typeof parsed.error === "string" ? parsed.error : `Codex Web 请求失败（${response.status}）`);
  return parsed;
}

async function cancelPlan(config: WaitDynamicToolConfig, planId: string): Promise<void> {
  await agentRequest(config, "POST", `/wake-plans/${encodeURIComponent(planId)}/cancel`, {}).catch(() => undefined);
}

function writeProtectedReceipt(directory: string, planId: string, receipt: JsonObject): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const destination = path.join(directory, `${planId}.json`);
  const temporary = path.join(directory, `.${planId}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

function object(value: unknown): JsonObject | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as JsonObject : null;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function boundedText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new Error(`文本字段不能超过 ${max} 个字符`);
  return text;
}
