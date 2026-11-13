import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type WorkflowState = "queued" | "active" | "blocked" | "closing" | "completed" | "aborted";
export type WorkflowRow = { id: string; seq: number; priority: number; user_id: string; title: string; state: WorkflowState; phase: string; reason: string; revision: number; epoch: number; evidence: string | null; closing_job: string | null; source_key: string | null; created_at: string; updated_at: string };
const terminal = (w: WorkflowRow) => w.state === "completed" || w.state === "aborted";
export function workflowCapacity(value: unknown): number {
  if (value === undefined || value === "") return -1;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (n !== -1 && (n < 1 || n > 10000))) throw new Error("MAX_ACTIVE_WORKFLOWS must be -1 (unlimited) or an integer from 1 to 10000");
  return n;
}

/** Durable business ownership, independent of Job/process lifetime. Shared by both instances. */
export class WorkflowStore {
  constructor(readonly sql: DatabaseSync) {}
  /** B's initial release used the voice migration number. Move only that ledger entry. */
  static normalizeLegacyMigration(sql: DatabaseSync): void {
    sql.exec('BEGIN IMMEDIATE');
    try {
      const legacy=sql.prepare("SELECT name FROM schema_migrations WHERE version=2026110701").get() as {name:string}|undefined;
      if(legacy?.name==='durable-complete-workflows') {
        const target=sql.prepare("SELECT name FROM schema_migrations WHERE version=2026110802").get() as {name:string}|undefined;
        if(target && target.name!=='durable-complete-workflows')throw new Error('Workflow migration number conflict');
        if(target)sql.prepare("DELETE FROM schema_migrations WHERE version=2026110701 AND name='durable-complete-workflows'").run();
        else sql.prepare("UPDATE schema_migrations SET version=2026110802 WHERE version=2026110701 AND name='durable-complete-workflows'").run();
      }
      sql.exec('COMMIT');
    }catch(error){sql.exec('ROLLBACK');throw error;}
  }
  static migrate(sql: DatabaseSync): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS workflow_settings(id INTEGER PRIMARY KEY CHECK(id=1), capacity INTEGER NOT NULL DEFAULT -1, paused INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO workflow_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS workflows(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, priority INTEGER NOT NULL DEFAULT 0, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','active','blocked','closing','completed','aborted')),
        phase TEXT NOT NULL DEFAULT '排队', reason TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, epoch INTEGER NOT NULL DEFAULT 0,
        evidence TEXT, closing_job TEXT, source_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflows_state_seq ON workflows(state,seq);
      CREATE TABLE IF NOT EXISTS workflow_conversations(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, workflow_id TEXT NOT NULL REFERENCES workflows(id));
      CREATE TABLE IF NOT EXISTS workflow_entities(kind TEXT NOT NULL, entity_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, PRIMARY KEY(kind,entity_id));
      CREATE INDEX IF NOT EXISTS workflow_entities_owner ON workflow_entities(workflow_id,kind);
      CREATE TABLE IF NOT EXISTS workflow_runs(job_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, epoch INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workflow_releases(workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, instance TEXT NOT NULL, request_id INTEGER NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(workflow_id,instance,request_id));
      CREATE TABLE IF NOT EXISTS workflow_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS workflow_audit AFTER UPDATE OF state,phase,reason ON workflows
      BEGIN INSERT INTO workflow_events(workflow_id,action,detail,created_at) VALUES(NEW.id,NEW.state,NEW.phase||': '||NEW.reason,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
    `);
    const attach = (table: string, kind: string, suffix: string, timing: string, condition: string) => sql.exec(`
      CREATE TRIGGER IF NOT EXISTS workflow_attach_${suffix} AFTER ${timing} ON ${table} ${condition}
      BEGIN
        DELETE FROM workflow_conversations WHERE conversation_id=NEW.conversation_id AND workflow_id IN (SELECT id FROM workflows WHERE state IN ('completed','aborted'));
        INSERT INTO workflows(id,user_id,title,created_at,updated_at)
          SELECT lower(hex(randomblob(16))),user_id,substr(title,1,160),NEW.created_at,NEW.created_at FROM conversations
          WHERE id=NEW.conversation_id AND NOT EXISTS(SELECT 1 FROM workflow_conversations WHERE conversation_id=NEW.conversation_id);
        INSERT OR IGNORE INTO workflow_conversations SELECT NEW.conversation_id,id FROM workflows
          WHERE seq=last_insert_rowid() AND NOT EXISTS(SELECT 1 FROM workflow_conversations WHERE conversation_id=NEW.conversation_id);
        INSERT OR IGNORE INTO workflow_entities SELECT '${kind}',NEW.id,workflow_id FROM workflow_conversations WHERE conversation_id=NEW.conversation_id;
        UPDATE workflows SET state=CASE WHEN state='closing' THEN 'active' ELSE state END, closing_job=NULL, evidence=NULL, revision=revision+1,
          reason=CASE WHEN state='closing' THEN '收到补充，需重新核验完成条件' ELSE reason END
          WHERE id=(SELECT workflow_id FROM workflow_entities WHERE kind='${kind}' AND entity_id=NEW.id);
      END;
    `);
    attach("jobs", "job", "job", "INSERT", "");
    attach("pending_prompts", "pending", "pending", "INSERT", "WHEN NEW.status='queued'");
    attach("pending_prompts", "pending", "pending_ready", "UPDATE OF status", "WHEN NEW.status='queued' AND OLD.status<>'queued'");
    // New-conversation continuations inherit the original Job, never become unrelated work.
    sql.exec(`CREATE TRIGGER IF NOT EXISTS workflow_attach_wake AFTER INSERT ON wake_plans
      BEGIN
        INSERT OR REPLACE INTO workflow_conversations SELECT NEW.conversation_id,workflow_id FROM workflow_entities WHERE kind='job' AND entity_id=NEW.created_by_job_id;
        INSERT INTO workflow_entities SELECT 'wake',NEW.id,workflow_id FROM workflow_conversations WHERE conversation_id=NEW.conversation_id;
        UPDATE workflows SET state=CASE WHEN state='closing' THEN 'active' ELSE state END,phase='等待续跑',evidence=NULL,closing_job=NULL,revision=revision+1
          WHERE id=(SELECT workflow_id FROM workflow_entities WHERE kind='wake' AND entity_id=NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS workflow_claim BEFORE UPDATE OF status ON jobs WHEN NEW.status='running' AND OLD.status<>'running'
      BEGIN
        SELECT CASE WHEN (SELECT paused FROM workflow_settings WHERE id=1)=1 THEN RAISE(ABORT,'WORKFLOW_PAUSED') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM workflows w JOIN workflow_entities e ON e.workflow_id=w.id WHERE e.kind='job' AND e.entity_id=NEW.id AND w.state IN ('completed','aborted','closing')) THEN RAISE(ABORT,'WORKFLOW_CLOSED') END;
        SELECT CASE WHEN (SELECT capacity FROM workflow_settings WHERE id=1)>0 AND EXISTS(
          SELECT 1 FROM workflows w JOIN workflow_entities e ON e.workflow_id=w.id WHERE e.kind='job' AND e.entity_id=NEW.id AND w.state='queued'
          AND ((SELECT count(*) FROM workflows WHERE state IN ('active','blocked','closing')) >= (SELECT capacity FROM workflow_settings WHERE id=1)
            OR (SELECT count(*) FROM workflows WHERE state='queued' AND (priority>w.priority OR (priority=w.priority AND seq<w.seq))) + (SELECT count(*) FROM workflows WHERE state IN ('active','blocked','closing')) >= (SELECT capacity FROM workflow_settings WHERE id=1))
        ) THEN RAISE(ABORT,'WORKFLOW_LIMIT') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM workflow_runs r JOIN workflow_entities e ON e.workflow_id=r.workflow_id WHERE e.kind='job' AND e.entity_id=NEW.id AND r.settled=0) THEN RAISE(ABORT,'WORKFLOW_EXECUTOR_UNSETTLED') END;
        UPDATE workflows SET state='active',phase='执行中',reason='',epoch=epoch+1,revision=revision+1,updated_at=NEW.updated_at
          WHERE id=(SELECT workflow_id FROM workflow_entities WHERE kind='job' AND entity_id=NEW.id);
        INSERT OR REPLACE INTO workflow_runs SELECT NEW.id,w.id,w.epoch,0 FROM workflows w JOIN workflow_entities e ON e.workflow_id=w.id WHERE e.kind='job' AND e.entity_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS workflow_no_delete BEFORE UPDATE OF deleted_at,archived_at ON conversations
      WHEN (NEW.deleted_at IS NOT NULL OR NEW.archived_at IS NOT NULL) AND (SELECT capacity FROM workflow_settings WHERE id=1)>0
        AND EXISTS(SELECT 1 FROM workflow_conversations c JOIN workflows w ON w.id=c.workflow_id WHERE c.conversation_id=NEW.id AND w.state NOT IN ('completed','aborted'))
      BEGIN SELECT RAISE(ABORT,'请先完成修改或安全取消，归档/删除不能释放修改名额'); END;
    `);
  }
  adoptLegacy(): void {
    const rows=this.sql.prepare(`SELECT c.id,c.user_id,c.title,c.created_at,
      EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status='running') AS running,
      EXISTS(SELECT 1 FROM wake_plans p WHERE p.conversation_id=c.id AND p.state='armed') AS waiting
      FROM conversations c WHERE c.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM workflow_conversations w WHERE w.conversation_id=c.id)
      AND (EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status IN ('running','queued')) OR
        EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=c.id AND p.status='queued') OR
        EXISTS(SELECT 1 FROM wake_plans p WHERE p.conversation_id=c.id AND p.state='armed')) ORDER BY c.created_at,c.id`).all() as Array<{id:string;user_id:string;title:string;created_at:string;running:number;waiting:number}>;
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      for(const c of rows){
        const id=crypto.randomUUID(), held=c.running||c.waiting;
        this.sql.prepare("INSERT INTO workflows(id,user_id,title,state,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,c.user_id,c.title,held?'blocked':'queued',held?'旧任务待核验/续跑':'排队',c.created_at,new Date().toISOString());
        this.sql.prepare("INSERT INTO workflow_conversations VALUES(?,?)").run(c.id,id);
        this.sql.prepare("INSERT OR IGNORE INTO workflow_entities SELECT 'job',id,? FROM jobs WHERE conversation_id=? AND status IN ('running','queued')").run(id,c.id);
        this.sql.prepare("INSERT OR IGNORE INTO workflow_entities SELECT 'pending',id,? FROM pending_prompts WHERE conversation_id=?").run(id,c.id);
        this.sql.prepare("INSERT OR IGNORE INTO workflow_entities SELECT 'wake',id,? FROM wake_plans WHERE conversation_id=? AND state='armed'").run(id,c.id);
        this.sql.prepare("INSERT OR IGNORE INTO workflow_runs SELECT id,?,0,0 FROM jobs WHERE conversation_id=? AND status='running'").run(id,c.id);
      }
      this.sql.exec('COMMIT');
    } catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  capacity(): number { return (this.sql.prepare("SELECT capacity FROM workflow_settings WHERE id=1").get() as {capacity:number}).capacity; }
  configure(capacity: number): void { this.sql.prepare("UPDATE workflow_settings SET capacity=? WHERE id=1").run(workflowCapacity(capacity)); }
  get(id: string): WorkflowRow | undefined { return this.sql.prepare("SELECT * FROM workflows WHERE id=?").get(id) as WorkflowRow | undefined; }
  forEntity(kind: string, id: string): WorkflowRow | undefined { return this.sql.prepare("SELECT w.* FROM workflows w JOIN workflow_entities e ON e.workflow_id=w.id WHERE e.kind=? AND e.entity_id=?").get(kind,id) as WorkflowRow | undefined; }
  forConversation(id: string): WorkflowRow | undefined { return this.sql.prepare("SELECT w.* FROM workflows w JOIN workflow_conversations c ON c.workflow_id=w.id WHERE c.conversation_id=?").get(id) as WorkflowRow | undefined; }
  list(userId?: string): WorkflowRow[] { return this.sql.prepare("SELECT * FROM workflows WHERE state NOT IN ('completed','aborted')"+(userId?" AND user_id=?":"")+" ORDER BY priority DESC,seq").all(...(userId?[userId]:[])) as WorkflowRow[]; }
  /** Read-only, user-scoped explanation; never grants admission or exposes external source keys. */
  waitingFor(conversationId: string): string | null {
    const current = this.forConversation(conversationId);
    if (!current || current.state !== "queued" || this.capacity() < 1) return null;
    if (this.admissionBlock(conversationId)?.code !== "workflow_limit") return null;
    const predecessors = this.list().filter(w => w.id !== current.id && (w.state !== "queued"
      || w.priority > current.priority || (w.priority === current.priority && w.seq < current.seq)));
    if (!predecessors.length) return null;
    const owner = predecessors.find(w => w.state !== "queued") ?? predecessors[0]!;
    if (owner.user_id !== current.user_id) return "等待其他账号的前序任务完成并释放名额";
    const running = this.sql.prepare(`SELECT 1 FROM workflow_entities e JOIN jobs j ON j.id=e.entity_id
      WHERE e.workflow_id=? AND e.kind='job' AND j.status='running' LIMIT 1`).get(owner.id);
    const armed = this.sql.prepare(`SELECT 1 FROM workflow_conversations c JOIN wake_plans p ON p.conversation_id=c.conversation_id
      WHERE c.workflow_id=? AND p.state='armed' LIMIT 1`).get(owner.id);
    const pending = this.sql.prepare(`SELECT 1 FROM workflow_entities e JOIN jobs j ON j.id=e.entity_id
      WHERE e.workflow_id=? AND e.kind='job' AND j.status='queued' LIMIT 1`).get(owner.id);
    const state = running ? "正在执行" : owner.state === "closing" ? "正在收尾"
      : armed ? "等待定时续跑" : pending && owner.state !== "queued" ? "等待恢复执行"
      : owner.state === "blocked" ? "等待处理" : owner.state === "queued" ? "尚未准入"
      : "等待续跑或验收";
    const source = owner.source_key ? "外部维护" : "本地任务";
    const phase = owner.reason || (owner.phase !== "执行中" ? owner.phase : "");
    return `等待「${owner.title}」：${state}（${source}${phase ? ` · ${phase}` : ""}）${predecessors.length > 1 ? `，另有 ${predecessors.length - 1} 项在前` : ""}`;
  }
  prioritize(id:string, priority:number, reason:string): WorkflowRow {
    if(!Number.isSafeInteger(priority)||priority<0||priority>10000||!reason.trim())throw new Error('优先级及人工排序理由无效');
    const result=this.sql.prepare("UPDATE workflows SET priority=?,reason=?,revision=revision+1,updated_at=? WHERE id=? AND state='queued'")
      .run(priority,reason,new Date().toISOString(),id);
    if(!result.changes)throw new Error('仅可调整排队项；不能抢占已开工任务');
    return this.get(id)!;
  }
  /** Existing stop/delete-pending controls can empty a never-started request. */
  reconcileUnstarted(): void {
    this.sql.prepare(`UPDATE workflows SET state='aborted',phase='未开工取消',reason='排队指令已取消',revision=revision+1,updated_at=?
      WHERE state='queued' AND epoch=0 AND source_key IS NULL
      AND NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.workflow_id=workflows.id)
      AND NOT EXISTS(SELECT 1 FROM workflow_entities e JOIN jobs j ON e.kind='job' AND j.id=e.entity_id
        WHERE e.workflow_id=workflows.id AND j.status IN ('queued','running'))
      AND NOT EXISTS(SELECT 1 FROM workflow_conversations c WHERE c.workflow_id=workflows.id AND (
        EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=c.conversation_id) OR
        EXISTS(SELECT 1 FROM wake_plans p WHERE p.conversation_id=c.conversation_id AND p.state='armed')))`)
      .run(new Date().toISOString());
  }
  block(conversationId: string): string | null { return this.admissionBlock(conversationId)?.label ?? null; }
  admissionBlock(conversationId:string): {code:'workflow_limit'|'workflow_exit_unverified'|'workflow_closing'|'workflow_paused';label:string}|null {
    const w=this.forConversation(conversationId); if(!w) return null;
    if ((this.sql.prepare("SELECT paused FROM workflow_settings WHERE id=1").get() as {paused:number}).paused) return {code:"workflow_paused",label:"修改队列已暂停，等待核查"};
    if(terminal(w)) return {code:"workflow_limit",label:"原修改已结束，等待新任务登记"};
    if(w.state==='closing') return {code:"workflow_closing",label:"本项正在核验收尾，尚未释放"};
    if(this.sql.prepare("SELECT 1 FROM workflow_runs WHERE workflow_id=? AND settled=0 LIMIT 1").get(w.id)) return {code:"workflow_exit_unverified",label:"等待本项上一执行者确认退出"};
    const n=this.capacity();
    if(w.state==='queued' && n>0){
      const held=this.list().filter(x=>x.state!=='queued');
      const ahead=this.list().filter(x=>x.state==='queued' && (x.priority>w.priority || (x.priority===w.priority && x.seq<w.seq))).length;
      if(held.length+ahead>=n) return {code:"workflow_limit",label:`等待完整修改任务名额（上限 ${n}；前序尚未验收收尾）`};
    }
    return null;
  }
  assertJob(jobId: string): WorkflowRow {
    const w=this.forEntity('job',jobId); const r=this.sql.prepare("SELECT epoch,settled FROM workflow_runs WHERE job_id=?").get(jobId) as {epoch:number;settled:number}|undefined;
    const job=this.sql.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as {status:string}|undefined;
    if(!w || terminal(w) || !r || r.settled || r.epoch!==w.epoch || job?.status!=='running') throw new Error('修改身份已结束或执行代次失效');
    return w;
  }
  phase(jobId: string, phase: string, blocked = false): WorkflowRow {
    const w=this.assertJob(jobId);
    if(!phase.trim() || phase.length>300)throw new Error('请提供简短阶段/阻塞原因');
    this.sql.prepare("UPDATE workflows SET state=?,phase=?,reason=?,evidence=NULL,closing_job=NULL,revision=revision+1,updated_at=? WHERE id=?")
      .run(blocked?'blocked':'active',blocked?'阻塞':phase,blocked?phase:'',new Date().toISOString(),w.id);
    return this.get(w.id)!;
  }
  hasPending(id: string): boolean {
    if(this.sql.prepare(`SELECT 1 FROM workflow_conversations c WHERE c.workflow_id=? AND (
      EXISTS(SELECT 1 FROM wake_plans p WHERE p.conversation_id=c.conversation_id AND p.state='armed') OR
      EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=c.conversation_id)) LIMIT 1`).get(id))return true;
    return Boolean(this.sql.prepare(`SELECT 1 FROM workflow_entities e WHERE e.workflow_id=? AND (
      (e.kind='wake' AND EXISTS(SELECT 1 FROM wake_plans p WHERE p.id=e.entity_id AND p.state='armed')) OR
      (e.kind='pending' AND EXISTS(SELECT 1 FROM pending_prompts p WHERE p.id=e.entity_id)) OR
      (e.kind='job' AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=e.entity_id AND j.status='queued'))) LIMIT 1`).get(id));
  }
  requestClose(jobId:string, revision:number, evidence:unknown): WorkflowRow {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const w=this.assertJob(jobId);
      if(w.source_key)throw new Error('外部维护由监督器核验全部子步骤后收尾，验收子任务不能提前释放');
      if(w.revision!==revision)throw new Error('修改状态已变化，请先重新查看 status');
      if(this.hasPending(w.id))throw new Error('仍有排队指令或持久等待，不能完成');
      const e=validateCompletionEvidence(evidence);
      if(e.kind==='safe_abort')throw new Error('取消需由本机受限接口核对用户意图并安全收尾');
      const required=this.sql.prepare("SELECT instance,request_id,sha FROM workflow_releases WHERE workflow_id=?").all(w.id) as Array<{instance:string;request_id:number;sha:string}>;
      for(const item of required) if(!Array.isArray(e.releases) || !e.releases.some(v=>v.instance===item.instance && v.requestId===item.request_id && v.sha===item.sha))throw new Error('完成证据缺少本项已登记的发布回执');
      if(required.length && e.kind!=='deployment')throw new Error('本项涉及发布，必须使用 deployment 验收');
      this.sql.prepare("UPDATE workflows SET state='closing',phase='等待执行退出',reason='',evidence=?,closing_job=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(JSON.stringify(e),jobId,new Date().toISOString(),w.id,revision);
      this.sql.exec('COMMIT');return this.get(w.id)!;
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  trackRelease(jobId:string, instance:string, requestId:number, sha:string): void {
    const w=this.assertJob(jobId);
    if(!/^[a-z][a-z0-9-]{0,60}$/.test(instance) || !Number.isSafeInteger(requestId) || requestId<1 || !/^[a-f0-9]{40}$/.test(sha))throw new Error('发布身份不合法');
    this.sql.prepare("INSERT INTO workflow_releases VALUES(?,?,?,?) ON CONFLICT(workflow_id,instance,request_id) DO UPDATE SET sha=excluded.sha").run(w.id,instance,requestId,sha);
    this.phase(jobId,'发布/验收');
  }
  executionUncertain(jobId:string, reason:string): void {
    const w=this.forEntity('job',jobId);if(!w)return;
    this.sql.prepare("INSERT OR IGNORE INTO workflow_entities VALUES('unsettled',?,?)").run(jobId,w.id);
    this.sql.prepare("UPDATE workflows SET state='blocked',phase='等待核验执行退出',reason=?,closing_job=NULL,evidence=NULL,revision=revision+1 WHERE id=?").run(reason,w.id);
  }
  /** Called only after the execution promise and its process cleanup have settled. */
  settled(jobId:string): void {
    this.sql.exec('BEGIN IMMEDIATE');
    try{
      const run=this.sql.prepare("SELECT settled FROM workflow_runs WHERE job_id=?").get(jobId) as {settled:number}|undefined;
      const w=this.forEntity('job',jobId);
      if(!run || run.settled===1 || !w || terminal(w) || this.sql.prepare("SELECT 1 FROM workflow_entities WHERE kind='unsettled' AND entity_id=?").get(jobId)){this.sql.exec('COMMIT');return;}
      const job=this.sql.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as {status:string}|undefined;
      this.sql.prepare("UPDATE workflow_runs SET settled=1 WHERE job_id=?").run(jobId);
      const pending=this.hasPending(w.id);
      const live=this.sql.prepare("SELECT 1 FROM workflow_runs WHERE workflow_id=? AND settled=0 LIMIT 1").get(w.id);
      if(w.state==='closing' && w.closing_job===jobId && job?.status==='completed' && !pending && !live){
        this.sql.prepare("UPDATE workflows SET state='completed',phase='完整完成',reason='',revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(),w.id);
      }else if(w.source_key && job?.status==='completed'){
        this.sql.prepare("UPDATE workflows SET state='active',phase='外部监督器待验收收尾',revision=revision+1 WHERE id=?").run(w.id);
      }else if(!pending && job?.status!=='queued'){
        this.sql.prepare("UPDATE workflows SET state='blocked',phase='待收尾/恢复',reason=?,closing_job=NULL,revision=revision+1,updated_at=? WHERE id=?")
          .run(job?.status==='completed'?'本轮已结束，尚未提交完整修改完成证据':'本轮失败或停止，修改名额保留',new Date().toISOString(),w.id);
      }
      this.sql.exec('COMMIT');
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  recoveryStatus(id:string) {
    const workflow=this.get(id);if(!workflow)throw new Error('修改任务不存在');
    const runs=this.sql.prepare(`SELECT r.job_id,r.epoch,r.settled,j.status FROM workflow_runs r
      LEFT JOIN jobs j ON j.id=r.job_id WHERE r.workflow_id=? AND r.settled=0 ORDER BY r.job_id`).all(id) as Array<{job_id:string;epoch:number;settled:number;status:string|null}>;
    const releases=this.sql.prepare('SELECT instance,request_id,sha FROM workflow_releases WHERE workflow_id=?').all(id);
    const running=runs.some(r=>r.status==='running');
    const phase=terminal(workflow)?'terminal':running?'executing':runs.length?'exit_unverified'
      :workflow.state==='queued'?'waiting_capacity':releases.length?'pending_acceptance'
      :this.hasPending(id)?'waiting_continuation':'ready_to_resume';
    return {phase,revision:workflow.revision,epoch:workflow.epoch,runs,releases,
      recoveryRequired:phase==='exit_unverified',automaticReplay:false,capacityRetained:!terminal(workflow)&&workflow.state!=='queued'};
  }
  /** Explicit operator recovery after actual process/Worker/deployment checks.
   * CAS and run identities prevent an old inspection from settling a new run. */
  recover(id:string, reason:string, expected?:{revision:number;runIds:string[]}): void {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const w=this.get(id);if(!w || terminal(w) || !reason.trim())throw new Error('恢复对象或核验理由无效');
      const status=this.recoveryStatus(id);
      if(expected && (w.revision!==expected.revision || JSON.stringify(status.runs.map(r=>r.job_id).sort())!==JSON.stringify([...expected.runIds].sort())))throw new Error('恢复核验已过期，请重新核对执行身份');
      if(this.sql.prepare("SELECT 1 FROM jobs j JOIN workflow_entities e ON e.entity_id=j.id AND e.kind='job' WHERE e.workflow_id=? AND j.status='running'").get(id))throw new Error('仍有运行 Job，不能接管');
      this.sql.prepare("UPDATE workflow_runs SET settled=1 WHERE workflow_id=? AND settled=0").run(id);
      this.sql.prepare("DELETE FROM workflow_entities WHERE kind='unsettled' AND workflow_id=?").run(id);
      this.sql.prepare("UPDATE workflows SET state='blocked',phase='已核验执行退出，等待恢复',reason=?,epoch=epoch+1,revision=revision+1,updated_at=? WHERE id=?").run(reason,new Date().toISOString(),id);
      this.sql.exec('COMMIT');
    }catch(error){this.sql.exec('ROLLBACK');throw error;}
  }
  cancelQueued(id:string,userId:string): void {
    this.sql.exec('BEGIN IMMEDIATE');
    try{
      const w=this.get(id);if(!w || w.user_id!==userId || w.state!=='queued')throw new Error('只有尚未开工的修改可直接取消；已开工项需安全收尾');
      this.sql.prepare("UPDATE jobs SET status='cancelled' WHERE status='queued' AND id IN (SELECT entity_id FROM workflow_entities WHERE workflow_id=? AND kind='job')").run(id);
      this.sql.prepare("UPDATE wake_plans SET state='cancelled' WHERE state='armed' AND id IN (SELECT entity_id FROM workflow_entities WHERE workflow_id=? AND kind='wake')").run(id);
      this.sql.prepare("DELETE FROM pending_prompts WHERE id IN (SELECT entity_id FROM workflow_entities WHERE workflow_id=? AND kind='pending')").run(id);
      this.sql.prepare("UPDATE workflows SET state='aborted',phase='未开工取消',reason='用户取消',revision=revision+1 WHERE id=?").run(id);
      this.sql.exec('COMMIT');
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  external(key:string,userId:string,title:string): WorkflowRow {
    this.sql.exec('BEGIN IMMEDIATE');
    try{
      this.sql.prepare("INSERT OR IGNORE INTO workflows(id,user_id,title,source_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(),userId,title,key,new Date().toISOString(),new Date().toISOString());
      const w=this.sql.prepare("SELECT * FROM workflows WHERE source_key=?").get(key) as WorkflowRow;
      if(w.user_id!==userId)throw new Error('来源归属不符');
      const n=this.capacity(); const rows=this.list();
      if(w.state==='queued' && !(this.sql.prepare("SELECT paused FROM workflow_settings WHERE id=1").get() as {paused:number}).paused && (n===-1 || rows.filter(x=>x.state!=='queued' || x.priority>w.priority || (x.priority===w.priority && x.seq<w.seq)).length<n))this.sql.prepare("UPDATE workflows SET state='active',phase='外部维护',epoch=epoch+1,revision=revision+1 WHERE id=?").run(w.id);
      this.sql.exec('COMMIT');return this.get(w.id)!;
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  closeExternal(id:string,revision:number,evidence:unknown,abort=false): WorkflowRow {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const w=this.get(id); if(!w || w.revision!==revision || terminal(w) || w.state==='queued')throw new Error('状态变化、尚未开工或已结束');
      const proof=validateCompletionEvidence(evidence);
      if(abort !== (proof.kind==='safe_abort'))throw new Error('取消与完成的证据类型不一致');
      const required=this.sql.prepare("SELECT instance,request_id,sha FROM workflow_releases WHERE workflow_id=?").all(id) as Array<{instance:string;request_id:number;sha:string}>;
      if(!abort)for(const item of required)if(proof.kind!=='deployment'||!Array.isArray(proof.releases)||!proof.releases.some(v=>v.instance===item.instance&&v.requestId===item.request_id&&v.sha===item.sha))throw new Error('本项已登记的发布必须全部验收');
      if(this.hasPending(id) || this.sql.prepare("SELECT 1 FROM workflow_runs WHERE workflow_id=? AND settled=0").get(id))throw new Error('仍有未结束执行或等待');
      this.sql.prepare("UPDATE workflows SET state=?,phase=?,reason='',evidence=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(abort?'aborted':'completed',abort?'已安全终止':'完整完成',JSON.stringify(evidence),new Date().toISOString(),id,revision);
      this.sql.exec('COMMIT');return this.get(id)!;
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  instructions(jobId:string): string {
    const w=this.forEntity('job',jobId);if(!w)return '';
    return `\n<pp_agent_complete_workflow>\n本轮属于完整修改任务 ${w.id}。同时允许 ${this.capacity()===-1?'不限数量':this.capacity()} 项完整任务；Job 结束不会释放名额。使用 pp_agent_workflow status 查看状态与完成格式；若旧线程未发现此新工具，使用环境中的 PPAGENT_WORKFLOW_CLI（node 命令加该路径，status 或 --json 参数文件；不要输出鉴权环境）。phase 更新阶段，block 记录阻塞。等待/补修继承当前任务；未完成就登记真实持久等待或明确阻塞。目标真正完成后必须调用 complete（先重新 status 获取 revision，提交功能检查和收尾证据），再正常最终回复；平台在执行真正退出后自动释放。不要以停止、失败、超时、缺少 wake 当作完成。不另起不受管的后台修改；相关发布/子进程必须完成并验收。只做设计的任务按原授权交付即可，不能擅自实施。\n</pp_agent_complete_workflow>\n`;
  }
}
export function validateCompletionEvidence(raw: unknown): Record<string,unknown> {
  const e=raw as Record<string,unknown>|null;
  if(!e || !['design','artifact','deployment','safe_abort'].includes(String(e.kind)) || typeof e.summary!=='string' || !e.summary.trim())throw new Error('完成证据需 kind、summary');
  if(e.functionalVerified!==true || e.cleanupVerified!==true || e.backgroundWorkFinished!==true)throw new Error('功能验收、清理、后台执行结束必须全部核实');
  if(!Array.isArray(e.checks) || !e.checks.length || e.checks.some(x=>!x || typeof x!=='object' || !(x as Record<string,unknown>).name || (x as Record<string,unknown>).passed!==true))throw new Error('必须列出实际通过的验收检查');
  if(e.kind==='deployment' && (!Array.isArray(e.releases)||!e.releases.length))throw new Error('应用修改必须绑定发布回执');
  if(JSON.stringify(e).length>24000)throw new Error('证据过长，请只保留摘要');
  return e;
}
