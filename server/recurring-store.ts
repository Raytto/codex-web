import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "./db.js";
import type { RecurringInput, RecurringTask, RecurringRun } from "../src/recurring-types.js";
import { nextOccurrence } from "./recurrence.js";

export function migrateRecurring(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE recurring_tasks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL, reasoning_effort TEXT NOT NULL,
    schedule_json TEXT NOT NULL, max_runs INTEGER, run_count INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK(state IN ('active','paused','completed')), next_run_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  );
  CREATE INDEX recurring_tasks_due ON recurring_tasks(state,next_run_at) WHERE deleted_at IS NULL;
  CREATE INDEX recurring_tasks_owner ON recurring_tasks(user_id,project_id) WHERE deleted_at IS NULL;
  CREATE TABLE recurring_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES recurring_tasks(id), scheduled_at TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    pending_prompt_id TEXT, outcome TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
    UNIQUE(task_id,scheduled_at)
  );
  CREATE INDEX recurring_runs_task ON recurring_runs(task_id,scheduled_at);
  CREATE INDEX recurring_runs_conversation ON recurring_runs(conversation_id);
  CREATE INDEX recurring_runs_pending ON recurring_runs(pending_prompt_id);`);
}
type Row = { id: string; user_id: string; project_id: string; name: string; prompt: string; model: string; reasoning_effort: string; schedule_json: string; max_runs: number | null; run_count: number; state: RecurringTask["state"]; next_run_at: string | null; revision: number; created_at: string };
const view = (r: Row): RecurringTask => ({ id: r.id, project_id: r.project_id, name: r.name, prompt: r.prompt, model: r.model, reasoningEffort: r.reasoning_effort, schedule: JSON.parse(r.schedule_json), maxRuns: r.max_runs, runCount: r.run_count, state: r.state, nextRunAt: r.next_run_at, revision: r.revision, createdAt: r.created_at });
export class RecurringConflict extends Error {}
export class RecurringStore {
  constructor(readonly db: AppDatabase) {}
  private row(user: string, id: string): Row | undefined { return this.db.sqlite.prepare(`SELECT t.* FROM recurring_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.user_id=? AND t.deleted_at IS NULL AND p.archived_at IS NULL`).get(id, user) as Row | undefined; }
  get(user: string, id: string) { const r = this.row(user, id); return r ? view(r) : undefined; }
  list(user: string) { return (this.db.sqlite.prepare(`SELECT t.* FROM recurring_tasks t JOIN projects p ON p.id=t.project_id WHERE t.user_id=? AND t.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY t.created_at,t.id`).all(user) as Row[]).map(view); }
  create(user: string, project: string, input: RecurringInput, now = Date.now()) {
    if (!this.db.getActiveProjectForUser(project, user)) throw new Error("项目不存在。");
    const id = crypto.randomUUID(), time = new Date(now).toISOString();
    this.db.sqlite.prepare(`INSERT INTO recurring_tasks(id,user_id,project_id,name,prompt,model,reasoning_effort,schedule_json,max_runs,state,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)`).run(id, user, project, input.name, input.prompt, input.model, input.reasoningEffort, JSON.stringify(input.schedule), input.maxRuns, nextOccurrence(input.schedule, now), time, time);
    return this.get(user, id)!;
  }
  update(user: string, id: string, revision: number, input: RecurringInput, state: "active" | "paused", now = Date.now()) {
    const current = this.get(user, id);
    if (!current) return undefined;
    if (current.revision !== revision) throw new RecurringConflict("任务已变化，请重新加载后再修改。");
    const exhausted = input.maxRuns !== null && current.runCount >= input.maxRuns;
    const nextState = exhausted ? "completed" : state;
    const scheduleChanged = JSON.stringify(current.schedule) !== JSON.stringify(input.schedule);
    const next = nextState !== "active" ? null : current.state !== "active" || scheduleChanged ? nextOccurrence(input.schedule, now) : current.nextRunAt;
    const result = this.db.sqlite.prepare(`UPDATE recurring_tasks SET name=?,prompt=?,model=?,reasoning_effort=?,schedule_json=?,max_runs=?,state=?,next_run_at=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL`).run(input.name, input.prompt, input.model, input.reasoningEffort, JSON.stringify(input.schedule), input.maxRuns, nextState, next, new Date(now).toISOString(), id, user, revision);
    if (!result.changes) throw new RecurringConflict("任务已变化，请重新加载后再修改。");
    return this.get(user, id)!;
  }
  remove(user: string, id: string, revision: number) {
    const result = this.db.sqlite.prepare(`UPDATE recurring_tasks SET deleted_at=?,state='paused',next_run_at=NULL,revision=revision+1 WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL`).run(new Date().toISOString(), id, user, revision);
    if (!result.changes) throw new RecurringConflict("任务已变化，请重新加载后再删除。");
  }
  runs(user: string, id: string): RecurringRun[] {
    if (!this.get(user, id)) return [];
    return this.db.sqlite.prepare(`SELECT r.id,r.scheduled_at,r.created_at,r.conversation_id,r.reason,
      CASE WHEN r.outcome='skipped' THEN 'skipped' WHEN c.deleted_at IS NOT NULL OR c.id IS NULL THEN 'deleted'
      WHEN EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=c.id AND p.status='queued') THEN 'queued'
      WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status IN ('queued','running')) THEN 'running'
      ELSE COALESCE((SELECT status FROM jobs j WHERE j.conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1),'cancelled') END AS status
      FROM recurring_runs r LEFT JOIN conversations c ON c.id=r.conversation_id WHERE r.task_id=? ORDER BY r.scheduled_at DESC LIMIT 50`).all(id) as RecurringRun[];
  }
  due(now: number) { return this.db.sqlite.prepare(`SELECT t.id,t.user_id FROM recurring_tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.user_id WHERE t.state='active' AND t.deleted_at IS NULL AND t.next_run_at<=? AND p.archived_at IS NULL AND u.status='active' ORDER BY t.next_run_at LIMIT 100`).all(new Date(now).toISOString()) as { id: string; user_id: string }[]; }
  fire(user: string, id: string, now = Date.now()): string | null {
    const sql = this.db.sqlite;
    sql.exec("BEGIN IMMEDIATE");
    try {
      const t = this.get(user, id), time = new Date(now).toISOString();
      if (!t || t.state !== "active" || !t.nextRunAt || t.nextRunAt > time) { sql.exec("COMMIT"); return null; }
      // One outstanding run per task, including an offline queued run or a
      // conversation waiting for a one-shot continuation. Other tasks are independent.
      const busy = sql.prepare(`SELECT 1 FROM recurring_runs r JOIN conversations c ON c.id=r.conversation_id WHERE r.task_id=? AND c.deleted_at IS NULL AND (
        EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=c.id AND p.status='queued') OR
        EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status IN ('queued','running')) OR
        EXISTS(SELECT 1 FROM wake_plans w WHERE w.conversation_id=c.id AND w.state='armed')
      ) LIMIT 1`).get(id);
      let conversationId: string | null = null, pendingId: string | null = null;
      if (!busy) {
        const selection = { model: t.model, reasoningEffort: t.reasoningEffort };
        conversationId = crypto.randomUUID(); pendingId = crypto.randomUUID();
        const stamp = new Intl.DateTimeFormat("zh-CN", { timeZone: t.schedule.timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t.nextRunAt));
        this.db.createConversation(conversationId, `${t.name} · ${stamp}`, selection, user, t.project_id);
        sql.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(conversationId);
        this.db.createPendingPrompt(pendingId, conversationId, t.prompt, selection);
      }
      sql.prepare(`INSERT INTO recurring_runs(id,task_id,scheduled_at,conversation_id,pending_prompt_id,outcome,reason,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), id, t.nextRunAt, conversationId, pendingId, busy ? "skipped" : "created", busy ? "上一轮仍在运行或等待，已跳过本次" : null, time);
      const count = t.runCount + (busy ? 0 : 1), complete = t.maxRuns !== null && count >= t.maxRuns;
      sql.prepare(`UPDATE recurring_tasks SET run_count=?,state=?,next_run_at=?,revision=revision+1,updated_at=? WHERE id=?`).run(count, complete ? "completed" : "active", complete ? null : nextOccurrence(t.schedule, now, Date.parse(t.nextRunAt)), time, id);
      sql.exec("COMMIT"); return conversationId;
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
  }
}
