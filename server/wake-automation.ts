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
  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(signature(secret, `${version}.${payload}`));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
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
  return /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(value?.trim() ?? "")?.[1] ?? "";
}

export const WAIT_AUTOMATION_INSTRUCTIONS = [
  "Codex Web supports durable continuation after the current turn ends. Use it only when the task genuinely needs a later follow-up.",
  "The CLI path is in CODEX_WEB_WAIT_CLI; authentication and the service URL are already available in the environment. Run its --help command before use.",
  "Use after for a timer. Use event for an external result with a deadline, and keep the receipt in a protected runtime directory that the supervisor can read later.",
  "Each wait plan is one-shot. A resumed turn must create another plan if it still needs to wait; do not keep a model turn alive with sleep or invoke a model-resume command from a supervisor.",
  "Only claim that continuation is scheduled after the CLI succeeds. Never expose CODEX_WEB_AUTOMATION_TOKEN, the receipt eventToken, or Authorization values in replies, logs, or deliverables.",
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
