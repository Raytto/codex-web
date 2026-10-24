import type { JobEvent } from "./api";

const lifecycleStatuses = new Set(["queued", "running", "retrying", "completed", "failed", "cancelled", "interrupted"]);

export function resolveProcessStatus(activities: JobEvent[]) {
  // Progress notes have no lifecycle status. They must not hide a later wait,
  // and an earlier running event must not override a capacity/memory requeue.
  const latestStatus = activities.findLast((activity) => lifecycleStatuses.has(activity.status ?? ""));
  const queueStatus = latestStatus?.status === "queued" ? latestStatus : undefined;
  const starting = latestStatus?.starting === true
    && (latestStatus.status === "queued" || latestStatus.status === "running");
  return {
    latestStatus,
    queueStatus,
    starting,
    queued: Boolean(queueStatus) && !starting,
    retrying: latestStatus?.status === "retrying",
  };
}
