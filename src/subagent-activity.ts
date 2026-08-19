import type { JobEvent, SubagentEventState, SubagentStatus } from "./api";

const ACTIVE_STATUSES = new Set<SubagentStatus>(["pending", "running"]);
export type SubagentView = { id: string; path: string; name: string; status: SubagentStatus; summary: string; startedAt: string | null; updatedAt: string | null };

export function buildSubagentActivity(activities: JobEvent[]) {
  const agents = new Map<string, SubagentView>();
  for (const activity of activities) {
    if (activity.kind !== "agent" || !Array.isArray(activity.agents)) continue;
    for (const state of activity.agents) mergeAgentState(agents, state, activity.created_at ?? null);
  }
  const ordered = [...agents.values()].sort((left, right) => Number(ACTIVE_STATUSES.has(right.status)) - Number(ACTIVE_STATUSES.has(left.status)) || timestamp(left.startedAt) - timestamp(right.startedAt) || left.name.localeCompare(right.name));
  const active = ordered.filter((agent) => ACTIVE_STATUSES.has(agent.status));
  const done = ordered.filter((agent) => !ACTIVE_STATUSES.has(agent.status));
  return { agents: ordered, active, done, completedCount: done.filter((agent) => agent.status === "completed").length, failedCount: done.filter((agent) => ["failed", "interrupted"].includes(agent.status)).length };
}

export function subagentStatusLabel(status: SubagentStatus): string {
  if (status === "pending") return "准备中";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "interrupted") return "已停止";
  return "失败";
}

function mergeAgentState(agents: Map<string, SubagentView>, state: SubagentEventState, createdAt: string | null): void {
  const id = typeof state.id === "string" ? state.id.trim() : "";
  if (!id) return;
  const existing = agents.get(id);
  const path = cleanText(state.path, 500) || existing?.path || "";
  const status = normalizeStatus(state.status) ?? existing?.status ?? "pending";
  const nextStatus = existing && isTerminal(existing.status) && !isTerminal(status) ? existing.status : status;
  const summary = cleanText(state.summary, 2_000) || existing?.summary || "";
  agents.set(id, { id, path, name: path.split(/[\\/]/).filter(Boolean).at(-1)?.trim() || `Agent ${id.slice(0, 8)}`, status: nextStatus, summary, startedAt: existing?.startedAt ?? createdAt, updatedAt: createdAt ?? existing?.updatedAt ?? null });
}

function normalizeStatus(value: unknown): SubagentStatus | null { return ["pending", "running", "completed", "failed", "interrupted"].includes(String(value)) ? value as SubagentStatus : null; }
function cleanText(value: unknown, maximum: number): string { return typeof value === "string" ? value.trim().slice(0, maximum) : ""; }
function isTerminal(status: SubagentStatus): boolean { return !ACTIVE_STATUSES.has(status); }
function timestamp(value: string | null): number { const parsed = value ? Date.parse(value) : 0; return Number.isFinite(parsed) ? parsed : 0; }
