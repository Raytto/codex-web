import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CodexResetCredits } from "../remote-worker/src/codex-reset-credits.js";
import type { ResetConsumption } from "../remote-worker/src/codex-reset-consumer.js";
import { lowQuotaKey, LOW_QUOTA_PERCENT } from "../remote-worker/src/codex-reset-policy.js";

export const AUTO_RESET_INTERVAL_MS = 60_000;
const RETRY_MS = 5 * 60_000;
export type AutoResetRecord = {
  id: string; executor_id: string; machine_name: string; account_id: string; account_label: string; account_key: string;
  expires_at: string | null; trigger_key: string | null; reason: "expiry" | "quota"; quota_key: string | null;
  attempt_id: string; state: "pending" | "completed" | "failed" | "unconfirmed";
  outcome: ResetConsumption["outcome"] | null; attempts: number; created_at: string; updated_at: string;
  retry_at: string;
};
type Executor = { id: string; machineName: string; online: boolean; supported: boolean; lowQuotaSupported?: boolean };
type Account = { resetAccountKey?: string; id: string; label: string; resetCredits?: CodexResetCredits | null;
  quotaRemainingPercent?: number | null; quotaResetAt?: string | null; quotaUpdatedAt?: string | null };
type Dependencies = {
  executors: () => Executor[];
  accounts: (executorId: string) => Promise<{ accounts: Account[] }>;
  consume: (executorId: string, accountId: string, attemptId: string, expiresAt: string | undefined, quotaKey?: string) => Promise<ResetConsumption>;
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

export function migrateAutoResetPreferences(db: DatabaseSync): void {
  // Preserve all previous receipts; replace only the expiration-only uniqueness rule.
  db.exec(`ALTER TABLE codex_auto_reset_uses RENAME TO codex_auto_reset_uses_old;
    DROP INDEX codex_auto_reset_retry;
    CREATE TABLE codex_auto_reset_uses (
      id TEXT PRIMARY KEY, executor_id TEXT NOT NULL, machine_name TEXT NOT NULL,
      account_id TEXT NOT NULL, account_label TEXT NOT NULL, expires_at TEXT, attempt_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','unconfirmed')), outcome TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retry_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'expiry' CHECK(reason IN ('expiry','quota')), quota_key TEXT,
      trigger_key TEXT, account_key TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX codex_auto_reset_trigger ON codex_auto_reset_uses(executor_id,account_id,COALESCE(trigger_key,'expiry:'||expires_at));
    INSERT INTO codex_auto_reset_uses SELECT *, 'expiry', NULL, 'expiry:'||expires_at, executor_id||':'||account_id FROM codex_auto_reset_uses_old;
    DROP TABLE codex_auto_reset_uses_old;
    CREATE INDEX codex_auto_reset_retry ON codex_auto_reset_uses(state,retry_at);
    CREATE TABLE codex_auto_reset_preferences (
      executor_id TEXT NOT NULL, account_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      PRIMARY KEY(executor_id,account_id));
    CREATE TABLE codex_auto_reset_guards (account_key TEXT PRIMARY KEY, low_armed INTEGER NOT NULL CHECK(low_armed IN (0,1)), updated_at TEXT NOT NULL);`);
}

export function autoResetPreference(db: DatabaseSync, executorId: string, accountId: string, accountKey?: string): boolean {
  // A checkbox governs the actual upstream account, including its other saved copies.
  // Older Workers without the fingerprint retain machine-local compatibility until upgraded.
  const shared = accountKey && /^[a-f0-9]{64}$/.test(accountKey)
    ? db.prepare("SELECT enabled FROM codex_auto_reset_preferences WHERE executor_id='account' AND account_id=?").get(accountKey)?.enabled : undefined;
  return (shared ?? db.prepare("SELECT enabled FROM codex_auto_reset_preferences WHERE executor_id=? AND account_id=?").get(executorId, accountId)?.enabled ?? 1) === 1;
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
  enabled(executorId: string, accountId: string, accountKey?: string): boolean { return autoResetPreference(this.db, executorId, accountId, accountKey); }
  setEnabled(executorId: string, accountId: string, enabled: boolean, accountKey?: string): void {
    if (accountKey && /^[a-f0-9]{64}$/.test(accountKey)) { executorId = "account"; accountId = accountKey; }
    this.db.prepare(`INSERT INTO codex_auto_reset_preferences(executor_id,account_id,enabled) VALUES(?,?,?)
      ON CONFLICT(executor_id,account_id) DO UPDATE SET enabled=excluded.enabled`).run(executorId, accountId, enabled ? 1 : 0);
  }
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
        if (record.reason !== "quota" || executor.lowQuotaSupported) await this.attempt(record);
      }
      if (this.stopped) return;
      let accounts: Account[];
      try { ({ accounts } = await this.dependencies.accounts(executor.id)); }
      catch { return; } // No eligible credit has been observed; never infer eligibility from a failed read.
      for (const account of accounts) {
        if (this.stopped) return;
        if (!this.enabled(executor.id, account.id, account.resetAccountKey)) continue;
        const credits = account.resetCredits;
        const accountKey = account.resetAccountKey && /^[a-f0-9]{64}$/.test(account.resetAccountKey) ? account.resetAccountKey : `${executor.id}:${account.id}`;
        const fresh = account.quotaUpdatedAt && this.now().getTime() - Date.parse(account.quotaUpdatedAt) >= 0
          && this.now().getTime() - Date.parse(account.quotaUpdatedAt) <= 120_000;
        if (fresh && typeof account.quotaRemainingPercent === "number" && account.quotaRemainingPercent > LOW_QUOTA_PERCENT) {
          this.db.prepare("UPDATE codex_auto_reset_guards SET low_armed=1 WHERE account_key=? AND updated_at<?").run(accountKey, account.quotaUpdatedAt!);
        }
        // Never overlap an uncertain operation or cascade cards while quota propagation is delayed.
        if (this.db.prepare(`SELECT 1 FROM codex_auto_reset_uses WHERE (account_key=? OR (executor_id=? AND account_id=?))
          AND (state IN ('pending','failed','unconfirmed') OR (outcome IN ('reset','alreadyRedeemed') AND updated_at>?)) LIMIT 1`)
          .get(accountKey, executor.id, account.id, new Date(this.now().getTime() - RETRY_MS).toISOString())) continue;
        const armed = this.db.prepare("SELECT low_armed FROM codex_auto_reset_guards WHERE account_key=?").get(accountKey)?.low_armed ?? 1;
        const quotaKey = fresh && armed === 1 && executor.lowQuotaSupported && credits ? lowQuotaKey({
          remainingPercent: account.quotaRemainingPercent ?? NaN, resetAt: account.quotaResetAt ?? null,
        }, credits, this.now().getTime()) : null;
        const remaining = Date.parse(credits?.earliestExpiresAt ?? "") - this.now().getTime();
        const due = credits?.state === "ok" && credits.expiryStatus === "complete" && credits.availableCount && remaining > 0 && remaining <= 3_600_000;
        if (!quotaKey && !due) continue;
        const now = this.now().toISOString(), id = crypto.randomUUID(), attemptId = crypto.randomUUID();
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO codex_auto_reset_uses
          (id,executor_id,machine_name,account_id,account_label,expires_at,attempt_id,state,created_at,updated_at,retry_at,reason,quota_key,trigger_key,account_key)
          VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`).run(id, executor.id, executor.machineName, account.id, account.label,
            // A legacy scheduler must age out quota attempts, never reinterpret them as manual/expiry redemption.
            quotaKey ? "1970-01-01T00:00:00.000Z" : credits?.earliestExpiresAt ?? null, attemptId, now, now, now, quotaKey ? "quota" : "expiry", quotaKey,
            quotaKey ? `quota:${quotaKey}` : `expiry:${credits!.earliestExpiresAt}`, accountKey);
        if (inserted.changes) await this.attempt(this.db.prepare("SELECT * FROM codex_auto_reset_uses WHERE id=?").get(id) as AutoResetRecord);
      }
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  private async attempt(record: AutoResetRecord): Promise<void> {
    if (!this.enabled(record.executor_id, record.account_id, record.account_key)) return;
    const now = this.now();
    // An ambiguous request may already have consumed its pinned card. Allow receipt
    // recovery after expiry; the owning machine cannot select a new expired card.
    if (now.getTime() > Date.parse(record.reason === "quota" ? record.created_at : record.expires_at!) + 86_400_000) {
      this.db.prepare("UPDATE codex_auto_reset_uses SET state='unconfirmed',updated_at=? WHERE id=?").run(now.toISOString(), record.id);
      return;
    }
    this.db.prepare("UPDATE codex_auto_reset_uses SET state='pending',attempts=attempts+1,updated_at=?,retry_at=? WHERE id=?")
      .run(now.toISOString(), new Date(now.getTime() + RETRY_MS).toISOString(), record.id);
    try {
      const result = await this.dependencies.consume(record.executor_id, record.account_id, record.attempt_id,
        record.reason === "expiry" ? record.expires_at! : undefined, record.quota_key ?? undefined);
      this.db.prepare("UPDATE codex_auto_reset_uses SET state='completed',outcome=?,updated_at=? WHERE id=?")
        .run(result.outcome, this.now().toISOString(), record.id);
      if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
        this.db.prepare(`INSERT INTO codex_auto_reset_guards(account_key,low_armed,updated_at) VALUES(?,?,?)
          ON CONFLICT(account_key) DO UPDATE SET low_armed=excluded.low_armed,updated_at=excluded.updated_at`).run(record.account_key,
            result.quota && result.quota.remainingPercent > LOW_QUOTA_PERCENT ? 1 : 0, this.now().toISOString());
      }
    } catch {
      // Do not store arbitrary upstream errors: they can contain private account data.
      this.db.prepare("UPDATE codex_auto_reset_uses SET state='failed',updated_at=? WHERE id=?").run(this.now().toISOString(), record.id);
    }
  }
}
