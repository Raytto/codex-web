import fs from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const TASK_MEMORY_BYTES = 4 * 1024 ** 3;
export const TASK_MEMORY_POLL_MS = 2_000;
export type TaskMemoryErrorCode = "MEMORY_WAIT" | "MEMORY_LIMIT" | "MEMORY_GUARD_UNAVAILABLE";
export const MEMORY_WAIT_MESSAGE = "服务器可用内存低于 4 GiB，任务已保留在队列，内存恢复后自动开始";
export const MEMORY_LIMIT_MESSAGE = "任务触发内存保护，已停止（含子 Agent 和工具子进程，合计上限 4 GiB）；请缩小任务后再继续";
export const MEMORY_GUARD_MESSAGE = "任务内存保护暂不可用，任务已保留在队列";

export function taskMemoryEnabled(env = process.env): boolean { return env.TASK_MEMORY_GUARD === "true"; }

export function parseAvailableMemory(text: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  if (!match) return null;
  const bytes = Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export function availableHostMemory(): number | null {
  try { return parseAvailableMemory(fs.readFileSync("/proc/meminfo", "utf8")); }
  catch { return null; }
}

export function memoryDispatchBlock(bytes: number | null): TaskMemoryErrorCode | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "MEMORY_GUARD_UNAVAILABLE";
  return bytes < TASK_MEMORY_BYTES ? "MEMORY_WAIT" : null;
}

export function taskMemoryError(code: TaskMemoryErrorCode | undefined, message?: string): Error & { code?: TaskMemoryErrorCode } {
  return Object.assign(new Error(message ?? (code === "MEMORY_WAIT" ? MEMORY_WAIT_MESSAGE : code === "MEMORY_LIMIT" ? MEMORY_LIMIT_MESSAGE : MEMORY_GUARD_MESSAGE)), { code });
}

export function taskMemoryErrorCode(error: unknown): TaskMemoryErrorCode | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "MEMORY_WAIT" || code === "MEMORY_LIMIT" || code === "MEMORY_GUARD_UNAVAILABLE" ? code : undefined;
}

export function assertTaskMemoryAvailable(read = availableHostMemory): void {
  const blocked = memoryDispatchBlock(read());
  if (blocked) throw taskMemoryError(blocked);
}

// The tiny shell blocks BEFORE Node/Codex loads. Its parent puts this process
// into its memory scope and only then releases the gate. Preserve namespaces,
// UID/GID, cwd, inherited environment and the existing protocol pipe.
export const MEMORY_BOOTSTRAP = 'IFS= read -r ready && test "$ready" = task-memory-ready && exec "$@"';
export function spawnWaitingMemoryWorker(executable: string, args: string[], options: SpawnOptions, token: string): ChildProcess {
  return spawn("/bin/sh", ["-c", MEMORY_BOOTSTRAP, "ppa-memory-bootstrap", executable, ...args], {
    ...options, env: { ...options.env, CWW_MEMORY_WORKER_TOKEN: token },
  });
}

export function releaseMemoryWorker(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null || child.killed || !child.stdin?.writable) {
    throw taskMemoryError("MEMORY_GUARD_UNAVAILABLE");
  }
  child.stdin.write("task-memory-ready\n");
}

export type TaskMemoryScopeResult = { oom: boolean; peakBytes: number | null };
export type TenantMemoryTarget = { userId: string; pid: number; token: string };
