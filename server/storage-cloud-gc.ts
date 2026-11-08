import type {StorageCatalog,StorageChunk} from './storage-catalog.js';
import {STORAGE_DAY} from './storage-lifecycle-policy.js';
import crypto from 'node:crypto';
import type {Readable} from 'node:stream';

type Remote={locate:(remote:string)=>Promise<{file_id:string;size:number}>;deleteExact:(remote:string,id:string,bytes:number)=>Promise<{pending:boolean}>;stream?:(remote:string,bytes:number)=>Promise<Readable>};
const grace=7*STORAGE_DAY;
const eligible=`SELECT v.id FROM storage_versions v JOIN storage_items i ON i.id=v.item_id
 WHERE v.verified_at IS NOT NULL AND v.state!='error' AND (i.scope='backup-material' OR (i.scope='events' AND EXISTS(SELECT 1 FROM storage_event_batches e WHERE e.item_id=i.id AND e.deleted_at IS NOT NULL AND e.expires_at<=?)))
 AND NOT EXISTS(SELECT 1 FROM storage_references r WHERE r.version_id=v.id AND (r.expires_at IS NULL OR r.expires_at>?))
 AND NOT EXISTS(SELECT 1 FROM storage_replicas p WHERE p.version_id=v.id AND p.released_at IS NULL AND p.state!='unavailable')
 AND NOT EXISTS(SELECT 1 FROM storage_backup_materials m JOIN storage_backup_points b ON b.id=m.point_id WHERE m.version_id=v.id AND b.state IN ('preparing','publishing','verified'))`;

/** Only expired recovery material/events are collected. Unique business
 * originals and native recovery units require their explicit reference policy
 * and are not inferred disposable by an age or a missing filesystem path. */
export async function collectStorageCloud(catalog:StorageCatalog,remote:Remote,limit=64):Promise<{versions:number;chunks:number;descriptors:number;cipherBytesRemoved:number;blocked:string[]}>{
 const result={versions:0,chunks:0,descriptors:0,cipherBytesRemoved:0,blocked:[] as string[]},db=catalog.db,now=catalog.now();
 if(!db.prepare("SELECT 1 FROM storage_backup_points WHERE state='verified' AND restore_tested_at IS NOT NULL").get()){result.blocked.push('storage_independent_recovery_drill_required');return result;}
 catalog.transaction(()=>{
  const candidates=db.prepare(eligible).all(now,now).map(r=>String(r.id)),allowed=new Set(candidates);
  for(const row of db.prepare('SELECT version_id FROM storage_gc_versions').all())if(!allowed.has(String(row.version_id)))db.prepare('DELETE FROM storage_gc_versions WHERE version_id=?').run(row.version_id);
  const queued=new Set(db.prepare('SELECT version_id FROM storage_gc_versions').all().map(r=>String(r.version_id)));
  for(const id of candidates.filter(id=>!queued.has(id)).slice(0,limit))db.prepare('INSERT OR IGNORE INTO storage_gc_versions VALUES(?,?)').run(id,now);
  for(const row of db.prepare('SELECT version_id FROM storage_gc_versions WHERE queued_at<=? LIMIT ?').all(now-grace,limit)){
   const id=String(row.version_id);if(!allowed.has(id))continue;
   db.prepare('DELETE FROM storage_references WHERE version_id=? AND expires_at<=?').run(id,now);
   db.prepare('DELETE FROM storage_version_chunks WHERE version_id=?').run(id);
   db.prepare('UPDATE storage_items SET current_version=NULL WHERE current_version=?').run(id);
   db.prepare('DELETE FROM storage_gc_versions WHERE version_id=?').run(id);
   // Release records are historical evidence and may still reference the ID.
   // Keep the immutable version descriptor while removing only cloud edges.
   const scope=db.prepare('SELECT i.scope FROM storage_items i JOIN storage_versions v ON v.item_id=i.id WHERE v.id=?').get(id)!.scope;
   if(scope==='backup-material'){
    db.prepare('DELETE FROM storage_backup_materials WHERE version_id=?').run(id);db.prepare('DELETE FROM storage_versions WHERE id=?').run(id);
   }else db.prepare("UPDATE storage_versions SET state='error' WHERE id=?").run(id);
   catalog.audit('__shared__',null,id,'expired_cloud_version_retired',0);result.versions++;
  }
  for(const c of db.prepare(`SELECT c.* FROM storage_chunks c WHERE NOT EXISTS(SELECT 1 FROM storage_version_chunks v WHERE v.chunk_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM storage_gc_chunks g WHERE g.chunk_id=c.id) AND c.verified_at<=? LIMIT ?`).all(now-grace,limit) as StorageChunk[])
   db.prepare('INSERT OR IGNORE INTO storage_gc_chunks(chunk_id,queued_at,remote_path,remote_file_id,ciphertext_bytes) VALUES(?,?,?,?,?)').run(c.id,now,c.remote_path,c.remote_file_id??null,c.ciphertext_bytes);
 });
 for(const row of db.prepare("SELECT * FROM storage_gc_chunks WHERE deleted_at IS NULL AND (queued_at<=? OR state='deleting') LIMIT ?").all(now-grace,limit)){
  const id=String(row.chunk_id),name=String(row.remote_path),bytes=Number(row.ciphertext_bytes);
  try{
   const canDelete=catalog.transaction(()=>{
    const intent=db.prepare('SELECT state,queued_at FROM storage_gc_chunks WHERE chunk_id=? AND deleted_at IS NULL').get(id);
    if(!intent || intent.state==='queued' && Number(intent.queued_at)>now-grace)return false;
    if(db.prepare('SELECT 1 FROM storage_version_chunks WHERE chunk_id=?').get(id)){db.prepare('DELETE FROM storage_gc_chunks WHERE chunk_id=?').run(id);return false;}
    db.prepare("UPDATE storage_gc_chunks SET state='deleting' WHERE chunk_id=?").run(id);return true;
   });if(!canDelete)continue;
   let file;try{file=await remote.locate(name);}catch(e){if(!(e instanceof Error) || e.message!=='storage_cloud_object_missing')throw e;}
   if(file){if(file.size!==bytes || row.remote_file_id && file.file_id!==row.remote_file_id)throw new Error('storage_gc_remote_identity');
    const deletion=await remote.deleteExact(name,file.file_id,bytes);if(deletion.pending){result.blocked.push('storage_gc_delete_pending');continue;}
    try{await remote.locate(name);throw new Error('storage_gc_delete_not_confirmed');}catch(e){if(!(e instanceof Error) || e.message!=='storage_cloud_object_missing')throw e;}
   }
   catalog.transaction(()=>{
    if(db.prepare('SELECT 1 FROM storage_version_chunks WHERE chunk_id=?').get(id))throw new Error('storage_gc_reference_changed');
    db.prepare('DELETE FROM storage_chunks WHERE id=?').run(id);
    db.prepare("UPDATE storage_gc_chunks SET state='deleted',deleted_at=?,last_error=NULL WHERE chunk_id=?").run(now,id);
    catalog.audit('__shared__',null,null,'cloud_object_removed',bytes,{chunk:id,physicalQuotaReleaseConfirmed:false});
   });result.chunks++;result.cipherBytesRemoved+=bytes;
  }catch(e){const reason=e instanceof Error?e.message:'storage_gc_failed';db.prepare('UPDATE storage_gc_chunks SET last_error=? WHERE chunk_id=?').run(reason,id);result.blocked.push(reason);}
 }
 for(const point of db.prepare("SELECT * FROM storage_backup_points WHERE state='retired' AND retired_at<=? LIMIT ?").all(now-grace,limit)){
  try{
   const name=String(point.remote_path),body=String(point.manifest_json),bytes=Buffer.byteLength(body);let file;
   try{file=await remote.locate(name);}catch(e){if(!(e instanceof Error) || e.message!=='storage_cloud_object_missing')throw e;}
   if(file){
    if(file.size!==bytes || bytes>1024**2 || !remote.stream)throw new Error('storage_retired_descriptor_identity');
    let read=0;const hash=crypto.createHash('sha256');
    for await(const part of await remote.stream(name,bytes)){read+=(part as Buffer).length;if(read>bytes)throw new Error('storage_retired_descriptor_size');hash.update(part as Buffer);}
    if(read!==bytes || hash.digest('hex')!==crypto.createHash('sha256').update(body).digest('hex'))throw new Error('storage_retired_descriptor_hash');
    if((await remote.deleteExact(name,file.file_id,bytes)).pending){result.blocked.push('storage_retired_descriptor_delete_pending');continue;}
    try{await remote.locate(name);throw new Error('storage_retired_descriptor_delete_not_confirmed');}catch(e){if(!(e instanceof Error) || e.message!=='storage_cloud_object_missing')throw e;}
   }
   db.prepare("UPDATE storage_backup_points SET state='collected',blocked_reason=NULL WHERE id=? AND state='retired'").run(point.id);
   catalog.audit('__shared__',null,null,'retired_backup_descriptor_removed',bytes,{point:point.id});result.descriptors++;
  }catch(e){const reason=e instanceof Error?e.message:'storage_retired_descriptor_failed';db.prepare('UPDATE storage_backup_points SET blocked_reason=? WHERE id=?').run(reason,point.id);result.blocked.push(reason);}
 }
 return result;
}
