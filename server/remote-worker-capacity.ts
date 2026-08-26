export const REMOTE_WORKER_CAPACITY_MAX = 8;

export function normalizeRemoteWorkerCapacity(value: unknown, fallback = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const capacity = Math.floor(numeric);
  if (capacity === 0) return 0;
  return Math.max(1, Math.min(REMOTE_WORKER_CAPACITY_MAX, capacity));
}

export function isValidRemoteWorkerCapacity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= REMOTE_WORKER_CAPACITY_MAX;
}

export function remoteWorkerHasCapacity(activeJobs: number, capacity: number): boolean {
  return capacity === 0 || activeJobs < capacity;
}
