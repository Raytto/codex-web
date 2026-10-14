import type { Recurrence } from "./recurring-types";

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

export function recurrenceLabel(schedule: Recurrence): string {
  if (schedule.kind === "interval") {
    const minutes = schedule.intervalMinutes;
    if (minutes < 120) return `每 ${minutes} 分钟`;
    const parts = [
      [Math.floor(minutes / 1440), "天"],
      [Math.floor(minutes % 1440 / 60), "小时"],
      [minutes % 60, "分钟"],
    ] as const;
    return `每 ${parts.filter(([value]) => value > 0).map(([value, unit]) => `${value} ${unit}`).join(" ")}`;
  }
  return `${schedule.kind === "daily" ? "每天" : schedule.kind === "weekly" ? `每周${schedule.weekdays.map(d => weekdays[d]).join("、")}` : `每月 ${schedule.monthDay} 日`} ${schedule.time}`;
}
