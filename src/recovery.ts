import type { Conversation, Job, JobEvent } from "./api";

export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const PROCESS_EVENT_WINDOW = 50;
export const RETAINED_STAGE_FEEDBACK_LIMIT = 5;

export function isTerminalJob(job: Job | null | undefined): boolean {
  return Boolean(job && TERMINAL_JOB_STATUSES.has(job.status));
}

export function chooseSelectedConversation(savedId: string | null, conversations: Conversation[]): string | null {
  if (savedId && conversations.some((conversation) => conversation.id === savedId)) return savedId;
  return conversations[0]?.id ?? null;
}

export function mergeJobEvents(current: JobEvent[], incoming: JobEvent[]): JobEvent[] {
  const merged = new Map<number, JobEvent>();
  for (const event of [...current, ...incoming]) merged.set(event.seq ?? -(merged.size + 1), event);
  const ordered = [...merged.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const rollingStart = Math.max(0, ordered.length - PROCESS_EVENT_WINDOW);
  const retainedStageFeedback = ordered
    .slice(0, rollingStart)
    .filter((event) => event.kind === "update")
    .slice(-RETAINED_STAGE_FEEDBACK_LIMIT);
  const rolling = ordered.slice(rollingStart);
  const rollingSet = new Set(rolling);
  const retainedAgents = retainExpiredAgentEvents(ordered, rollingStart).filter((event) => !rollingSet.has(event));
  return [...new Set([...retainedStageFeedback, ...retainedAgents, ...rolling])].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
}

function retainExpiredAgentEvents(events: JobEvent[], rollingStart: number): JobEvent[] {
  const latestByAgent = new Map<string, JobEvent>();
  const pathByAgent = new Map<string, JobEvent>();
  for (const event of events) {
    if (event.kind !== "agent" || !Array.isArray(event.agents)) continue;
    for (const agent of event.agents) { if (!agent?.id) continue; latestByAgent.set(agent.id, event); if (agent.path?.trim()) pathByAgent.set(agent.id, event); }
  }
  const expired = new Set(events.slice(0, rollingStart));
  return [...new Set([...latestByAgent.values(), ...pathByAgent.values()])].filter((event) => expired.has(event));
}
