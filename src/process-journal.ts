import type { JobEvent } from "./api";

const NARRATIVE_KINDS = new Set(["reasoning", "update"]);
const ACTION_KINDS = new Set(["command", "file", "search", "tool", "error"]);

export function buildProcessJournal(activities: JobEvent[]): JobEvent[] {
  const journal: JobEvent[] = [];
  for (const activity of activities) {
    const kind = activity.kind ?? "";
    if (NARRATIVE_KINDS.has(kind)) {
      if (!activity.detail?.trim()) continue;
      const previous = journal.at(-1);
      if (previous?.kind === activity.kind && previous?.detail === activity.detail) continue;
      journal.push(activity);
      continue;
    }
    if (!ACTION_KINDS.has(kind) || !activity.label) continue;
    if (kind === "command" && activity.detail) {
      const earlier = journal.findLastIndex((item) => item.kind === "command" && item.detail === activity.detail);
      if (earlier >= 0) journal.splice(earlier, 1);
    }
    const previous = journal.at(-1);
    if (activitySignature(previous) === activitySignature(activity)) continue;
    journal.push(activity);
  }
  return journal;
}

export function isNarrativeActivity(activity: JobEvent): boolean {
  return NARRATIVE_KINDS.has(activity.kind ?? "") && Boolean(activity.detail?.trim());
}

function activitySignature(activity: JobEvent | undefined): string {
  if (!activity) return "";
  return JSON.stringify([activity.kind, activity.label, activity.detail, activity.files]);
}
