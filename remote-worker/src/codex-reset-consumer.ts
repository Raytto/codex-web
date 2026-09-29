import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withAccountSession, type AccountSessionOptions, type AccountRpc } from "./codex-account-session.js";
import { normalizeResetCredits, unavailableResetCredits, type CodexResetCredits } from "./codex-reset-credits.js";

export type ResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
export type ResetConsumption = {
  attemptId: string; outcome: ResetOutcome; resetCredits: CodexResetCredits;
  quota: { remainingPercent: number; resetAt: string | null } | null;
  refreshed: boolean;
};
const outcomes = ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Receipt = { attemptId: string; accountId: string; creditId: string | null; outcome?: ResetOutcome };
const inFlight = new Map<string, { attemptId: string; promise: Promise<ResetConsumption> }>();

/** Require all available rows: an omitted credit could expire before every known row. */
export function earliestResetCredit(value: unknown, now = new Date()): string | null {
  const summary = normalizeResetCredits(value, now);
  if (summary.state !== "ok") throw new Error("未取得重置卡明细，请刷新后重试。");
  if (summary.availableCount === 0) return null;
  const raw = (value as { rateLimitResetCredits: { credits: Array<{ id: string; status: string; resetType: string; expiresAt: number | null }> } }).rateLimitResetCredits;
  if (summary.expiryStatus !== "complete" || !Array.isArray(raw.credits) || raw.credits.length !== summary.availableCount) {
    throw new Error("重置卡明细不完整，无法确认最早到期的卡，请刷新后重试。");
  }
  return [...raw.credits].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.id.localeCompare(b.id))[0].id;
}

function writeReceipt(file: string, value: Receipt) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

export function consumeAccountResetCredit(options: AccountSessionOptions & { journalRoot: string; attemptId: string }): Promise<ResetConsumption> {
  if (!uuid.test(options.attemptId)) return Promise.reject(new Error("重置请求标识无效。"));
  const key = path.resolve(options.journalRoot);
  const pending = inFlight.get(key);
  if (pending) return pending.attemptId === options.attemptId ? pending.promise : Promise.reject(new Error("此账号正在使用重置卡，请等待当前操作完成。"));
  const promise = withAccountSession(options, (rpc) => redeemEarliestReset(rpc, options.journalRoot, options.expectedAccountId, options.attemptId))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, { attemptId: options.attemptId, promise });
  return promise;
}

/** Durable pinning means a lost response never causes a retry to select a second card. */
export async function redeemEarliestReset(rpc: AccountRpc, root: string, accountId: string, attemptId: string): Promise<ResetConsumption> {
  if (!uuid.test(attemptId)) throw new Error("重置请求标识无效。");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const activeFile = path.join(root, "pending.json");
  const receiptFile = (id: string) => path.join(root, `${id}.json`);
  const read = (file: string): Receipt | null => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  let receipt = read(receiptFile(attemptId));
  // Recover an interrupted attempt even after a browser/device change.
  if (!receipt) receipt = read(activeFile);
  if (receipt && uuid.test(receipt.attemptId)) receipt = read(receiptFile(receipt.attemptId)) ?? receipt;
  if (receipt && (receipt.accountId !== accountId || !uuid.test(receipt.attemptId))) throw new Error("重置操作身份不匹配，请核对账号。");
  if (receipt && receipt.attemptId !== attemptId) writeReceipt(receiptFile(attemptId), receipt);
  const limits = await rpc("account/rateLimits/read", {});
  if (limits.accountId !== accountId) throw new Error("未能核实账号身份，未使用新的重置卡。");
  if (!receipt) {
    const creditId = earliestResetCredit(limits);
    receipt = { accountId, attemptId, creditId, ...(creditId ? {} : { outcome: "noCredit" as const }) };
    // Save the pending pointer first: any crash before sending still pins the same credit/key.
    writeReceipt(activeFile, receipt);
    writeReceipt(receiptFile(receipt.attemptId), receipt);
  }
  if (!receipt.outcome) {
    if (typeof receipt.creditId !== "string" || !receipt.creditId) throw new Error("重置记录缺少卡片标识，未使用重置卡。");
    const response = await rpc("account/rateLimitResetCredit/consume", { idempotencyKey: receipt.attemptId, creditId: receipt.creditId });
    if (!outcomes.includes(String(response.outcome))) throw new Error("重置结果未知，请重试以核对同一次操作。");
    receipt.outcome = response.outcome as ResetOutcome;
    writeReceipt(receiptFile(receipt.attemptId), receipt);
  }
  if (read(activeFile)?.attemptId === receipt.attemptId) fs.rmSync(activeFile, { force: true });
  let resetCredits = unavailableResetCredits("error"), quota: ResetConsumption["quota"] = null, refreshed = false;
  try {
    const updated = await rpc("account/rateLimits/read", {});
    if (updated.accountId !== accountId) throw new Error("identity mismatch");
    resetCredits = normalizeResetCredits(updated);
    const buckets = updated.rateLimitsByLimitId as Record<string, unknown> | undefined;
    const bucket = (buckets?.codex ?? updated.rateLimits) as { primary?: { usedPercent?: number; resetsAt?: number }; secondary?: { usedPercent?: number; resetsAt?: number } } | undefined;
    const windows = [bucket?.primary, bucket?.secondary].filter((v): v is { usedPercent: number; resetsAt?: number } => typeof v?.usedPercent === "number" && Number.isFinite(v.usedPercent));
    windows.sort((a, b) => b.usedPercent - a.usedPercent);
    if (windows[0]) {
      const reset = Number(windows[0].resetsAt) * 1000;
      quota = { remainingPercent: Math.max(0, Math.min(100, 100 - windows[0].usedPercent)), resetAt: windows[0].resetsAt != null && Number.isFinite(new Date(reset).getTime()) ? new Date(reset).toISOString() : null };
    }
    refreshed = resetCredits.state === "ok" && quota !== null;
  } catch { /* The receipt is already durable; report success with refresh pending. */ }
  return { attemptId: receipt.attemptId, outcome: receipt.outcome!, resetCredits, quota, refreshed };
}
