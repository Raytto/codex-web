export const ROLLOUT_WARNING_BYTES = 500 * 1024 * 1024;

export function formatRolloutBytes(bytes: number): string {
  const mebibyte = 1024 ** 2;
  const gibibyte = 1024 ** 3;
  const unit = bytes >= gibibyte ? "GiB" : "MiB";
  const value = bytes / (unit === "GiB" ? gibibyte : mebibyte);
  return `${value.toFixed(1).replace(/\.0$/, "")} ${unit}`;
}

export function shouldWarnAboutRollout(bytes: number | null | undefined): boolean {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= ROLLOUT_WARNING_BYTES;
}
