import type { AntigravityQuotaBucket } from "../remote-worker/src/antigravity-usage-types.js";

export function quotaRemaining(bucket: AntigravityQuotaBucket): string {
  if (bucket.disabled) return "暂不可用";
  if (bucket.remainingPercent !== null) {
    const value = bucket.remainingPercent;
    if (value > 99.9 && value < 100) return ">99.9%";
    if (value > 0 && value < 0.1) return "<0.1%";
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)}%`;
  }
  return bucket.remainingAmount !== null ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(bucket.remainingAmount) : "暂无数据";
}

export function quotaWindow(bucket: AntigravityQuotaBucket): string {
  return ({ weekly: "每周额度", "5h": "5 小时额度", daily: "每日额度", monthly: "每月额度" } as Record<string, string>)[bucket.window ?? ""] || bucket.label;
}

export function quotaGroup(label: string): string {
  return ({ "Gemini Models": "Gemini 模型", "Claude and GPT models": "Claude / GPT 模型" } as Record<string, string>)[label] || label;
}

export function quotaTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function quotaReset(value: string | null, now = Date.now()): string {
  if (!value) return "重置时间暂未提供";
  const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
  if (minutes <= 0) return `${quotaTime(value)} · 已到重置时间，待刷新`;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  const remaining = days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${mins} 分钟` : `${mins} 分钟`;
  return `${quotaTime(value)} 重置 · 约 ${remaining}后`;
}
