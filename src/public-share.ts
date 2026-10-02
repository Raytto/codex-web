export const PUBLIC_SHARE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

// Missing or invalid deadlines fail closed, including legacy clients/rows.
export function isPublicShareActive(enabled: boolean | number | undefined, expiresAt: string | null | undefined, now = Date.now()): boolean {
  return Boolean(enabled && expiresAt && Date.parse(expiresAt) > now);
}

export function publicShareRemaining(expiresAt: string | null, now: number): string {
  // A mutation response can arrive between clock ticks; never briefly show
  // "31 days" for a fresh 30-day share because the last tick is milliseconds old.
  const remaining = expiresAt ? Math.min(PUBLIC_SHARE_LIFETIME_MS, Date.parse(expiresAt) - now) : 0;
  if (!(remaining > 0)) return "已到期";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.ceil(remaining / 3_600_000);
  return hours < 24 ? `剩余 ${hours} 小时` : `剩余 ${Math.ceil(remaining / 86_400_000)} 天`;
}
