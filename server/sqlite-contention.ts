import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// Use the same SQLite extended-code classification as ordered Job events.
import { isSqliteBusy } from './sqlite-job-events.js';
export { isSqliteBusy } from './sqlite-job-events.js';

/** Retry only an explicitly idempotent DB operation, never a model/tool call
 * or a callback that may already have sent an external command. */
export async function retrySqliteBusy<T>(operation: () => T, options: { label: string; maxMs?: number; attempts?: number } ): Promise<T> {
  const started = Date.now(), maxMs = options.maxMs ?? 10_000, attempts = options.attempts ?? 8;
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (!isSqliteBusy(error) || attempt + 1 >= attempts || Date.now() - started >= maxMs) throw error;
      if (!attempt) reportBackgroundError(options.label, error);
      await delay(Math.min(1000, 50 * 2 ** attempt, Math.max(1, maxMs - (Date.now() - started))));
    }
  }
}

/** Keep a busy attempt short on the event loop. No transaction or Promise may
 * escape this scope; the connection's original setting is always restored. */
export function shortSqliteAttempt<T>(db: DatabaseSync, operation: () => T): T {
  const timeout = Number(db.prepare('PRAGMA busy_timeout').get()!.timeout);
  db.exec('PRAGMA busy_timeout=100');
  try { return operation(); }
  finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}

/** Only for synchronous, idempotent initialization before the HTTP listener
 * and background dispatch start. Retry the individual metadata step, never
 * createApp or a user/model/tool operation. All steps share one startup budget. */
export function startupSqliteRetry(db: DatabaseSync, maxMs = 60_000) {
  const deadline = performance.now() + maxMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  return function initialize<T>(label: string, operation: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try { return shortSqliteAttempt(db, operation); }
      catch (error) {
        const remaining = deadline - performance.now();
        if (!isSqliteBusy(error) || attempt >= 63 || remaining <= 0) throw error;
        if (!attempt) reportBackgroundError(label, error);
        Atomics.wait(sleeper, 0, 0, Math.min(1000, 50 * 2 ** Math.min(attempt, 5), remaining));
      }
    }
  };
}

export function reportBackgroundError(operation: string, error: unknown): void {
  // Never include parameters, messages from a peer, SQL text or credentials.
  console.error(JSON.stringify({ event: 'background_operation_failed', operation,
    code: isSqliteBusy(error) ? 'SQLITE_BUSY' : 'OPERATION_FAILED', retryable: isSqliteBusy(error) }));
}

export function guardedCallback(operation: string, callback: () => void): void {
  try { callback(); } catch (error) { reportBackgroundError(operation, error); }
}

/** Latest-value telemetry, bounded per key and in total. Superseded heartbeats
 * need no replay. Failures remain observable; new peer telemetry can try again. */
export class SqliteTelemetry {
  private pending = new Map<string, { write: () => void; started: number; attempts: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private db: DatabaseSync) {}
  put(key: string, write: () => void): void {
    if (this.closed) return;
    const old = this.pending.get(key);
    if (!old && this.pending.size >= 256) { reportBackgroundError('telemetry_capacity', null); return; }
    this.pending.set(key, { write, started: old?.started ?? Date.now(), attempts: old?.attempts ?? 0 });
    if (!this.timer) this.flush();
  }
  private flush(): void {
    this.timer = undefined;
    for (const [key, item] of this.pending) {
      try { shortSqliteAttempt(this.db, item.write); this.pending.delete(key); }
      catch (error) {
        item.attempts++;
        if (item.attempts === 1 || item.attempts >= 8) reportBackgroundError(key, error);
        if (!isSqliteBusy(error) || item.attempts >= 8 || Date.now() - item.started >= 10_000) this.pending.delete(key);
        // One contended writer means the others should yield too.
        if (isSqliteBusy(error)) break;
      }
    }
    if (this.pending.size && !this.closed) {
      const attempts = Math.max(...[...this.pending.values()].map(v => v.attempts));
      this.timer = setTimeout(() => this.flush(), Math.min(1000, 50 * 2 ** attempts));
      this.timer.unref();
    }
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.pending.clear(); }
}
