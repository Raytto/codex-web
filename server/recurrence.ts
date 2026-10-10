import type { Recurrence } from "../src/recurring-types.js";

export function validateRecurrence(raw: unknown): Recurrence {
  if (!raw || typeof raw !== "object") throw new Error("请选择重复时间。");
  const s = raw as Recurrence;
  if (!["interval", "daily", "weekly", "monthly"].includes(s.kind)) throw new Error("重复方式无效。");
  if (typeof s.timeZone !== "string" || s.timeZone.length > 100) throw new Error("时区无效。");
  try { new Intl.DateTimeFormat("en", { timeZone: s.timeZone }).format(); } catch { throw new Error("时区无效。"); }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error("执行时间无效。");
  if (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 1 || s.intervalMinutes > 525600) throw new Error("间隔须为 1 至 525600 分钟。");
  if (!Array.isArray(s.weekdays) || s.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6) || (s.kind === "weekly" && !s.weekdays.length)) throw new Error("请选择每周的执行日期。");
  if (!Number.isInteger(s.monthDay) || s.monthDay < 1 || s.monthDay > 31) throw new Error("每月日期无效。");
  return { kind: s.kind, timeZone: s.timeZone, time: s.time, intervalMinutes: s.intervalMinutes, weekdays: [...new Set(s.weekdays)].sort(), monthDay: s.monthDay };
}

// Strictly after `after`. Interval cadence stays anchored to its persisted due time.
// Calendar rules follow the selected zone: skip nonexistent wall times, and run
// only the first occurrence of an ambiguous wall time during a DST fall-back.
export function nextOccurrence(s: Recurrence, after: number, anchor = after): string {
  if (s.kind === "interval") {
    const step = s.intervalMinutes * 60_000;
    return new Date(anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step).toISOString();
  }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: s.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (ms: number) => Object.fromEntries(formatter.formatToParts(ms).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const utcValue = (p: Record<string, number>) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const start = parts(after), [hour, minute] = s.time.split(":").map(Number);
  for (let day = 0; day < 370; day++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + day));
    if (s.kind === "weekly" && !s.weekdays.includes(date.getUTCDay())) continue;
    if (s.kind === "monthly" && date.getUTCDate() !== s.monthDay) continue;
    const wall = date.getTime() + hour * 3600_000 + minute * 60_000;
    const candidates = new Set<number>();
    for (const offset of [-36, 0, 36]) {
      const probe = wall + offset * 3600_000;
      const candidate = wall - (utcValue(parts(probe)) - probe);
      if (utcValue(parts(candidate)) === wall) candidates.add(candidate);
    }
    const first = Math.min(...candidates);
    if (Number.isFinite(first) && first > after) return new Date(first).toISOString();
  }
  throw new Error("无法计算下一次执行时间。");
}
