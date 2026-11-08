import crypto from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { assertTaskMemoryAvailable, releaseMemoryWorker, spawnWaitingMemoryWorker, taskMemoryEnabled, type TaskMemoryScopeResult } from "./task-memory.js";

export type MemoryWorkerBackend = {
  readAvailableMemory?: () => number | null;
  protect(pid: number, token: string): Promise<unknown>;
  finish(token: string): Promise<TaskMemoryScopeResult>;
};

/** Keep the existing worker protocol, but never execute it before protection. */
export function spawnMemoryWorker(executable: string, args: string[], options: SpawnOptions, backend: MemoryWorkerBackend) {
  const guarded = taskMemoryEnabled();
  if (guarded) assertTaskMemoryAvailable(backend.readAvailableMemory);
  const token = crypto.randomUUID();
  const child = guarded ? spawnWaitingMemoryWorker(executable, args, options, token) : spawn(executable, args, options);
  let startError: unknown;
  const ready = guarded ? backend.protect(child.pid!, token).then(() => releaseMemoryWorker(child)).catch(error => {
    startError = error;
    child.kill("SIGKILL");
    throw error;
  }) : Promise.resolve();
  // Callers install protocol/exit listeners before awaiting ready. Avoid an
  // unhandled rejection if a process failure happens during that setup.
  void ready.catch(() => undefined);
  const exited = new Promise<void>(resolve => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const finished = exited.then(async () => {
    await ready.catch(() => undefined);
    const memory = guarded ? await backend.finish(token).catch(() => ({ oom: false, peakBytes: null })) : { oom: false, peakBytes: null };
    return { ...memory, startError };
  });
  return { child, ready, finished };
}
