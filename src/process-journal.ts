import type { JobEvent } from "./api";

const NARRATIVE_KINDS = new Set(["reasoning", "update"]);
const ACTION_KINDS = new Set(["command", "file", "search", "tool", "error"]);

export type ProcessJournalEvent = JobEvent & {
  actionCount?: number;
  groupedDetails?: string[];
};

export function buildProcessJournal(activities: JobEvent[]): ProcessJournalEvent[] {
  const normalized: JobEvent[] = [];
  for (const activity of activities) {
    const kind = activity.kind ?? "";
    if (NARRATIVE_KINDS.has(kind)) {
      if (!activity.detail?.trim()) continue;
      const previous = normalized.at(-1);
      if (previous?.kind === activity.kind && previous?.detail === activity.detail) continue;
      normalized.push(activity);
      continue;
    }
    if (!ACTION_KINDS.has(kind) || !activity.label) continue;
    if (kind === "command" && activity.detail) {
      const earlier = normalized.findLastIndex((item) => item.kind === "command" && item.detail === activity.detail);
      if (earlier >= 0) normalized.splice(earlier, 1);
    }
    const previous = normalized.at(-1);
    if (activitySignature(previous) === activitySignature(activity)) continue;
    normalized.push(activity);
  }

  const journal: ProcessJournalEvent[] = [];
  let commandGroup: ProcessJournalEvent | undefined;
  for (const activity of normalized) {
    if (activity.kind === "update") commandGroup = undefined;
    if (activity.kind !== "command") {
      journal.push(activity);
      continue;
    }
    if (!commandGroup) {
      commandGroup = {
        ...activity,
        actionCount: 1,
        groupedDetails: activity.detail ? [activity.detail] : [],
      };
      journal.push(commandGroup);
      continue;
    }
    commandGroup.actionCount = (commandGroup.actionCount ?? 1) + 1;
    if (activity.detail && !commandGroup.groupedDetails?.includes(activity.detail)) commandGroup.groupedDetails?.push(activity.detail);
    commandGroup.created_at = activity.created_at ?? commandGroup.created_at;
    commandGroup.label = activity.label?.startsWith("正在")
      ? `正在运行 ${commandGroup.actionCount} 个本机步骤`
      : `运行了 ${commandGroup.actionCount} 个本机步骤`;
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
