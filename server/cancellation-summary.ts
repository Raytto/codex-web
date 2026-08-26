import path from "node:path";
import type { JobEventRow, MessageRow } from "./db.js";

export const USER_CANCELLED_TASK_MARKER = "用户主动终止了任务。";

type StoredEventPayload = {
  kind?: string;
  label?: string;
  detail?: string;
  files?: string[];
  items?: Array<{ text?: string; completed?: boolean }>;
};

type SummaryEntry = { seq: number; category: "narrative" | "action" | "plan"; text: string };

export function buildUserCancellationSummary(events: JobEventRow[]): string {
  const entries: SummaryEntry[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    let payload: StoredEventPayload;
    try { payload = JSON.parse(event.payload) as StoredEventPayload; }
    catch { continue; }
    const kind = payload.kind ?? "";
    let category: SummaryEntry["category"] | undefined;
    let text = "";
    if (["reasoning", "update"].includes(kind) && payload.detail?.trim()) {
      category = "narrative";
      text = compactText(payload.detail, 420);
    } else if (kind === "todo" && payload.items?.length) {
      category = "plan";
      const completed = payload.items.filter((item) => item.completed).length;
      const current = payload.items.find((item) => !item.completed)?.text?.trim();
      text = `执行计划完成 ${completed}/${payload.items.length}${current ? `，终止时正在处理：${compactText(current, 180)}` : ""}`;
    } else if (["command", "file", "search", "tool", "error"].includes(kind) && payload.label?.trim()) {
      category = "action";
      const fileNames = kind === "file" && payload.files?.length
        ? `：${payload.files.map((file) => path.basename(file)).join("、")}`
        : "";
      text = `${compactText(payload.label, 180)}${fileNames}`;
    }
    if (!category || !text || seen.has(text)) continue;
    seen.add(text);
    entries.push({ seq: event.seq, category, text });
  }

  const selected = [
    ...entries.filter((entry) => entry.category === "narrative").slice(-5),
    ...entries.filter((entry) => entry.category === "action").slice(-4),
    ...entries.filter((entry) => entry.category === "plan").slice(-1),
  ].sort((left, right) => left.seq - right.seq).slice(-8);
  const lines = [
    `> **${USER_CANCELLED_TASK_MARKER}** 已保留终止前的关键执行记录，后续可以从这里继续。`,
  ];
  if (selected.length > 0) {
    lines.push("", "**终止前的关键执行过程**", ...selected.map((entry) => `- ${entry.text}`));
  }
  return lines.join("\n");
}

export function latestUserCancellationContext(messages: MessageRow[]): string | undefined {
  const latestAssistant = messages.slice().reverse().find((message) => message.role === "assistant");
  return latestAssistant?.content.startsWith(`> **${USER_CANCELLED_TASK_MARKER}**`) ? latestAssistant.content : undefined;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}
