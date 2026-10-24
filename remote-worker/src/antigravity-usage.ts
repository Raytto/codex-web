import { runAntigravityCommand, type AntigravityCommandOptions } from "./antigravity-runtime.js";
import type { AntigravityQuotaGroup, AntigravityUsage } from "./antigravity-usage-types.js";

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 200): string | null => typeof value === "string" && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const timestamp = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Accept only the native read-only command envelope, never an agent's answer. */
export function antigravityCommandData(value: unknown, name: "usage" | "credits"): Record<string, unknown> {
  const result = object(value), command = object(result?.command), data = object(command?.data);
  if (result?.status !== "SUCCESS" || result.num_turns !== 0 || command?.name !== name || !data) throw new Error("Antigravity 未返回有效的只读用量数据。");
  return data;
}

export function normalizeAntigravityQuota(value: unknown): AntigravityQuotaGroup[] {
  const data = antigravityCommandData(value, "usage");
  if (!Array.isArray(data.groups) || data.groups.length > 30) throw new Error("Antigravity 额度分组格式无效。");
  return data.groups.map((entry) => {
    const group = object(entry), label = text(group?.name);
    if (!label || !Array.isArray(group?.buckets) || group.buckets.length > 30) throw new Error("Antigravity 额度分组格式无效。");
    return { label, buckets: group.buckets.map((entry) => {
      const bucket = object(entry), id = text(bucket?.id), label = text(bucket?.name);
      if (!id || !label) throw new Error("Antigravity 额度窗口格式无效。");
      const fraction = amount(bucket?.remaining_fraction);
      return { id, label, window: text(bucket?.window, 80), remainingPercent: fraction !== null && fraction <= 1 ? fraction * 100 : null,
        remainingAmount: amount(bucket?.remaining_amount), resetAt: timestamp(bucket?.reset_time), disabled: bucket?.disabled === true };
    }) };
  });
}

export function normalizeAntigravityCredits(value: unknown): number | null {
  return amount(antigravityCommandData(value, "credits").remaining_credits);
}

export function unavailableAntigravityUsage(accountId: string | null, error: string, now = new Date()): AntigravityUsage {
  return { accountId, state: "unavailable", checkedAt: now.toISOString(), quotaUpdatedAt: null, creditsUpdatedAt: null, groups: [], remainingCredits: null, error };
}

/** Pinned AGY 1.4.6 handles these slash commands locally, with num_turns=0.
 * No stream input, prompt inference, account switching, or credits mutation. */
export async function readAntigravityUsage(options: AntigravityCommandOptions & { accountId: string; previous?: AntigravityUsage }): Promise<AntigravityUsage> {
  const read = async (command: "usage" | "credits") => {
    const result = await runAntigravityCommand(["--output-format", "json", "--print", `/${command}`], { ...options, timeoutMs: 10_000 });
    if (result.code !== 0) throw new Error("Antigravity 用量查询未完成。");
    return JSON.parse(result.stdout) as unknown;
  };
  // Sequential commands avoid competing credential refreshes in the same home;
  // both have a bounded deadline inside the host/Worker's 30 second RPC budget.
  const previous = options.previous?.accountId === options.accountId ? options.previous : undefined;
  const snapshot: AntigravityUsage = { accountId: options.accountId, state: "ok", checkedAt: new Date().toISOString(),
    groups: previous?.groups ?? [], quotaUpdatedAt: previous?.quotaUpdatedAt ?? null,
    remainingCredits: previous?.remainingCredits ?? null, creditsUpdatedAt: previous?.creditsUpdatedAt ?? null, error: null };
  const failures: string[] = [];
  try { snapshot.groups = normalizeAntigravityQuota(await read("usage")); snapshot.quotaUpdatedAt = new Date().toISOString(); }
  catch { failures.push("模型额度暂时读取失败"); }
  try { snapshot.remainingCredits = normalizeAntigravityCredits(await read("credits")); snapshot.creditsUpdatedAt = new Date().toISOString(); }
  catch { failures.push("AI credits 暂时读取失败"); }
  snapshot.checkedAt = new Date().toISOString();
  snapshot.state = failures.length === 2 ? "error" : failures.length ? "partial" : "ok";
  snapshot.error = failures.length ? `${failures.join("；")}。已有数值为上次成功查询结果，请稍后刷新。` : null;
  return snapshot;
}
