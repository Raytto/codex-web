import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {DatabaseSync} from 'node:sqlite';
import type {StorageHost} from './storage-host.js';
import type {StorageItem} from './storage-catalog.js';
import {STORAGE_DAY,STORAGE_GIB} from './storage-lifecycle-policy.js';
import {nativeWarmCopies} from './storage-cache.js';

export function largeStorageWriteBlocked(db:DatabaseSync,roots:string[],bytes:number):boolean{
 if(bytes<=8*1024**2)return false;
 const row=db.prepare("SELECT value_json,updated_at FROM storage_scan_state WHERE name='watermark'").get();
 // A failed observer must not leave a stale software high-water latch forever.
 // Physical free-space protection always runs; normal observations run /15m.
 if(row && Number(row.updated_at)>Date.now()-30*60_000 && JSON.parse(String(row.value_json)).level==='high')return true;
 return roots.some(root=>{try{const d=fs.statfsSync(root);return d.bavail*d.bsize-bytes<d.blocks*d.bsize*.1;}catch{return true;}});
}
function allocated(file:string):number{
 if(!fs.existsSync(file))return 0;
 if(!path.isAbsolute(file)||fs.realpathSync(file)!==path.resolve(file))throw new Error('storage_metrics_path_alias');
 return Number(execFileSync('du',['-sx','-B1','--',file],{encoding:'utf8',timeout:120_000,maxBuffer:1024*1024}).split('\t')[0]);
}
export function disjointStorageRoots(roots:string[]):string[]{
 const result:string[]=[];
 for(const root of [...new Set(roots.map(p=>path.resolve(p)))].sort((a,b)=>a.length-b.length||a.localeCompare(b)))
  if(!result.some(p=>root===p||root.startsWith(p+'/')))result.push(root);
 return result;
}
export function measureStorage(host:StorageHost,input:{stateRoot:string;sharedRoots?:string[]}):Record<string,unknown>{
 if(!path.isAbsolute(input.stateRoot) || fs.realpathSync(input.stateRoot)!==path.resolve(input.stateRoot))throw new Error('storage_metrics_root_invalid');
 const now=host.catalog.now(),accounts:Array<Record<string,unknown>>=[],nativeCopies=nativeWarmCopies(host);let accounted=0;
 const legacyRoots=[host.legacyRoots.isolationRoot,host.legacyRoots.voiceIsolationRoot,(host.legacyRoots as {readerIsolationRoot?:string}).readerIsolationRoot].filter(Boolean) as string[];
 for(const user of host.db.prepare('SELECT id,username FROM users ORDER BY id').all()){
  const id=String(user.id);let localBytes=0,isolatedBytes=0,backlogBytes=0,oldestDueAt:number|null=null,hotBytes=0;
  const roots=[path.join(host.roots.tenantRoot,id),path.join(host.roots.dataRoot,'voice-recordings',id),path.join(host.roots.dataRoot,'reader-resources',id),
   path.join(host.roots.lifecycleRoot!,'isolated',id),path.join(host.roots.lifecycleRoot!,'materialized',id)];
  if(id===host.roots.hostUserId)roots.push(host.roots.hostRootCodexHome);
  for(const row of host.db.prepare(`SELECT DISTINCT f.id FROM files f JOIN conversations c ON c.id=f.conversation_id WHERE c.user_id=? AND f.relative_path LIKE 'deliverables/%'`).all(id))roots.push(path.join(host.roots.dataRoot,'deliverables',String(row.id)));
  for(const row of host.db.prepare('SELECT isolated_path,blocked_reason FROM storage_legacy_generations WHERE user_id=? AND released_at IS NULL').all(id)){
   if(!row.isolated_path || row.blocked_reason==='storage_original_host_not_present')continue;
   const file=String(row.isolated_path);
   if(!legacyRoots.some(root=>file.startsWith(path.resolve(root)+'/'))){host.catalog.issue('metrics-legacy',file,id,'storage_isolation_path_outside_instance');continue;}
   roots.push(file);isolatedBytes+=allocated(file);
  }
  for(const root of disjointStorageRoots(roots))localBytes+=allocated(root);
  for(const item of host.db.prepare("SELECT * FROM storage_items WHERE user_id=? AND scope!='backup-material'").iterate(id) as IterableIterator<StorageItem>){
    try{const source=host.source(item);if(!fs.existsSync(source))continue;const st=fs.lstatSync(source);if(!st.isFile()||st.isSymbolicLink())continue;
      const due=item.last_used_at+item.retention_days*STORAGE_DAY;if(due<=now){backlogBytes+=st.size;oldestDueAt=Math.min(oldestDueAt??due,due);}
      if(item.current_version && host.catalog.version(id,item.current_version).restored_at)hotBytes+=st.blocks*512;
    }catch{/* Unmapped or unknown paths stay visible through inventory issues. */}
  }
  for(const row of host.db.prepare("SELECT path FROM storage_replicas WHERE user_id=? AND released_at IS NULL AND state!='unavailable'").all(id)){
   const file=String(row.path),base=path.join(host.roots.lifecycleRoot!,'isolated',id);
   if(!file.startsWith(base+'/')){host.catalog.issue('metrics-replica',file,id,'storage_isolation_path_outside_instance');continue;}
   // A planned intent with no file occupies zero physical bytes.
   isolatedBytes+=allocated(file);
  }
  const scalar=(sql:string)=>Number(host.db.prepare(sql).get(id)!.n);
  const restore=host.db.prepare(`SELECT COUNT(*) attempts,SUM(CASE WHEN state='error' THEN 1 ELSE 0 END) failures,
    AVG(CASE WHEN state='complete' THEN updated_at-started_at END) averageCompletedMs,MAX(CASE WHEN state='complete' THEN updated_at END) lastSuccessfulAt
    FROM storage_restores WHERE user_id=?`).get(id);
  const metric={id,name:user.username,localAllocatedBytes:localBytes,cloudVerifiedCiphertextBytes:scalar('SELECT COALESCE(SUM(ciphertext_bytes),0) n FROM storage_chunks WHERE user_id=?'),
   currentLogicalBytes:scalar("SELECT COALESCE(SUM(v.logical_bytes),0) n FROM storage_items i JOIN storage_versions v ON v.id=i.current_version WHERE i.user_id=? AND i.scope!='backup-material'"),
   isolatedAllocatedBytes:isolatedBytes,releasedAllocatedBytes:scalar("SELECT COALESCE(SUM(bytes),0) n FROM storage_audit WHERE user_id=? AND action='physically_released'"),
   backlogLogicalBytes:backlogBytes,oldestDueAt,hotAllocatedBytes:hotBytes,
   nativeWarmHistoryLogicalBytes:nativeCopies.filter(v=>v.userId===id).reduce((n,v)=>n+v.historyLogicalBytes,0),restore,
   lastSuccessfulArchiveAt:host.db.prepare("SELECT MAX(at) at FROM storage_audit WHERE user_id=? AND action='isolated'").get(id)!.at,
   blocked:host.db.prepare('SELECT reason,COUNT(*) n,MIN(first_seen_at) firstSeenAt FROM storage_issues WHERE user_id=? AND resolved_at IS NULL GROUP BY reason').all(id)};
  const growth:Record<string,unknown>={};for(const days of [7,30]){
   const previous=host.db.prepare('SELECT metrics_json,at FROM storage_measurements WHERE user_id=? AND at<=? ORDER BY at DESC LIMIT 1').get(id,now-days*STORAGE_DAY);
   growth[`${days}Days`]=previous?{from:previous.at,allocatedBytes:localBytes-Number(JSON.parse(String(previous.metrics_json)).localAllocatedBytes)}:null;
  }
  const record={...metric,growth};accounts.push(record);accounted+=localBytes;
  host.db.prepare('INSERT OR REPLACE INTO storage_measurements VALUES(?,?,?)').run(now,id,JSON.stringify(record));
 }
 const total=disjointStorageRoots([input.stateRoot,...(input.sharedRoots??[])]).reduce((n,p)=>n+allocated(p),0);
 const disk=fs.statfsSync(input.stateRoot),available=disk.bavail*disk.bsize,reserve=disk.blocks*disk.bsize*.1;
 const watermark={at:now,totalAllocatedBytes:total,sharedAllocatedBytes:Math.max(0,total-accounted),availableDiskBytes:available,diskUsedBytes:(disk.blocks-disk.bfree)*disk.bsize,
  level:available<reserve || total>=host.policy.highBytes?'high':total>=host.policy.softBytes?'soft':'normal',softBytes:host.policy.softBytes,highBytes:host.policy.highBytes,hotTargetBytes:host.policy.hotBytes,
  cloudVerifiedCiphertextBytes:Number(host.db.prepare('SELECT COALESCE(SUM(ciphertext_bytes),0) n FROM storage_chunks').get()!.n),
  sharedCloudVerifiedCiphertextBytes:Number(host.db.prepare("SELECT COALESCE(SUM(ciphertext_bytes),0) n FROM storage_chunks WHERE user_id='__shared__'").get()!.n),
  legacyVerifiedCiphertextBytes:Number(host.db.prepare('SELECT COALESCE(SUM(archive_bytes),0) n FROM (SELECT remote_drive,remote_path,MAX(archive_bytes) archive_bytes FROM storage_legacy_generations GROUP BY remote_drive,remote_path)').get()!.n)};
 host.db.prepare("INSERT INTO storage_scan_state VALUES('watermark',?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(watermark),now);
 host.db.prepare('INSERT OR REPLACE INTO storage_measurements VALUES(?,?,?)').run(now,'__shared__',JSON.stringify(watermark));
 const growth:Record<string,unknown>={};for(const days of [7,30]){
  const prior=host.db.prepare("SELECT metrics_json,at FROM storage_measurements WHERE user_id='__shared__' AND at<=? ORDER BY at DESC LIMIT 1").get(now-days*STORAGE_DAY);
  growth[`${days}Days`]=prior?{from:prior.at,allocatedBytes:total-Number(JSON.parse(String(prior.metrics_json)).totalAllocatedBytes)}:null;
 }
 host.db.prepare(`DELETE FROM storage_measurements WHERE at<? AND (user_id,at) NOT IN (SELECT user_id,MAX(at) FROM storage_measurements GROUP BY user_id,CAST(at/86400000 AS INTEGER))`).run(now-7*STORAGE_DAY);
 host.db.prepare('DELETE FROM storage_measurements WHERE at<?').run(now-90*STORAGE_DAY);
 host.db.prepare('DELETE FROM storage_audit WHERE at<?').run(now-180*STORAGE_DAY);
 const result={at:now,finishedAt:Date.now(),accounts,shared:watermark,growth,units:'bytes; allocated uses stat blocks/du; native history cache is serialized logical bytes; cloud bytes never equal local releases',gib:STORAGE_GIB};
 fs.writeFileSync(path.join(host.roots.lifecycleRoot!,'last-measurement.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
}
