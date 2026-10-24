/** Node-local account quota, deliberately separate from Codex rate limits. */
export type AntigravityQuotaBucket = {
  id: string;
  label: string;
  window: string | null;
  remainingPercent: number | null;
  remainingAmount: number | null;
  resetAt: string | null;
  disabled: boolean;
};
export type AntigravityQuotaGroup = { label: string; buckets: AntigravityQuotaBucket[] };
export type AntigravityUsage = {
  accountId: string | null;
  state: "ok" | "partial" | "error" | "unavailable";
  checkedAt: string;
  quotaUpdatedAt: string | null;
  creditsUpdatedAt: string | null;
  groups: AntigravityQuotaGroup[];
  remainingCredits: number | null;
  error: string | null;
};
