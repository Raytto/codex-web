import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CodexResetCredits } from "../remote-worker/src/codex-reset-credits.js";
import type { ResetConsumption } from "../remote-worker/src/codex-reset-consumer.js";

export const AUTO_RESET_INTERVAL_MS = 60_000;
const RETRY_MS = 5 * 60_000;
export type AutoResetRecord = {
  id: string; executor_id: string; machine_name: string; account_id: string; account_label: string;
  expires_at: string; attempt_id: string; state: "pending" | "completed" | "failed" | "unconfirmed";
  outcome: ResetConsumption["outcome"] | null; attempts: number; created_at: string; updated_at: string;
  retry_at: string;
};
type Executor = { id: string; machineName: string; online: boolean; supported: boolean };
type Account = { id: string; label: string; resetCredits?: CodexResetCredits | null };
type Dependencies = {
  executors: () => Executor[];
  accounts: (executorId: string) => Promise<{ accounts: Account[] }>;
  consume: (executorId: string, accountId: string, attemptId: string, expiresAt: string) => Promise<ResetConsumption>;
  now?: () => Date;
};

export function migrateAutoReset(db: DatabaseSync): void {
  db.exec(`CREATE TABLE codex_auto_reset_uses (
    id TEXT PRIMARY KEY, executor_id TEXT NOT NULL, machine_name TEXT NOT NULL,
    account_id TEXT NOT NULL, account_label TEXT NOT NULL, expires_at TEXT NOT NULL, attempt_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','unconfirmed')), outcome TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retry_at TEXT NOT NULL,
    UNIQUE(executor_id,account_id,expires_at)
  ); CREATE INDEX codex_auto_reset_retry ON codex_auto_reset_uses(state,retry_at);`);
}

/** Only the server schedules consumption; Workers verify eligibility on fresh data. */
export class CodexResetAutoUse {
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => Date;
  constructor(private readonly db: DatabaseSync, private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }
  stop(): void { this.stopped = true; }
  history(executorId: string): AutoResetRecord[] {
    return this.db.prepare("SELECT * FROM codex_auto_reset_uses WHERE executor_id=? ORDER BY updated_at DESC,id DESC LIMIT 50")
      .all(executorId) as AutoResetRecord[];
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<void> {
    // Machines are independent: one unavailable machine must not delay every other account.
    const results = await Promise.allSettled(this.dependencies.executors().filter(item => item.online && item.supported).map(async executor => {
      const pending = this.db.prepare("SELECT * FROM codex_auto_reset_uses WHERE executor_id=? AND state IN ('pending','failed') AND retry_at<=? ORDER BY created_at")
        .all(executor.id, this.now().toISOString()) as AutoResetRecord[];
      for (const record of pending) {
        if (this.stopped) return;
        await this.attempt(record);
      }
      if (this.stopped) return;
      let accounts: Account[];
      try { ({ accounts } = await this.dependencies.accounts(executor.id)); }
      catch { return; } // No eligible credit has been observed; never infer eligibility from a failed read.
      for (const account of accounts) {
        if (this.stopped) return;
        const credits = account.resetCredits;
        const remaining = Date.parse(credits?.earliestExpiresAt ?? "") - this.now().getTime();
        if (credits?.state !== "ok" || credits.expiryStatus !== "complete" || !credits.availableCount || !(remaining > 0 && remaining <= 3_600_000)) continue;
        const now = this.now().toISOString(), id = crypto.randomUUID(), attemptId = crypto.randomUUID();
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO codex_auto_reset_uses
          (id,executor_id,machine_name,account_id,account_label,expires_at,attempt_id,state,created_at,updated_at,retry_at)
          VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(id, executor.id, executor.machineName, account.id, account.label, credits.earliestExpiresAt!, attemptId, now, now, now);
        if (inserted.changes) await this.attempt(this.db.prepare("SELECT * FROM codex_auto_reset_uses WHERE id=?").get(id) as AutoResetRecord);
      }
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  private async attempt(record: AutoResetRecord): Promise<void> {
    const now = this.now();
    // An ambiguous request may already have consumed its pinned card. Allow receipt
    // recovery after expiry; the owning machine cannot select a new expired card.
    if (now.getTime() > Date.parse(record.expires_at) + 86_400_000) {
      this.db.prepare("UPDATE codex_auto_reset_uses SET state='unconfirmed',updated_at=? WHERE id=?").run(now.toISOString(), record.id);
      return;
    }
    this.db.prepare("UPDATE codex_auto_reset_uses SET state='pending',attempts=attempts+1,updated_at=?,retry_at=? WHERE id=?")
      .run(now.toISOString(), new Date(now.getTime() + RETRY_MS).toISOString(), record.id);
    try {
      const result = await this.dependencies.consume(record.executor_id, record.account_id, record.attempt_id, record.expires_at);
      this.db.prepare("UPDATE codex_auto_reset_uses SET state='completed',outcome=?,updated_at=? WHERE id=?")
        .run(result.outcome, this.now().toISOString(), record.id);
    } catch {
      // Do not store arbitrary upstream errors: they can contain private account data.
      this.db.prepare("UPDATE codex_auto_reset_uses SET state='failed',updated_at=? WHERE id=?").run(this.now().toISOString(), record.id);
    }
  }
}
