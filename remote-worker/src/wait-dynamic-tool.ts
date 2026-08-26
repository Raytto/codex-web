import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;
export const WAIT_DYNAMIC_TOOL_NAME = "codex_web_schedule_wait";
export const WAIT_DYNAMIC_TOOL_SPEC = {
  type: "function" as const,
  name: WAIT_DYNAMIC_TOOL_NAME,
  description: "Schedule one durable continuation: after for timers, event_or_deadline for external completion with a deadline. By default inherit this job's model and reasoning effort; only pass model or reasoningEffort for an explicit user request. Never sleep to hold a turn open.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["mode", "delaySeconds", "successPrompt"],
    properties: {
      mode: { type: "string", enum: ["after", "event_or_deadline"] },
      delaySeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
      successPrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      failurePrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      timeoutPrompt: { type: "string", minLength: 1, maxLength: 20_000 },
      label: { type: "string", maxLength: 120 }, runId: { type: "string", maxLength: 200 },
      newConversation: { type: "boolean", description: "Create the continuation in a new conversation." },
      model: { type: "string", minLength: 1, maxLength: 100, description: "Optional explicit user-requested model override; omit to inherit." },
      reasoningEffort: { type: "string", minLength: 1, maxLength: 32, description: "Optional explicit user-requested reasoning-effort override; omit to inherit." },
    },
  },
};

export type WaitToolConfig = { baseUrl: string; token: string; jobId: string; receiptDirectory: string };

export async function callWaitDynamicTool(config: WaitToolConfig, raw: unknown): Promise<string> {
  const value = object(raw);
  const modeValue = value?.mode;
  if (!value || !["after", "event_or_deadline"].includes(String(modeValue))) throw new Error("mode 必须是 after 或 event_or_deadline");
  if (value.newConversation !== undefined && typeof value.newConversation !== "boolean") throw new Error("newConversation 必须是布尔值");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("model 必须是字符串");
  if (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== "string") throw new Error("reasoningEffort 必须是字符串");
  const delaySeconds = Number(value.delaySeconds);
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 31_536_000) throw new Error("delaySeconds 无效");
  const successPrompt = text(value.successPrompt, 20_000);
  if (!successPrompt) throw new Error("successPrompt 不能为空");
  const eventMode = modeValue === "event_or_deadline";
  const body: JsonObject = {
    mode: eventMode ? "event_or_deadline" : "time", delaySeconds, successPrompt,
    failurePrompt: text(value.failurePrompt, 20_000) || successPrompt,
    timeoutPrompt: text(value.timeoutPrompt, 20_000) || successPrompt,
    label: text(value.label, 120) || (eventMode ? "等待外部事件" : "定时自动继续"),
    runId: text(value.runId, 200) || null,
    newConversation: value.newConversation === true,
  };
  const modelOverride = text(value.model, 100);
  const reasoningEffortOverride = text(value.reasoningEffort, 32);
  if (modelOverride) body.model = modelOverride;
  if (reasoningEffortOverride) body.reasoningEffort = reasoningEffortOverride;
  const response = await request(config, "POST", "/wake-plans", body);
  const plan = object(response.wakePlan);
  const id = typeof plan?.id === "string" ? plan.id : "";
  const deadlineAt = typeof plan?.deadline_at === "string" ? plan.deadline_at : "";
  const model = typeof plan?.agent_model === "string" ? plan.agent_model : "";
  const reasoningEffort = typeof plan?.reasoning_effort === "string" ? plan.reasoning_effort : "";
  if (!id || !deadlineAt) throw new Error("Codex Web 没有返回完整等待计划");
  const newConversation = plan?.new_conversation === 1;
  if (value.newConversation === true && !newConversation) {
    await cancel(config, id); throw new Error("当前 Codex Web 尚未启用新会话续跑，等待计划已取消");
  }
  if (!eventMode) return JSON.stringify({ scheduled: true, mode: "after", wakePlanId: id, deadlineAt, newConversation, model, reasoningEffort });
  const signal = object(response.signal);
  if (typeof signal?.url !== "string" || typeof signal.token !== "string") {
    await cancel(config, id); throw new Error("Codex Web 没有返回事件凭据");
  }
  try {
    fs.mkdirSync(config.receiptDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.receiptDirectory, 0o700);
    const destination = path.join(config.receiptDirectory, `${id}.json`);
    const temporary = path.join(config.receiptDirectory, `.${id}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, wakePlanId: id, eventUrl: signal.url, eventToken: signal.token, deadlineAt }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, destination); fs.chmodSync(destination, 0o600);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    return JSON.stringify({ scheduled: true, mode: "event_or_deadline", wakePlanId: id, deadlineAt, newConversation, model, reasoningEffort, receiptPath: destination, signalHint: "Use CODEX_WEB_WAIT_CLI signal --receipt <receiptPath>; never expose receipt contents." });
  } catch (error) {
    await cancel(config, id);
    throw new Error(`事件回执保存失败，计划已取消：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function request(config: WaitToolConfig, method: string, suffix: string, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/automation/jobs/${encodeURIComponent(config.jobId)}${suffix}`, {
    method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text(); let parsed: JsonObject = {};
  try { parsed = raw ? JSON.parse(raw) as JsonObject : {}; } catch { parsed = {}; }
  if (!response.ok) throw new Error(typeof parsed.error === "string" ? parsed.error : `Codex Web 请求失败（${response.status}）`);
  return parsed;
}
async function cancel(config: WaitToolConfig, id: string): Promise<void> { await request(config, "POST", `/wake-plans/${encodeURIComponent(id)}/cancel`, {}).catch(() => undefined); }
function object(value: unknown): JsonObject | null { return value && !Array.isArray(value) && typeof value === "object" ? value as JsonObject : null; }
function text(value: unknown, max: number): string { const result = typeof value === "string" ? value.trim() : ""; if (result.length > max) throw new Error(`文本字段不能超过 ${max} 字符`); return result; }
