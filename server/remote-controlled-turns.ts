import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeRemoteExecutionPrompt, remoteUserMessageMatchesJob } from "./remote-execution-prompt.js";

export function migrateRemoteControlledTurns(db: DatabaseSync): void {
  db.exec(`CREATE TABLE remote_controlled_turns (
    executor_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    source TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(executor_id,thread_id,turn_id)
  );
  CREATE INDEX remote_controlled_turns_job_idx ON remote_controlled_turns(job_id);
  CREATE TABLE remote_steered_inputs (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, turn_id TEXT NOT NULL
  );
  CREATE TABLE remote_execution_inputs (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, prompt_hash TEXT NOT NULL,
    PRIMARY KEY(job_id,prompt_hash)
  );
  CREATE TABLE remote_import_repairs (
    id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    reason TEXT NOT NULL, before_json TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  // Preserve accepted identities before terminal attempt cleanup can discard them.
  db.exec(`INSERT OR IGNORE INTO remote_controlled_turns
    SELECT p.executor_id,c.codex_thread_id,json_extract(a.state_json,'$.acceptedTurnId'),j.id,'accepted',j.updated_at
    FROM job_attempt_state a JOIN jobs j ON j.id=a.job_id JOIN conversations c ON c.id=j.conversation_id
    JOIN projects p ON p.id=c.project_id
    WHERE json_valid(a.state_json) AND json_extract(a.state_json,'$.acceptedTurnId') IS NOT NULL
      AND c.codex_thread_id IS NOT NULL AND p.executor_id LIKE 'remote:%';`);
}

export function remoteExecutionPromptHash(prompt: string): string {
  return crypto.createHash('sha256').update(normalizeRemoteExecutionPrompt(prompt, true)).digest('hex');
}

type UserItem = { turnId: string; content: string; createdAt: string };
export type ControlledClaim = { jobId: string; messageId: string; source: string };
type Job = { id: string; message_id: string; content: string; quote_excerpt: string | null; created_at: string; updated_at: string; status: string };

/** Accepted turn identity wins. Legacy text fallback must be unique in both
 * directions, within the Job's execution window, and cannot steal another turn. */
export function resolveRemoteControlledTurns(db: DatabaseSync, conversationId: string, executorId: string, threadId: string, items: UserItem[]): Map<string, ControlledClaim> {
  const jobs = db.prepare(`SELECT j.id,j.message_id,m.content,m.quote_excerpt,j.created_at,j.updated_at,j.status
    FROM jobs j JOIN messages m ON m.id=j.message_id WHERE j.conversation_id=?`).all(conversationId) as Job[];
  const byId = new Map(jobs.map(j => [j.id,j]));
  const claims = new Map<string, ControlledClaim>();
  const bound = new Map<string, Set<string>>();
  const bindings = db.prepare(`SELECT t.turn_id,t.job_id,t.source FROM remote_controlled_turns t JOIN jobs j ON j.id=t.job_id
    WHERE j.conversation_id=? AND t.executor_id=? AND t.thread_id=?
    UNION ALL SELECT r.turn_id,j.id,'mapping' FROM remote_thread_items r JOIN jobs j ON j.message_id=r.message_id
    WHERE r.conversation_id=? AND r.executor_id=? AND r.thread_id=? AND r.role='user'`)
    .all(conversationId,executorId,threadId,conversationId,executorId,threadId) as {turn_id:string; job_id:string; source:string}[];
  for (const b of bindings) {
    const job = byId.get(b.job_id);
    if (!job) continue;
    if (!claims.has(b.turn_id)) claims.set(b.turn_id,{jobId:job.id,messageId:job.message_id,source:b.source});
    const turns = bound.get(job.id) ?? new Set<string>(); turns.add(b.turn_id); bound.set(job.id,turns);
  }
  const inputs = db.prepare(`SELECT i.job_id,i.prompt_hash FROM remote_execution_inputs i JOIN jobs j ON j.id=i.job_id WHERE j.conversation_id=?`)
    .all(conversationId) as Array<{job_id:string;prompt_hash:string}>;
  const candidates = new Map<string, Job[]>();
  const seenTurns = new Set<string>();
  for (const item of items) {
    if (seenTurns.has(item.turnId)) continue;
    seenTurns.add(item.turnId);
    if (claims.has(item.turnId)) continue;
    const time = Date.parse(item.createdAt);
    const matches = jobs.filter(job => {
      if (bound.has(job.id) || job.status === 'queued') return false;
      if (job.status !== 'running' && item.content.trim() === job.content.trim() && !inputs.some(i=>i.job_id===job.id)) return false;
      const dispatched = inputs.filter(i=>i.job_id===job.id);
      const end = job.status === 'running' ? Date.now() : Date.parse(job.updated_at);
      return time >= Date.parse(job.created_at)-30_000 && time <= end+30_000
        && (dispatched.length ? dispatched.some(i=>i.prompt_hash===remoteExecutionPromptHash(item.content))
          : remoteUserMessageMatchesJob(item.content,job.content,job.quote_excerpt));
    });
    candidates.set(item.turnId, matches);
  }
  for (const [turnId,matches] of candidates) {
    if (matches.length !== 1) continue;
    const job = matches[0];
    if ([...candidates.values()].filter(ms => ms.some(j=>j.id===job.id)).length !== 1) continue;
    claims.set(turnId,{jobId:job.id,messageId:job.message_id,source:'unique_prompt_window'});
  }
  return claims;
}

export function auditRemoteRepair(db: DatabaseSync, conversationId: string, reason: string, before: unknown): void {
  db.prepare('INSERT INTO remote_import_repairs(conversation_id,reason,before_json,created_at) VALUES(?,?,?,?)')
    .run(conversationId,reason,JSON.stringify(before),new Date().toISOString());
}

/** Retain originals and linked business objects. Only orphaned observer copies
 * may become internal audit rows; canonical user/final messages stay unchanged. */
export function quarantineRemoteMessage(db: DatabaseSync, conversationId: string, id: string, replacementId: string | null = null): void {
  const message = db.prepare(`SELECT * FROM messages WHERE id=? AND is_internal=0
    AND NOT EXISTS(SELECT 1 FROM remote_thread_items WHERE message_id=messages.id)
    AND NOT EXISTS(SELECT 1 FROM files WHERE message_id=messages.id)
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE message_id=messages.id)`).get(id);
  if (!message) return;
  auditRemoteRepair(db,conversationId,'quarantine_observer_copy',message);
  db.prepare('UPDATE messages SET is_internal=1 WHERE id=?').run(id);
  const anchor = db.prepare('SELECT id,unread_anchor_message_id FROM conversations WHERE id=? AND unread_anchor_message_id=?').get(conversationId,id);
  if (anchor) {
    auditRemoteRepair(db,conversationId,'repair_unread_anchor',anchor);
    db.prepare('UPDATE conversations SET unread_anchor_message_id=? WHERE id=?').run(replacementId,conversationId);
  }
}

export const remoteInputKey = (turnId:string,itemId:string):string => JSON.stringify([turnId,itemId]);

/** Primary input identity is stable across partial observer updates. */
export function remotePrimaryUserItems(db: DatabaseSync, conversationId: string, claims: Map<string,ControlledClaim>, items: Array<UserItem & {itemId:string}>): Map<string,string> {
  // Observer updates are deltas: their first item need not be the turn's first
  // input. Keep the established input identity across delta/full snapshots.
  const primary = new Map<string,string>();
  const rawItems = new Map(items.map(i=>[remoteInputKey(i.turnId,i.itemId),i]));
  const steered = new Set((db.prepare(`SELECT r.turn_id,r.item_id FROM remote_thread_items r
    JOIN remote_steered_inputs s ON s.message_id=r.message_id AND s.turn_id=r.turn_id
    WHERE r.conversation_id=? AND r.role='user'`).all(conversationId) as Array<{turn_id:string;item_id:string}>).map(r=>remoteInputKey(r.turn_id,r.item_id)));
  const mapped = db.prepare(`SELECT r.turn_id,r.item_id,j.id AS job_id FROM remote_thread_items r
    JOIN jobs j ON j.message_id=r.message_id WHERE r.conversation_id=? AND r.role='user' ORDER BY r.rowid`)
    .all(conversationId) as Array<{turn_id:string;item_id:string;job_id:string}>;
  for (const row of mapped) {
    if (primary.has(row.turn_id) || claims.get(row.turn_id)?.jobId!==row.job_id) continue;
    const raw=rawItems.get(remoteInputKey(row.turn_id,row.item_id));
    if (raw?.content.startsWith('实时调整当前任务：')) {
      const original=db.prepare('SELECT m.content,m.quote_excerpt FROM jobs j JOIN messages m ON m.id=j.message_id WHERE j.id=?')
        .get(row.job_id) as {content:string;quote_excerpt:string|null};
      if (!remoteUserMessageMatchesJob(raw.content,original.content,original.quote_excerpt)) continue;
    }
    primary.set(row.turn_id,row.item_id);
  }
  for (const item of items) {
    if (primary.has(item.turnId) || steered.has(remoteInputKey(item.turnId,item.itemId))) continue;
    const claim=claims.get(item.turnId);
    if (claim && item.content.startsWith('实时调整当前任务：')) {
      const original=db.prepare('SELECT m.content,m.quote_excerpt FROM jobs j JOIN messages m ON m.id=j.message_id WHERE j.id=?')
        .get(claim.jobId) as {content:string;quote_excerpt:string|null};
      // A real original may itself start with this literal phrase. Only a
      // distinct steering envelope must wait for its own canonical input.
      if (!remoteUserMessageMatchesJob(item.content,original.content,original.quote_excerpt)) continue;
    }
    primary.set(item.turnId,item.itemId);
  }
  return primary;
}

/** Explicit steering envelopes need a unique canonical message in their Job. */
export function resolveRemoteSteeredInputs(db: DatabaseSync, conversationId: string, claims: Map<string,ControlledClaim>, items: Array<UserItem & {itemId:string}>): Map<string,string> {
  const messages = db.prepare(`SELECT m.id,m.content,m.quote_excerpt,m.created_at,s.job_id,s.turn_id FROM messages m
    LEFT JOIN remote_steered_inputs s ON s.message_id=m.id
    WHERE m.conversation_id=? AND m.role='user' AND m.is_internal=0
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM remote_thread_items r WHERE r.message_id=m.id)`)
    .all(conversationId) as Array<{id:string;content:string;quote_excerpt:string|null;created_at:string;job_id:string|null;turn_id:string|null}>;
  const candidates = new Map<string,string[]>();
  const primary = remotePrimaryUserItems(db,conversationId,claims,items);
  for (const item of items) {
    if (primary.get(item.turnId)===item.itemId) continue;
    const claim = claims.get(item.turnId);
    if (!claim || !item.content.startsWith('实时调整当前任务：')) continue;
    const job = db.prepare('SELECT created_at,updated_at,status FROM jobs WHERE id=?').get(claim.jobId) as {created_at:string;updated_at:string;status:string};
    candidates.set(remoteInputKey(item.turnId,item.itemId),messages.filter(m=>
      (m.job_id ? m.job_id===claim.jobId && m.turn_id===item.turnId
        : m.created_at>=job.created_at && (job.status==='running' || m.created_at<=job.updated_at))
      && remoteUserMessageMatchesJob(item.content,m.content,m.quote_excerpt)).map(m=>m.id));
  }
  return new Map([...candidates].filter(([,ids])=>ids.length===1 && [...candidates.values()].filter(v=>v.includes(ids[0])).length===1)
    .map(([itemId,ids])=>[itemId,ids[0]]));
}
