import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isRealUsage, storageRetentionDays, STORAGE_DAY, type StorageKind } from './storage-lifecycle-policy.js';

export type StorageItem = {
  id: string; user_id: string; scope: string; source_key: string; kind: StorageKind; locator_json: string; display_name: string;
  last_used_at: number; time_basis: string; enrolled_at: number; retention_days: 15 | 30 | 60;
  current_version: string | null; revision: number; blocked_reason: string | null; next_attempt_at: number; failures: number;
  usage_not_before:number;
};
export type StorageVersion = {
  id: string; item_id: string; user_id: string; generation: number; sha256: string; logical_bytes: number;
  source_fingerprint: string; manifest_json: string | null; manifest_sha256: string | null;
  state: 'local' | 'uploading' | 'verified' | 'isolating' | 'cold' | 'restoring' | 'error';
  created_at: number; verified_at: number | null; restored_at: number | null;
};
export type StorageChunk = {
  id: string; user_id: string; plaintext_sha256: string; plaintext_bytes: number;
  ciphertext_sha256: string; ciphertext_bytes: number; remote_drive: string; remote_path: string;
  remote_file_id?:string|null; codec: string; verified_at: number;
};
export type StorageReplica = {
  id: string; user_id: string; version_id: string; path: string; purpose: 'isolation' | 'cache';
  created_at: number; isolated_at: number | null; verified_at: number; allocated_bytes: number;
  released_at: number | null; released_bytes: number; state: string; blocked_reason: string | null;
};
export type StorageLease = {
  id: string; user_id: string; item_id: string; version_id: string | null; job_id: string | null;
  process_identity: string; purpose: string; acquired_at: number; expires_at: number; released_at: number | null;
};
const hashPattern = /^[a-f0-9]{64}$/;
const validTime = (value: number) => Number.isSafeInteger(value) && value > 0;

/** Metadata only. Callers never count a scan, backup, listing or retry as use. */
export class StorageCatalog {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}

  transaction<T>(fn: () => T): T {
    // These are write transactions. Acquire the writer before the first read
    // so another connection cannot invalidate a deferred WAL snapshot.
    if(!this.db.isTransaction){
      this.db.exec('BEGIN IMMEDIATE');
      try{const result=fn();this.db.exec('COMMIT');return result;}
      catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    }
    const savepoint = `storage_${crypto.randomBytes(8).toString('hex')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = fn(); this.db.exec(`RELEASE ${savepoint}`); return result; }
    catch (e) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw e; }
  }
  item(userId: string, id: string): StorageItem {
    const item = this.db.prepare('SELECT * FROM storage_items WHERE id=? AND user_id=?').get(id, userId) as StorageItem | undefined;
    if (!item) throw new Error('storage_item_not_found');
    return item;
  }
  version(userId: string, id: string): StorageVersion {
    const version = this.db.prepare('SELECT * FROM storage_versions WHERE id=? AND user_id=?').get(id, userId) as StorageVersion | undefined;
    if (!version) throw new Error('storage_version_not_found');
    return version;
  }
  enroll(input: { userId: string; scope: string; sourceKey: string; kind: StorageKind; locator: unknown; name: string;
    trustedUsedAt?: number; timeBasis?: string; recoveryDependency?: boolean }): StorageItem {
    if (!input.userId || !input.scope || !input.sourceKey) throw new Error('storage_identity_required');
    const existing = this.db.prepare('SELECT * FROM storage_items WHERE user_id=? AND ((scope=? AND source_key=?) OR locator_json=?)')
      .get(input.userId,input.scope,input.sourceKey,JSON.stringify(input.locator)) as StorageItem | undefined;
    if (existing) {
      // Additional recovery/library aliases may require a longer finite
      // window, but never renew its original last-used time.
      const retention=storageRetentionDays(input.kind,input.recoveryDependency);
      if(retention>existing.retention_days){
        this.db.prepare('UPDATE storage_items SET retention_days=?,revision=revision+1 WHERE id=? AND user_id=?').run(retention,existing.id,input.userId);
        return this.item(input.userId,existing.id);
      }
      return existing;
    }
    const now = this.now();
    const known = input.trustedUsedAt !== undefined && validTime(input.trustedUsedAt) && input.trustedUsedAt <= now;
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO storage_items(id,user_id,scope,source_key,kind,locator_json,display_name,
      last_used_at,time_basis,enrolled_at,retention_days) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,input.userId,input.scope,input.sourceKey,input.kind,JSON.stringify(input.locator),input.name,
        known ? input.trustedUsedAt! : now,known ? (input.timeBasis || 'business-time') : 'migration-t0-unknown-access',now,
        storageRetentionDays(input.kind,input.recoveryDependency));
    this.audit(input.userId,id,null,'enroll',0,{timeBasis: known ? input.timeBasis || 'business-time' : 'migration-t0-unknown-access'});
    return this.item(input.userId,id);
  }
  touch(userId: string, id: string, evidence: string, at = this.now()): void {
    this.item(userId,id);
    if (!isRealUsage(evidence)) throw new Error('storage_not_usage');
    if (!validTime(at) || at > this.now()) throw new Error('storage_invalid_usage_time');
    this.db.prepare(`UPDATE storage_items SET last_used_at=MAX(last_used_at,?),time_basis=?,revision=revision+1,
      blocked_reason=NULL,next_attempt_at=0,failures=0 WHERE id=? AND user_id=?`).run(at,evidence,id,userId);
  }
  due(item: StorageItem, at = this.now()): boolean { return Math.max(item.last_used_at + item.retention_days * STORAGE_DAY,item.usage_not_before??0) <= at; }
  link(userId:string,itemId:string,kind:string,subjectId:string):void {
    this.item(userId,itemId);
    this.db.prepare('INSERT OR IGNORE INTO storage_item_links(user_id,kind,subject_id,item_id) VALUES(?,?,?,?)').run(userId,kind,subjectId,itemId);
  }
  linked(userId:string,kind:string,subjectId:string):StorageItem[] {
    return this.db.prepare(`SELECT i.* FROM storage_items i JOIN storage_item_links l ON l.item_id=i.id AND l.user_id=i.user_id
      WHERE l.user_id=? AND l.kind=? AND l.subject_id=? ORDER BY i.id`).all(userId,kind,subjectId) as StorageItem[];
  }
  issue(scope:string,key:string,userId:string|null,reason:string):void {
    this.db.prepare(`INSERT INTO storage_issues(scope,source_key,user_id,reason,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope,source_key) DO UPDATE SET reason=excluded.reason,last_seen_at=excluded.last_seen_at,resolved_at=NULL`)
      .run(scope,key,userId,reason,this.now(),this.now());
  }
  resolveIssue(scope:string,key:string):void {
    this.db.prepare('UPDATE storage_issues SET resolved_at=? WHERE scope=? AND source_key=? AND resolved_at IS NULL').run(this.now(),scope,key);
  }
  registerVersion(userId: string, itemId: string, input: { sha256: string; bytes: number; fingerprint: string },makeCurrent=true): StorageVersion {
    if (!hashPattern.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || !input.fingerprint) throw new Error('storage_invalid_version');
    return this.transaction(() => {
      this.item(userId,itemId);
      let version = this.db.prepare('SELECT * FROM storage_versions WHERE item_id=? AND sha256=? AND source_fingerprint=?')
        .get(itemId,input.sha256,input.fingerprint) as StorageVersion | undefined;
      if (!version) {
        const gen = this.db.prepare('SELECT COALESCE(MAX(generation),0)+1 AS n FROM storage_versions WHERE item_id=?').get(itemId) as { n: number };
        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO storage_versions(id,item_id,user_id,generation,sha256,logical_bytes,source_fingerprint,state,created_at)
          VALUES(?,?,?,?,?,?,?,'local',?)`).run(id,itemId,userId,gen.n,input.sha256,input.bytes,input.fingerprint,this.now());
        version = this.version(userId,id);
      }
      if(makeCurrent)this.db.prepare('UPDATE storage_items SET current_version=?,revision=revision+1 WHERE id=? AND user_id=? AND current_version IS NOT ?')
        .run(version.id,itemId,userId,version.id);
      return version;
    });
  }
  recordChunk(chunk: StorageChunk): StorageChunk {
    if (!hashPattern.test(chunk.plaintext_sha256) || !hashPattern.test(chunk.ciphertext_sha256)
      || !validTime(chunk.verified_at) || chunk.verified_at > this.now() || chunk.plaintext_bytes < 0 || chunk.ciphertext_bytes <= 0) throw new Error('storage_invalid_chunk');
    this.db.prepare(`INSERT INTO storage_chunks(id,user_id,plaintext_sha256,plaintext_bytes,ciphertext_sha256,ciphertext_bytes,
      remote_drive,remote_path,remote_file_id,codec,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,plaintext_sha256,plaintext_bytes) DO NOTHING`)
      .run(chunk.id,chunk.user_id,chunk.plaintext_sha256,chunk.plaintext_bytes,chunk.ciphertext_sha256,chunk.ciphertext_bytes,
        chunk.remote_drive,chunk.remote_path,chunk.remote_file_id??null,chunk.codec,chunk.verified_at);
    return this.chunk(chunk.user_id,chunk.plaintext_sha256,chunk.plaintext_bytes)!;
  }
  chunk(userId: string, sha256: string, bytes: number): StorageChunk | undefined {
    return this.db.prepare('SELECT * FROM storage_chunks WHERE user_id=? AND plaintext_sha256=? AND plaintext_bytes=?')
      .get(userId,sha256,bytes) as StorageChunk | undefined;
  }
  verifyVersion(userId: string, versionId: string, manifest: unknown, chunks: StorageChunk[]): void {
    this.transaction(() => {
      const version = this.version(userId,versionId);
      for(const chunk of chunks)this.protectChunk(chunk.id);
      this.db.prepare('DELETE FROM storage_gc_versions WHERE version_id=?').run(versionId);
      if (chunks.some(c => c.user_id !== userId || !this.db.prepare('SELECT 1 FROM storage_chunks WHERE id=? AND user_id=?').get(c.id,userId))) throw new Error('storage_chunk_owner_mismatch');
      if (chunks.reduce((n,c) => n + c.plaintext_bytes,0) !== version.logical_bytes) throw new Error('storage_chunk_size_mismatch');
      const text = JSON.stringify(manifest), hash = crypto.createHash('sha256').update(text).digest('hex');
      if (version.manifest_sha256 && version.manifest_sha256 !== hash) throw new Error('storage_manifest_immutable');
      this.db.prepare('DELETE FROM storage_version_chunks WHERE version_id=?').run(versionId);
      chunks.forEach((c,i) => this.db.prepare('INSERT INTO storage_version_chunks(version_id,ordinal,chunk_id) VALUES(?,?,?)').run(versionId,i,c.id));
      this.db.prepare("UPDATE storage_versions SET manifest_json=?,manifest_sha256=?,verified_at=COALESCE(verified_at,?),state='verified' WHERE id=? AND user_id=?")
        .run(text,hash,this.now(),versionId,userId);
      this.audit(userId,version.item_id,versionId,'remote_verified',version.logical_bytes);
    });
  }
  reference(userId: string, versionId: string, kind: string, refId: string, expiresAt: number | null = null): void {
    this.version(userId,versionId);
    this.db.prepare(`INSERT INTO storage_references(user_id,version_id,kind,ref_id,expires_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,version_id,kind,ref_id) DO UPDATE SET expires_at=excluded.expires_at`).run(userId,versionId,kind,refId,expiresAt);
    this.db.prepare('DELETE FROM storage_gc_versions WHERE version_id=?').run(versionId);
  }
  protectChunk(id:string):void{
    this.transaction(()=>{
    const row=this.db.prepare('SELECT state FROM storage_gc_chunks WHERE chunk_id=?').get(id);
    if(row && row.state!=='queued')throw new Error('storage_chunk_gc_in_progress');
    this.db.prepare("DELETE FROM storage_gc_chunks WHERE chunk_id=? AND state='queued'").run(id);
    });
  }
  recordIsolation(userId: string, versionId: string, localPath: string, bytes: number, isolatedAt = this.now()): StorageReplica {
    const version = this.version(userId,versionId);
    if (!version.verified_at || !validTime(isolatedAt) || isolatedAt > this.now()) throw new Error('storage_isolation_unverified');
    this.db.prepare(`INSERT INTO storage_replicas(id,user_id,version_id,path,purpose,created_at,isolated_at,verified_at,allocated_bytes)
      VALUES(?,?,?,?,'isolation',?,?,?,?) ON CONFLICT(path) DO NOTHING`)
      .run(crypto.randomUUID(),userId,versionId,localPath,this.now(),isolatedAt,version.verified_at,bytes);
    const row = this.db.prepare('SELECT * FROM storage_replicas WHERE path=?').get(localPath) as StorageReplica;
    if (row.user_id !== userId || row.version_id !== versionId) throw new Error('storage_isolation_identity_conflict');
    return row; // Preserve each generation's original isolation clock, including after restore.
  }
  isolationDue(graceMs = 3 * STORAGE_DAY): StorageReplica[] {
    if (graceMs < 3 * STORAGE_DAY) throw new Error('storage_grace_too_short');
    return this.db.prepare(`SELECT * FROM storage_replicas WHERE purpose='isolation' AND released_at IS NULL
      AND isolated_at<=? ORDER BY isolated_at,id`).all(this.now()-graceMs) as StorageReplica[];
  }
  acquireLease(userId: string, itemId: string, input: { processIdentity: string; purpose: string; jobId?: string; ttlMs?: number }): StorageLease {
    const item = this.item(userId,itemId), now = this.now(), ttl = input.ttlMs ?? 120_000;
    if (!input.processIdentity || ttl < 1 || ttl > 300_000) throw new Error('storage_invalid_lease');
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO storage_leases(id,user_id,item_id,version_id,job_id,process_identity,purpose,acquired_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id,userId,itemId,item.current_version,input.jobId ?? null,input.processIdentity,input.purpose,now,now+ttl);
    return this.db.prepare('SELECT * FROM storage_leases WHERE id=?').get(id) as StorageLease;
  }
  releaseLease(userId: string, id: string): void {
    this.db.prepare('UPDATE storage_leases SET released_at=? WHERE id=? AND user_id=? AND released_at IS NULL').run(this.now(),id,userId);
  }
  /** Expiry prompts reconciliation, never automatic permission to delete. */
  activeLeases(userId: string, itemId: string, reconcile: (lease: StorageLease) => 'live' | 'dead' | 'unknown'): StorageLease[] {
    this.item(userId,itemId);
    const rows = this.db.prepare('SELECT * FROM storage_leases WHERE user_id=? AND item_id=? AND released_at IS NULL').all(userId,itemId) as StorageLease[];
    return rows.filter(row => {
      const state = reconcile(row);
      if (state === 'dead') { this.releaseLease(userId,row.id); return false; }
      if (row.expires_at <= this.now()) this.block(userId,itemId,state === 'unknown' ? 'lease_reconciliation_unknown' : 'live_process_expired_lease');
      return true;
    });
  }
  block(userId: string, itemId: string, reason: string): void {
    const item = this.item(userId,itemId);
    const retryMs = Math.min(24 * 3600_000,60_000 * 2 ** Math.min(item.failures,10));
    this.db.prepare('UPDATE storage_items SET blocked_reason=?,next_attempt_at=?,failures=failures+1 WHERE id=? AND user_id=?')
      .run(reason,this.now()+retryMs,itemId,userId);
    this.audit(userId,itemId,item.current_version,'blocked',0,{reason});
  }
  audit(userId: string, itemId: string | null, versionId: string | null, action: string, bytes = 0, details: unknown = {}): void {
    let text=JSON.stringify(details);
    if(Buffer.byteLength(text)>8192)text=JSON.stringify({bounded:true,detailBytes:Buffer.byteLength(text),detailSha256:crypto.createHash('sha256').update(text).digest('hex'),note:'Full object blockers remain in storage_issues; current pass receipts remain in the instance lifecycle directory.'});
    this.db.prepare('INSERT INTO storage_audit(user_id,item_id,version_id,action,at,bytes,details_json) VALUES(?,?,?,?,?,?,?)')
      .run(userId,itemId,versionId,action,this.now(),bytes,text);
  }
}
