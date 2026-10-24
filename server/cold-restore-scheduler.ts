// The database's restoring state is the durable intent. Timers only arrange
// another attempt; startup re-enqueues that same intent after a restart.
export function createColdRestoreScheduler(options: {
  restore: (id: string, userId: string) => Promise<void>;
  needsRetry: (id: string) => boolean;
  settled: (id: string) => void;
  failed: (id: string, error: unknown) => void;
  retryMs?: number;
}) {
  const running = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  function schedule(id: string, userId: string) {
    if (stopped || running.has(id) || timers.has(id)) return;
    running.add(id);
    void Promise.resolve().then(() => options.restore(id, userId)).catch(error => {
      if (!stopped) options.failed(id, error);
    }).finally(() => {
      running.delete(id);
      if (stopped) return;
      options.settled(id);
      if (!options.needsRetry(id)) return;
      const timer = setTimeout(() => {
        timers.delete(id);
        schedule(id, userId);
      }, options.retryMs ?? 15_000);
      timer.unref();
      timers.set(id, timer);
    });
  }
  return { schedule, stop() {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  } };
}
