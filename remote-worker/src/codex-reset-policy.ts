import { normalizeResetCredits } from "./codex-reset-credits.js";

export const LOW_QUOTA_PERCENT = 1;
export type ResetQuota = { remainingPercent: number; resetAt: string | null };

/** Use the limiting Codex window, without rounding; never infer zero from unknown data. */
export function resetQuota(value: unknown): ResetQuota | null {
  if (!value || typeof value !== "object") return null;
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const source = object(value);
  const bucket = object(object(source.rateLimitsByLimitId).codex ?? source.rateLimits);
  const windows = [object(bucket.primary), object(bucket.secondary)].filter((window): window is { usedPercent: number; resetsAt?: unknown } =>
    typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    && window.usedPercent >= 0);
  windows.sort((a, b) => b.usedPercent - a.usedPercent);
  if (!windows.length) return null;
  const selected = windows[0], reset = selected.resetsAt;
  return { remainingPercent: Math.max(0, 100 - selected.usedPercent),
    resetAt: typeof reset === "number" && Number.isFinite(new Date(reset * 1000).getTime()) ? new Date(reset * 1000).toISOString() : null };
}

/** A stable observation shared by copies of the same account; contains no credit IDs. */
export function lowQuotaKey(quota: ResetQuota | null, credits: ReturnType<typeof normalizeResetCredits>, now = Date.now()): string | null {
  if (!quota || !Number.isFinite(quota.remainingPercent) || quota.remainingPercent < 0 || quota.remainingPercent > LOW_QUOTA_PERCENT
    || !quota.resetAt || Date.parse(quota.resetAt) <= now || credits.state !== "ok"
    || credits.expiryStatus !== "complete" || !credits.availableCount) return null;
  return JSON.stringify([quota.resetAt, credits.availableCount, credits.earliestExpiresAt]);
}

export function validLowQuotaKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160) return false;
  try {
    const row = JSON.parse(value);
    const iso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    return Array.isArray(row) && row.length === 3 && iso(row[0]) && Number.isSafeInteger(row[1]) && row[1] > 0
      && (row[2] === null || iso(row[2])) && JSON.stringify(row) === value;
  } catch { return false; }
}
