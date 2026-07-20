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
  return [...retainedStageFeedback, ...ordered.slice(rollingStart)];
}
