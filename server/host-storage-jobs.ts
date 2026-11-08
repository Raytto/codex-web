import { fork, type ChildProcess } from "node:child_process";
import type { HostStorageRequest, HostStorageResult } from "./host-storage-worker.js";

type Entry = {
  request: HostStorageRequest;
  promise: Promise<number | undefined>;
  resolve: (removed?: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  child?: ChildProcess;
  failure?: Error;
};

/** Storage operations belong to the bridge, not to a transient RPC socket.
 * A disconnected caller can reattach to the same operation. Restart/timeout
 * leaves the existing durable restoring/tombstone intent for a verified retry. */
export class HostStorageJobs {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private active = 0;
  private stopped = false;

  constructor(private readonly options: {
    workerUrl?: URL;
    concurrency?: number;
    maxPending?: number;
    timeoutMs?: number;
  } = {}) {}

  run(request: HostStorageRequest): Promise<number | undefined> {
    if (this.stopped) return Promise.reject(new Error("宿主存储服务正在停止，可稍后重试"));
    const key = JSON.stringify([request.operation, request.userId, request.id, request.threadId??null]);
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    if (this.entries.size >= (this.options.maxPending ?? 32)) {
      return Promise.reject(new Error("存储恢复队列已满，请稍后重试"));
    }
    let resolve!: Entry["resolve"];
    let reject!: Entry["reject"];
    const promise = new Promise<number | undefined>((yes, no) => { resolve = yes; reject = no; });
    // Queue time, download, decryption and installation share one deadline.
    // Finish just before the existing six-hour restore RPC deadline.
    const timeoutMs = this.options.timeoutMs ?? (request.operation === "collect_records" ? 55_000
      : request.operation === "remove_reader" ? 10 * 60_000 - 5_000 : 6 * 60 * 60_000 - 5_000);
    const timer = setTimeout(() => this.cancel(key, new Error("存储操作超时，恢复记录已保留，可重试")), timeoutMs);
    this.entries.set(key, { request, promise, resolve, reject, timer });
    this.queue.push(key);
    this.pump();
    return promise;
  }

  stop(): void {
    this.stopped = true;
    for (const key of this.entries.keys()) this.cancel(key, new Error("宿主存储服务已停止，恢复记录已保留"));
  }

  private cancel(key: string, error: Error): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.failure = error;
    if (!entry.child) { this.finish(key, error); return; }
    // Kill the process group, including synchronous download/decrypt children.
    // Do not free the slot until close proves that this attempt has stopped.
    this.kill(entry.child);
  }

  private kill(child: ChildProcess): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
    }
  }

  private finish(key: string, error?: Error, removed?: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(key);
    const queued = this.queue.indexOf(key);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (entry.child) this.active--;
    if (error) entry.reject(error); else entry.resolve(removed);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < (this.options.concurrency ?? 1) && this.queue.length) {
      const key = this.queue.shift()!;
      const entry = this.entries.get(key)!;
      let child: ChildProcess;
      try {
        child = fork(this.options.workerUrl ?? new URL("./host-storage-worker.js", import.meta.url), [], {
          detached: process.platform !== "win32", execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {...process.env,PPAGENT_STORAGE_MAINTENANCE:'1'},
        });
      } catch (error) { this.finish(key, error as Error); continue; }
      entry.child = child;
      this.active++;
      let result: HostStorageResult | undefined;
      child.on("message", (value: HostStorageResult) => {
        if (value && typeof value.ok === "boolean") result = value;
      });
      child.on("error", error => { entry.failure ??= error; this.kill(child); });
      child.once("exit", () => this.kill(child)); // Reap any tool left by an abnormal worker exit.
      child.once("close", (code, signal) => {
        const error = entry.failure ?? (code !== 0 || !result
          ? new Error(`存储子进程退出 (${signal ?? code})，恢复记录已保留`)
          : result.ok ? undefined : new Error(result.error));
        this.finish(key, error, result?.ok ? result.removed : undefined);
      });
      child.send(entry.request, error => { if (error) this.cancel(key, error); });
    }
  }
}
