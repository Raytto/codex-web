/** Safe, account-scoped display data; never include credit IDs or credentials. */
export type CodexResetCredits = {
  availableCount: number | null;
  earliestExpiresAt: string | null;
  expiryStatus: "complete" | "partial" | "unknown";
  state: "ok" | "unavailable" | "auth_required" | "error";
  updatedAt: string | null;
  checkedAt: string;
};

export function unavailableResetCredits(state: CodexResetCredits["state"] = "unavailable", now = new Date()): CodexResetCredits {
  return { availableCount: null, earliestExpiresAt: null, expiryStatus: "unknown", state, updatedAt: null, checkedAt: now.toISOString() };
}

export function normalizeResetCredits(value: unknown, now = new Date()): CodexResetCredits {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>).rateLimitResetCredits : null;
  const summary = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const count = summary?.availableCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return unavailableResetCredits("unavailable", now);
  const result: CodexResetCredits = { availableCount: count, earliestExpiresAt: null, expiryStatus: count === 0 ? "complete" : "unknown", state: "ok", updatedAt: now.toISOString(), checkedAt: now.toISOString() };
  if (!count || !Array.isArray(summary?.credits)) return result;
  const ids = new Set<string>();
  const expiry: number[] = [];
  for (const item of summary.credits) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || item.status !== "available" || item.resetType !== "codexRateLimits") continue;
    if (item.expiresAt === null) { ids.add(item.id); continue; }
    if (typeof item.expiresAt !== "number" || !Number.isFinite(item.expiresAt)) continue;
    const timestamp = item.expiresAt * 1000;
    if (!Number.isFinite(new Date(timestamp).getTime()) || timestamp <= now.getTime()) continue;
    ids.add(item.id);
    expiry.push(timestamp);
  }
  result.expiryStatus = ids.size === count ? "complete" : "partial";
  if (expiry.length) result.earliestExpiresAt = new Date(Math.min(...expiry)).toISOString();
  return result;
}

export function mergeResetCredits(previous: CodexResetCredits | null, next: CodexResetCredits): CodexResetCredits {
  if (previous && Date.parse(previous.checkedAt) > Date.parse(next.checkedAt)) return previous;
  // A failed/unsupported read is not a zero balance and must not re-date old data.
  if (next.state !== "ok" && previous?.updatedAt) return { ...previous, state: next.state, checkedAt: next.checkedAt };
  return next;
}
