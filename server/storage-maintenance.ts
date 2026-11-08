import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {StorageHost} from './storage-host.js';
import type {StorageChunk,StorageItem,StorageReplica} from './storage-catalog.js';
import {acquireColdStorageLock,removeColdStorageLock} from './conversation-cold-storage.js';
import {readLineageInventory} from './conversation-lineage.js';
import {nativeOwnership} from './storage-native-ownership.js';
import {importLegacyIsolation,legacyIsolationDue,purgeLegacyGeneration} from './storage-legacy-isolation.js';
import {prepareEventBatch,archiveEventBatch,reconcileEventReferences} from './storage-events.js';
import {storageRoot} from './storage-inventory.js';
import {STORAGE_DAY} from './storage-lifecycle-policy.js';
import {collectStorageCloud} from './storage-cloud-gc.js';
import {enforceWarmCacheBudget} from './storage-cache.js';
import {collectNativeRebuildable} from './storage-local-gc.js';
import {acquireCodexLifecycleLock,assertNoUnmanagedCodexRuntime} from './codex-lifecycle-lock.js';

export type MaintenanceReceipt={startedAt:number;finishedAt:number;inventory:unknown;legacyImported:number;filesIsolated:number;nativeUnits:number;blockedCount:number;
  eventRowsArchived:number;releasedBytes:number;blocked:Array<{scope:string;id:string;reason:string}>;deadlineReached:boolean;operationsAttempted:number;yieldedToUser:boolean;conservative:boolean};
export function maintenanceLock(root:string,name='maintenance'):()=>void{
  fs.mkdirSync(root,{recursive:true,mode:0o700});const fd=fs.openSync(path.join(root,`.${name}.flock`),fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  try{execFileSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','pipe',fd]});return()=>fs.closeSync(fd);}
  catch{fs.closeSync(fd);throw new Error(`storage_${name}_already_running`);}
}
export async function verifyVersionPresent(host:StorageHost,userId:string,versionId:string):Promise<void>{
  const version=host.catalog.version(userId,versionId);if(!version.verified_at)throw new Error('storage_remote_version_unverified');
  // Cipher chunks alone are insufficient after losing the original server.
  // Its immutable manifest/ownership must also be reachable from a verified
  // cloud recovery point before a local original/isolation can be released.
  if(!host.db.prepare(`SELECT 1 FROM storage_backup_materials m JOIN storage_backup_points b ON b.id=m.point_id
    WHERE m.user_id=? AND m.version_id=? AND b.state='verified'`).get(userId,versionId))throw new Error('storage_version_recovery_manifest_pending');
  const chunks=host.db.prepare(`SELECT c.* FROM storage_version_chunks v JOIN storage_chunks c ON c.id=v.chunk_id WHERE v.version_id=? ORDER BY v.ordinal`).all(versionId) as StorageChunk[];
  if(chunks.reduce((sum,c)=>sum+c.plaintext_bytes,0)!==version.logical_bytes)throw new Error('storage_remote_chunks_missing');
  for(const chunk of chunks){if(chunk.user_id!==userId)throw new Error('storage_remote_owner');await host.reader.assertPresent(chunk.remote_path,chunk.ciphertext_bytes,chunk.remote_file_id);}
}
/** Fifteen-minute incremental maintenance. Every pass has bounded work; all
 * intentions and errors survive in the catalogue, including unknown owners. */
export async function runStorageMaintenance(host:StorageHost,options:{inventory?:boolean;maxItems?:number;budgetMs?:number;conservative?:boolean}={}):Promise<MaintenanceReceipt>{
 const release=maintenanceLock(host.roots.lifecycleRoot!),started=Date.now(),deadline=started+(options.budgetMs??10*60_000),max=options.maxItems??32;
 const result:MaintenanceReceipt={startedAt:started,finishedAt:0,inventory:null,legacyImported:0,filesIsolated:0,nativeUnits:0,eventRowsArchived:0,releasedBytes:0,blocked:[],blockedCount:0,deadlineReached:false,operationsAttempted:0,yieldedToUser:false,conservative:options.conservative===true};
 const blocked=(scope:string,id:string,owner:string|null,error:unknown)=>{const reason=error instanceof Error?error.message:'storage_maintenance_failed';host.catalog.issue(scope,id,owner,reason);result.blockedCount++;if(result.blocked.length<256)result.blocked.push({scope,id,reason});};
 const within=()=>{
  if(options.conservative){
   if(result.operationsAttempted>=max)return false;
   if(host.db.prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").get()
    || host.db.prepare("SELECT 1 FROM storage_restores WHERE state IN ('queued','restoring') AND updated_at>? LIMIT 1").get(Date.now()-150_000)){
    result.yieldedToUser=true;return false;
   }
  }
  if(Date.now()<deadline)return true;result.deadlineReached=true;return false;
 };
 try{
  if(!within())return result;
  const scan=host.db.prepare("SELECT updated_at FROM storage_scan_state WHERE name='inventory'").get();
  if(options.inventory || !scan || Number(scan.updated_at)<Date.now()-STORAGE_DAY){
   result.inventory=host.inventory(true);
   host.db.prepare("INSERT INTO storage_scan_state VALUES('inventory',?,?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").run(JSON.stringify(result.inventory),Date.now());
  }else result.inventory=host.inventory(false);
  const legacy=importLegacyIsolation(host.db);for(const issue of legacy.issues)blocked('legacy-isolation',`${issue.kind}:${issue.id}`,null,new Error(issue.reason));
  for(const old of host.db.prepare(`SELECT s.conversation_id,c.user_id FROM conversation_storage s JOIN conversations c ON c.id=s.conversation_id
    WHERE s.verified_at IS NOT NULL AND s.manifest_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM storage_legacy_imports i
    WHERE i.kind='conversation' AND i.subject_id=s.conversation_id AND i.generation=s.generation AND i.verified_at IS NOT NULL)
    ORDER BY COALESCE((SELECT last_seen_at FROM storage_issues WHERE scope='legacy-import' AND source_key=s.conversation_id AND resolved_at IS NULL),0),s.verified_at LIMIT ?`).all(max)){
    if(!within())break;
    try{result.operationsAttempted++;await host.importConversation(String(old.conversation_id));result.legacyImported++;host.catalog.resolveIssue('legacy-import',String(old.conversation_id));}
    catch(e){blocked('legacy-import',String(old.conversation_id),String(old.user_id),e);}
  }
  for(const resource of host.db.prepare(`SELECT 'reader' kind,id,user_id,storage_generation generation FROM reading_source_versions WHERE storage_verified_at IS NOT NULL
    UNION ALL SELECT 'voice',id,user_id,audio_generation FROM voice_transcriptions WHERE audio_verified_at IS NOT NULL`).all()){
    if(!within())break;
    if(host.db.prepare('SELECT 1 FROM storage_legacy_imports WHERE kind=? AND subject_id=? AND generation=? AND verified_at IS NOT NULL').get(resource.kind,resource.id,resource.generation))continue;
    try{result.operationsAttempted++;await host.importResource(resource.kind as 'reader'|'voice',String(resource.id),String(resource.user_id));result.legacyImported++;host.catalog.resolveIssue('legacy-resource',`${resource.kind}:${resource.id}`);}
    catch(e){blocked('legacy-resource',`${resource.kind}:${resource.id}`,String(resource.user_id),e);}
  }
  // Existing generations are independent of the conversation's current state.
  for(const row of options.conservative?[]:legacyIsolationDue(host.db).slice(0,max)){
    if(!within())break;let lock:string|undefined;
    try{
      if(!host.db.prepare(`SELECT 1 FROM storage_backup_legacy_refs r JOIN storage_backup_points b ON b.id=r.point_id
        WHERE r.remote_drive=? AND r.remote_path=? AND r.archive_sha256=? AND b.state='verified'`).get(row.remote_drive,row.remote_path,row.archive_sha256))throw new Error('storage_legacy_recovery_manifest_pending');
      lock=acquireColdStorageLock(host.legacyRoots,row.kind==='conversation'?row.subject_id:`${row.kind}-${row.subject_id}`);
      const hash=crypto.createHash('sha256');let bytes=0;
      for await(const data of await host.reader.stream(row.remote_path,row.archive_bytes)){hash.update(data as Buffer);bytes+=(data as Buffer).length;}
      if(bytes!==row.archive_bytes || hash.digest('hex')!==row.archive_sha256)throw new Error('storage_legacy_remote_hash_mismatch');
      const roots=host.legacyRoots as typeof host.legacyRoots&{readerIsolationRoot:string};
      const root=row.kind==='conversation'?roots.isolationRoot:row.kind==='voice'?roots.voiceIsolationRoot:roots.readerIsolationRoot;
      result.releasedBytes+=purgeLegacyGeneration(host.db,row,{isolationRoot:root,remoteVerified:true}).releasedBytes;host.catalog.resolveIssue('legacy-purge',`${row.kind}:${row.subject_id}:${row.generation}`);
    }catch(e){blocked('legacy-purge',`${row.kind}:${row.subject_id}:${row.generation}`,row.user_id,e);}
    finally{if(lock)removeColdStorageLock(lock);}
  }
  const due=host.db.prepare(`SELECT * FROM storage_items WHERE kind!='native-history' AND scope!='backup-material'
    AND last_used_at+retention_days*86400000<=? AND next_attempt_at<=? AND usage_not_before<=? ORDER BY last_used_at,id LIMIT ?`).all(Date.now(),Date.now(),Date.now(),max) as StorageItem[];
  for(const item of due){
    if(!within())break;let nativeUnlock:(()=>void)|undefined;
    try{
      const source=host.source(item);
      if(item.kind==='unmapped' && JSON.parse(item.locator_json).root==='native'){
       const home=storageRoot(host.catalog,host.roots,item.user_id,'native');
       nativeUnlock=acquireCodexLifecycleLock(home);assertNoUnmanagedCodexRuntime(home,[source]);
      }
      if(!fs.existsSync(source)){
        if(item.current_version && host.catalog.version(item.user_id,item.current_version).verified_at){host.db.prepare('UPDATE storage_items SET next_attempt_at=? WHERE id=?').run(Date.now()+STORAGE_DAY,item.id);continue;}
        throw new Error('storage_original_missing_archive_mapping_required');
      }
      result.operationsAttempted++;await host.files.archive(item.user_id,item.id);result.filesIsolated++;
      for(const link of host.db.prepare("SELECT subject_id FROM storage_item_links WHERE item_id=? AND kind='checkpoint'").all(item.id))host.catalog.reference(item.user_id,host.catalog.item(item.user_id,item.id).current_version!,'checkpoint',String(link.subject_id));
      host.writeIndex(item.user_id,JSON.parse(item.locator_json).root);
      host.db.prepare('UPDATE storage_items SET blocked_reason=NULL,failures=0,next_attempt_at=? WHERE id=?').run(Date.now()+STORAGE_DAY,item.id);host.catalog.resolveIssue('archive',item.id);
    }catch(e){host.catalog.block(item.user_id,item.id,e instanceof Error?e.message:'storage_archive_failed');blocked('archive',item.id,item.user_id,e);}
    finally{nativeUnlock?.();}
  }
  let natives=0;
  for(const account of options.conservative?[]:host.db.prepare('SELECT id FROM users ORDER BY id').all()){
    if(!within() || natives>=max)break;
    const user=String(account.id),executor=user===host.roots.hostUserId?'local-host':'tenant-local';
    try{
      const home=storageRoot(host.catalog,host.roots,user,'native');if(!fs.existsSync(home))continue;
      const inventory=readLineageInventory(home),ownership=nativeOwnership(host.db,user,executor,inventory);
      for(const entry of inventory.unclassified){
       // Account ownership is known even when a damaged session header cannot
       // establish a thread. Preserve its bytes under a finite recovery window
       // and an explicit path-restore entry; never invent a parent/thread ID.
       const item=host.catalog.enroll({userId:user,scope:'native-unclassified',sourceKey:entry.relativePath,kind:'unmapped',
        locator:{root:'native',path:entry.relativePath},name:path.basename(entry.relativePath),recoveryDependency:true});
       host.catalog.link(user,item.id,'native-unclassified',entry.relativePath);
       blocked('native-unclassified',`${user}:${entry.relativePath}`,user,new Error(`${entry.reason};preserved_as:${item.id}`));
      }
      const candidates=[...ownership.references].map(([threadId,conversations])=>({threadId,conversations,orphan:false}));
      for(const threadId of ownership.orphanRoots)candidates.push({threadId,conversations:new Set([`orphan:${user}:${threadId}`]),orphan:true});
      for(const {threadId,conversations,orphan} of candidates){
        if(!within() || natives>=max)break;
        if(conversations.size!==1){blocked('native-owner',threadId,user,new Error('storage_native_multiple_conversation_owners'));continue;}
        const cid=[...conversations][0];
        if(host.db.prepare(`SELECT 1 FROM storage_native_units WHERE user_id=? AND state IN ('isolated','cold','evicting')
          AND EXISTS(SELECT 1 FROM json_each(manifest_json,'$.lineage.threads') t WHERE json_extract(t.value,'$.id')=?)`).get(user,threadId))continue;
        try{const id=await host.native.archive(cid,process.env.STORAGE_ENGINE_VERSION||'unknown',threadId,orphan?{userId:user,executor}:undefined,inventory);if(id){natives++;result.nativeUnits++;host.writeIndex(user,'native');}}
        catch(e){blocked('native-archive',`${cid}:${threadId}`,user,e);}
      }
    }catch(e){blocked('native-index',user,user,e);}
  }
  for(const raw of options.conservative?[]:host.db.prepare("SELECT * FROM storage_native_units WHERE state IN ('isolated','evicting') AND isolated_at<=? ORDER BY isolated_at LIMIT ?").all(Date.now()-host.policy.graceMs,max)){
    if(!within())break;
    try{
      const m=JSON.parse(String(raw.manifest_json));for(const part of [...m.parts,...m.rollouts])await verifyVersionPresent(host,String(raw.user_id),part.versionId);
      host.native.purgeHistory(raw as unknown as Parameters<typeof host.native.purgeHistory>[0]);host.catalog.resolveIssue('native-purge',String(raw.id));
    }catch(e){blocked('native-purge',String(raw.id),String(raw.user_id),e);}
  }
  for(const replica of options.conservative?[]:host.db.prepare("SELECT * FROM storage_replicas WHERE state IN ('planned','present','releasing','blocked') AND released_at IS NULL AND isolated_at<=? ORDER BY isolated_at LIMIT ?").all(Date.now()-host.policy.graceMs,max) as StorageReplica[]){
    if(!within())break;
    try{await verifyVersionPresent(host,replica.user_id,replica.version_id);const version=host.catalog.version(replica.user_id,replica.version_id),item=host.catalog.item(replica.user_id,version.item_id);
      result.releasedBytes+=(item.kind==='native-history'?host.native.files:host.files).purge(replica);host.catalog.resolveIssue('replica-purge',replica.id);
    }catch(e){blocked('replica-purge',replica.id,replica.user_id,e);}
  }
  for(const job of options.conservative?[]:host.db.prepare(`SELECT j.id,c.user_id FROM jobs j JOIN conversations c ON c.id=j.conversation_id
    WHERE j.status NOT IN ('running','queued') AND EXISTS(SELECT 1 FROM job_events e WHERE e.job_id=j.id AND e.created_at<?) ORDER BY j.created_at LIMIT ?`).all(new Date(Date.now()-30*STORAGE_DAY).toISOString(),max)){
    if(!within())break;
    try{const batch=prepareEventBatch(host.catalog,String(job.id),storageRoot(host.catalog,host.roots,String(job.user_id),'events'));
      if(batch)result.eventRowsArchived+=await archiveEventBatch(host.files,batch);host.catalog.resolveIssue('events',String(job.id));
    }catch(e){blocked('events',String(job.id),String(job.user_id),e);}
  }
  if(!options.conservative && within()){
   result.releasedBytes+=collectNativeRebuildable(host).releasedBytes;
  }
  if(!options.conservative && within()){
   const cache=await enforceWarmCacheBudget(host,max);host.catalog.audit('__shared__',null,null,'warm_cache_budget',0,cache);
  }
  if(!options.conservative && within()){
   reconcileEventReferences(host.catalog);
   const gc=await collectStorageCloud(host.catalog,host.reader,max);
   host.catalog.audit('__shared__',null,null,'cloud_retention_pass',gc.cipherBytesRemoved,gc);
  }
  return result;
 }finally{
  result.finishedAt=Date.now();host.catalog.audit('__shared__',null,null,'maintenance_pass',result.releasedBytes,{...result,blocked:result.blocked.slice(0,16)});
  fs.writeFileSync(path.join(host.roots.lifecycleRoot!,'last-maintenance.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});release();
 }
}
