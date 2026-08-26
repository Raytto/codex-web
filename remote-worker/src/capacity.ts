export const CAPACITY_MAX = 8;

export function normalizeCapacity(value: unknown, fallback = 2): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const capacity = Math.floor(numeric);
  if (capacity === 0) return 0;
  return Math.max(1, Math.min(CAPACITY_MAX, capacity));
}

export function isValidCapacity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= CAPACITY_MAX;
}

export function hasCapacity(activeJobs: number, capacity: number): boolean {
  return capacity === 0 || activeJobs < capacity;
}
