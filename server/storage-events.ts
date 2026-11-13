import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { StorageCatalog } from './storage-catalog.js';
import type { StorageFileLifecycle } from './storage-file-lifecycle.js';
import { STORAGE_DAY } from './storage-lifecycle-policy.js';

type Event = {seq:number;event_type:string;payload:string;created_at:string};
type Batch = {id:string;user_id:string;job_id:string;first_seq:number;last_seq:number;event_count:number;sha256:string;
  item_id:string;created_at:number;expires_at:number;deleted_at:number|null;blocked_reason:string|null};
const line=(row:Event)=>`${JSON.stringify(row)}\n`;
const rows=(db:DatabaseSync,jobId:string,first:number,last:number)=>db.prepare(`SELECT seq,event_type,payload,created_at FROM job_events
  WHERE job_id=? AND seq BETWEEN ? AND ? ORDER BY seq`).iterate(jobId,first,last) as IterableIterator<Event>;
function digest(db:DatabaseSync,jobId:string,first:number,last:number):{sha256:string;count:number} {
  const hash=crypto.createHash('sha256');let count=0;for(const row of rows(db,jobId,first,last)){hash.update(line(row));count++;}
  return {sha256:hash.digest('hex'),count};
}

/** One bounded, consistent date/job slice. No event is deleted here, and the
 * independent sequence watermark is already installed by the DB migration. */
export function prepareEventBatch(catalog:StorageCatalog,jobId:string,directory:string,budgetBytes=1024**2):Batch|null {
  const old=catalog.db.prepare('SELECT * FROM storage_event_batches WHERE job_id=? AND deleted_at IS NULL ORDER BY created_at LIMIT 1').get(jobId) as Batch|undefined;
  if(old)return old;
  const job=catalog.db.prepare(`SELECT j.status,c.user_id FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=?`).get(jobId);
  if(!job || ['running','queued'].includes(String(job.status)))throw new Error('storage_event_job_not_terminal');
  if(budgetBytes<1024 || budgetBytes>512*1024**2)throw new Error('storage_event_batch_budget');
  budgetBytes=Math.min(budgetBytes,1024**2);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const id=crypto.randomUUID(),file=path.join(directory,`${id}.jsonl`);
  const fd=fs.openSync(file,'wx',0o600);let finished=false;
  try{
    const snapshot=(()=>{
      const oldest=catalog.db.prepare('SELECT created_at FROM job_events WHERE job_id=? ORDER BY seq LIMIT 1').get(jobId);
      if(!oldest || typeof oldest.created_at!=='string' || !Number.isFinite(Date.parse(oldest.created_at)))return null;
      const day=oldest.created_at.slice(0,10),cutoff=new Date(catalog.now()-30*STORAGE_DAY).toISOString();
      const iterable=catalog.db.prepare(`SELECT seq,event_type,payload,created_at FROM job_events
        WHERE job_id=? AND created_at<? AND substr(created_at,1,10)=? ORDER BY seq LIMIT 256`).iterate(jobId,cutoff,day) as IterableIterator<Event>;
      let bytes=0,count=0,first=0,last=0,lastAt=0;const hash=crypto.createHash('sha256');
      for(const row of iterable){
        const body=line(row),size=Buffer.byteLength(body);if(size>budgetBytes)throw new Error('storage_event_single_row_exceeds_batch');
        if(bytes+size>budgetBytes)break;
        if(!count)first=row.seq;last=row.seq;count++;bytes+=size;lastAt=Math.max(lastAt,Date.parse(row.created_at));
        fs.writeSync(fd,body);hash.update(body);
      }
      if(!count)return null;
      fs.fsyncSync(fd);const sha256=hash.digest('hex');
      // If dates are not monotone, deleting a seq range could include a newer
      // event. Require the entire selected range to match the snapshot.
      const actual=digest(catalog.db,jobId,first,last);
      if(actual.sha256!==sha256 || actual.count!==count)throw new Error('storage_event_noncontiguous_partition');
      return {first,last,count,sha256,lastAt,day};
    })();
    if(!snapshot)return null;
    const {first,last,count,sha256,lastAt,day}=snapshot;
    const value=catalog.transaction(()=>{
      // File writes and fsync happen without the main DB writer. Revalidate
      // this small bounded range after acquiring it; no stale snapshot delete.
      const old=catalog.db.prepare('SELECT * FROM storage_event_batches WHERE job_id=? AND deleted_at IS NULL ORDER BY created_at LIMIT 1').get(jobId) as Batch|undefined;
      if(old)throw new Error('storage_event_batch_concurrent');
      const job=catalog.db.prepare(`SELECT j.status,c.user_id FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=?`).get(jobId);
      if(!job || ['running','queued'].includes(String(job.status)))throw new Error('storage_event_job_became_active');
      const actual=digest(catalog.db,jobId,first,last);
      if(actual.sha256!==sha256 || actual.count!==count)throw new Error('storage_event_rows_changed');
      const item=catalog.enroll({userId:String(job.user_id),scope:'events',sourceKey:id,kind:'events',
        locator:{root:'events',path:`${id}.jsonl`},name:`events-${jobId}-${day}-${first}-${last}.jsonl`,trustedUsedAt:lastAt,timeBasis:'event-created-at'});
      catalog.link(String(job.user_id),item.id,'event-job',jobId);
      catalog.db.prepare(`INSERT INTO storage_event_batches(id,user_id,job_id,first_seq,last_seq,event_count,sha256,item_id,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,job.user_id,jobId,first,last,count,sha256,item.id,catalog.now(),lastAt+180*STORAGE_DAY);
      return catalog.db.prepare('SELECT * FROM storage_event_batches WHERE id=?').get(id) as Batch;
    },'storage_event_register');finished=Boolean(value);return value;
  }finally{fs.closeSync(fd);if(!finished)fs.unlinkSync(file);}
}

export async function archiveEventBatch(lifecycle:StorageFileLifecycle,batch:Batch):Promise<number> {
  const catalog=lifecycle.catalog;
  try{
    if(batch.deleted_at)return 0;
    const replica=await lifecycle.archive(batch.user_id,batch.item_id),version=catalog.version(batch.user_id,replica.version_id);
    if(!version.verified_at || version.sha256!==batch.sha256)throw new Error('storage_event_archive_mismatch');
    // Cloud retention and local retention are independent. Backup points and
    // recovery checkpoints may pin this immutable version beyond 180 days.
    catalog.reference(batch.user_id,version.id,'event-retention',batch.id,batch.expires_at);
    if(catalog.db.prepare('SELECT 1 FROM job_recovery_checkpoints WHERE job_id=?').get(batch.job_id))catalog.reference(batch.user_id,version.id,'recovery-events',batch.job_id);
    // Old batches may predate the bound. Refuse oversized destructive work;
    // retain originals and their verified cloud copy for operator reconciliation.
    if(batch.event_count>256 || version.logical_bytes>1024**2)throw new Error('storage_event_legacy_batch_requires_partition');
    return catalog.transaction(()=>{
      const job=catalog.db.prepare('SELECT status FROM jobs WHERE id=?').get(batch.job_id);
      if(!job || ['running','queued'].includes(String(job.status)))throw new Error('storage_event_job_became_active');
      const current=digest(catalog.db,batch.job_id,batch.first_seq,batch.last_seq);
      if(current.count && (current.sha256!==batch.sha256 || current.count!==batch.event_count))throw new Error('storage_event_rows_changed');
      const high=catalog.db.prepare('SELECT high_water FROM job_event_sequences WHERE job_id=?').get(batch.job_id);
      if(!high || Number(high.high_water)<batch.last_seq)throw new Error('storage_event_high_water_missing');
      const removed=Number(catalog.db.prepare('DELETE FROM job_events WHERE job_id=? AND seq BETWEEN ? AND ?').run(batch.job_id,batch.first_seq,batch.last_seq).changes);
      catalog.db.prepare('UPDATE storage_event_batches SET deleted_at=?,blocked_reason=NULL WHERE id=?').run(catalog.now(),batch.id);
      catalog.audit(batch.user_id,batch.item_id,version.id,'event_rows_pruned',0,{batch:batch.id,rows:removed,highWater:high.high_water});
      return removed; // SQLite free pages are not reported as physical release.
    },'storage_event_prune');
  }catch(e){catalog.db.prepare('UPDATE storage_event_batches SET blocked_reason=? WHERE id=?').run(e instanceof Error?e.message:'storage_event_archive_failed',batch.id);throw e;}
}

/** A checkpoint pins its event material only while the checkpoint exists.
 * Neither scanning nor a later backup extends the original retention date. */
export function reconcileEventReferences(catalog:StorageCatalog):void {
 const db=catalog.db;
 catalog.transaction(()=>{
  const removed=Number(db.prepare(`DELETE FROM storage_references WHERE kind='recovery-events'
    AND NOT EXISTS(SELECT 1 FROM job_recovery_checkpoints c WHERE c.job_id=storage_references.ref_id)`).run().changes);
  for(const row of db.prepare(`SELECT b.user_id,b.job_id,i.current_version FROM storage_event_batches b
    JOIN storage_items i ON i.id=b.item_id JOIN job_recovery_checkpoints c ON c.job_id=b.job_id
    JOIN storage_versions v ON v.id=i.current_version WHERE v.verified_at IS NOT NULL AND v.state!='error'
    AND NOT EXISTS(SELECT 1 FROM storage_references r WHERE r.version_id=v.id AND r.kind='recovery-events' AND r.ref_id=b.job_id)`).all())
   catalog.reference(String(row.user_id),String(row.current_version),'recovery-events',String(row.job_id));
  if(removed)catalog.audit('__shared__',null,null,'event_checkpoint_references_reconciled',0,{removed});
 });
}
