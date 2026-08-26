export const ROLLOUT_WARNING_BYTES = 500 * 1024 * 1024;

export function formatRolloutBytes(bytes: number): string {
  const gibibyte = 1024 ** 3;
  const mebibyte = 1024 ** 2;
  const kibibyte = 1024;
  if (bytes < kibibyte) return `${Math.max(0, Math.round(bytes))} B`;
  const unit = bytes >= gibibyte ? "GiB" : bytes >= mebibyte ? "MiB" : "KiB";
  const divisor = unit === "GiB" ? gibibyte : unit === "MiB" ? mebibyte : kibibyte;
  const value = bytes / divisor;
  return `${value.toFixed(1).replace(/\.0$/, "")} ${unit}`;
}

export function shouldWarnAboutRollout(bytes: number | null | undefined): boolean {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= ROLLOUT_WARNING_BYTES;
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return "暂无数据";
  const normalized = Math.max(0, Math.trunc(tokens));
  if (normalized < 1_000) return String(normalized);
  if (normalized < 1_000_000) return `${(normalized / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(normalized / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatContextUsage(inputTokens: number, modelContextWindow: number | null): string {
  const used = formatTokenCount(inputTokens);
  if (typeof modelContextWindow !== "number" || !Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    return used;
  }
  return `${used} / ${formatTokenCount(modelContextWindow)}`;
}
