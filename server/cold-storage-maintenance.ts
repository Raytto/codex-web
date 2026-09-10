// A maintenance run takes one finite snapshot per archive phase. Failed items
// are left for the next timer run; they must not starve the other phases.
export const COLD_MAINTENANCE_STAGES = [
  ["voice-archive", "--all"],
  ["reader-archive", "--all"],
  ["archive", "--all"],
  ["purge", "--grace-days", "7"],
  ["voice-purge", "--grace-days", "7"],
  ["reader-purge", "--grace-days", "7"],
] as const;

export function runColdMaintenanceStages(run: (args: readonly string[]) => boolean): string[] {
  const failed: string[] = [];
  for (const args of COLD_MAINTENANCE_STAGES) {
    try { if (!run(args)) failed.push(args[0]); }
    catch { failed.push(args[0]); }
  }
  return failed;
}

export function coldArchiveLimit(all: boolean, value?: string): number | undefined {
  if (all) {
    if (value !== undefined) throw new Error("--all cannot be combined with --limit");
    return undefined;
  }
  const limit = Number(value ?? "1");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return limit;
}

export function retryColdOperation<T>(operation: () => T, wait = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}): T {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (attempt >= 2) throw error;
      wait((attempt + 1) * 1_000);
    }
  }
}
