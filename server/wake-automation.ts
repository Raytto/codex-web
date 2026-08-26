import crypto from "node:crypto";

export type JobAutomationClaims = {
  jobId: string;
  conversationId: string;
  expiresAt: number;
  nonce: string;
};

const TOKEN_VERSION = "v1";

export function createJobAutomationToken(
  secret: string,
  jobId: string,
  conversationId: string,
  now = Date.now(),
  ttlMs = 24 * 60 * 60_000,
): string {
  const payload = Buffer.from(JSON.stringify({
    jobId,
    conversationId,
    expiresAt: now + ttlMs,
    nonce: crypto.randomBytes(16).toString("base64url"),
  } satisfies JobAutomationClaims), "utf8").toString("base64url");
  return `${TOKEN_VERSION}.${payload}.${signature(secret, `${TOKEN_VERSION}.${payload}`)}`;
}

export function verifyJobAutomationToken(secret: string, token: string, now = Date.now()): JobAutomationClaims | null {
  const [version, payload, receivedSignature, ...extra] = token.split(".");
  if (version !== TOKEN_VERSION || !payload || !receivedSignature || extra.length > 0) return null;
  const expected = signature(secret, `${version}.${payload}`);
  const received = Buffer.from(receivedSignature);
  const wanted = Buffer.from(expected);
  if (received.length !== wanted.length || !crypto.timingSafeEqual(received, wanted)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<JobAutomationClaims>;
    if (!isUuid(value.jobId) || !isUuid(value.conversationId) || typeof value.nonce !== "string" || value.nonce.length < 16
      || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt < now) return null;
    return value as JobAutomationClaims;
  } catch {
    return null;
  }
}

export function hashWakeEventToken(secret: string, token: string): string {
  return crypto.createHmac("sha256", secret).update(`wake-event\0${token}`).digest("hex");
}

export function readBearerToken(value: string | undefined): string {
  const match = /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(value?.trim() ?? "");
  return match?.[1] ?? "";
}

export const WAIT_AUTOMATION_INSTRUCTIONS = [
  "Codex Web 支持持久自动续跑。只有任务确实需要在当前回合结束后继续时才使用；普通任务不要创建等待计划。",
  "可用 CLI 路径保存在 CODEX_WEB_WAIT_CLI，鉴权和服务地址已在环境中。先运行对应平台命令查看帮助：PowerShell 使用 `node $env:CODEX_WEB_WAIT_CLI --help`，bash 使用 `node \"$CODEX_WEB_WAIT_CLI\" --help`。",
  "定时续跑使用 `after`；外部进程完成或截止时间二选一使用 `event`，并把 receipt 保存到外部监督器在本轮结束后仍能读取的受保护运行目录。",
  "需要让下一轮使用全新上下文时，可加 `--new-conversation true`；到点后 Codex Web 才会在同一项目创建带时间后缀的新对话，旧对话保留为历史。",
  "同一回合可以登记多个彼此独立的等待计划；用户要求立即创建多个新会话时，可分别用 `after`、`delaySeconds=1`、`newConversation=true` 调用等待工具，每项登记时都会立即得到自己的目标会话，首条指令随后进入该会话执行。",
  "等待计划是一次性的。续跑回合若仍需过一段时间继续，必须由该回合自行再次登记；不要用 sleep 保持模型回合，也不要从外部脚本直接运行 codex exec resume。",
  "只有 CLI 返回成功才可以向用户声称已安排。不得在回复、日志说明或交付文件中暴露 CODEX_WEB_AUTOMATION_TOKEN、receipt 中的 eventToken 或 Authorization 内容。",
].join("\n");

export function appendWaitAutomationInstructions(prompt: string, enabled = true): string {
  return enabled ? `${prompt}\n\n<codex_web_wait_automation>\n${WAIT_AUTOMATION_INSTRUCTIONS}\n</codex_web_wait_automation>` : prompt;
}

function signature(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
