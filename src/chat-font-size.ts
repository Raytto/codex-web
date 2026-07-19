export const CHAT_FONT_SIZE_MIN = 14;
export const CHAT_FONT_SIZE_MAX = 22;
export const CHAT_FONT_SIZE_DEFAULT = 16;

export function normalizeChatFontSize(value: unknown, fallback = CHAT_FONT_SIZE_DEFAULT): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, Math.round(parsed)));
}
