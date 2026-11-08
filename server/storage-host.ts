import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {storagePolicy} from './storage-lifecycle-policy.js';
import {StorageCatalog,type StorageItem,type StorageLease} from './storage-catalog.js';
import {StorageChunkStore} from './storage-chunks.js';
import {StorageFileLifecycle,safeStorageMember,assertFileNotOpen,type FileLocator} from './storage-file-lifecycle.js';
import {AliyunChunkTransport} from './storage-aliyun.js';
import {AliyunStorageReader} from './storage-aliyun-reader.js';
import {enrollRegisteredFiles,enrollVoiceFiles,enrollRecoveryDependencies,enrollTree,itemForFile,storageRoot,type StorageRoots} from './storage-inventory.js';
import {importLegacyConversation} from './storage-legacy-import.js';
import {StorageNativeLifecycle,nativeFamily,nativeUnitSuccessor} from './storage-native-lifecycle.js';
import {acquireCodexLifecycleLock,assertNoUnmanagedCodexRuntime} from './codex-lifecycle-lock.js';
import {validateRestoredLineage,mutateThreadIndex} from './conversation-lineage.js';
import type {ColdManifest} from './conversation-cold-storage.js';
import {reconcileStorageUsageMarker} from './storage-access-monitor.js';
import {storageEnvironment} from './storage-environment.js';
import {StorageRestoreProgress} from './storage-progress.js';
import type {ColdStorageRoots} from './conversation-cold-storage.js';
import {assertStorageIdentity} from './storage-key.js';
import {importLegacyResource} from './storage-legacy-resources.js';
import {storageMetadataRows} from './storage-scan.js';

export function storageProcessIdentity(pid=process.pid):string {
  const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  return `${fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}:${pid}:${fields[19]}`;
}
export function reconcileStorageProcess(lease:StorageLease):'live'|'dead'|'unknown' {
  const match=/^([a-f0-9-]{36}):(\d+):(\d+)$/.exec(lease.process_identity);
  if(!match)return 'unknown';
  try{return storageProcessIdentity(Number(match[2]))===lease.process_identity?'live':'dead';}
  catch(e){return ['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??'')?'dead':'unknown';}
}

export function reconcileStorageObjectLease(lease:StorageLease,db:DatabaseSync,file:string,now=Date.now()):'live'|'dead'|'unknown'{
 const state=reconcileStorageProcess(lease);if(state!=='live' || lease.expires_at>now)return state;
 if(lease.job_id && db.prepare("SELECT 1 FROM jobs WHERE id=? AND status IN ('running','queued')").get(lease.job_id))return 'live';
 // A long-lived shell/bridge or terminal job cannot keep an old read lease
 // forever. Reconcile the exact inode before releasing its expired lease.
 try{
  const pid=Number(lease.process_identity.split(':')[1]),target=fs.statSync(file);
  for(const fd of fs.readdirSync(`/proc/${pid}/fd`)){
   try{const opened=fs.statSync(`/proc/${pid}/fd/${fd}`);if(opened.dev===target.dev && opened.ino===target.ino)return 'live';}
   catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
  }
  return 'dead';
 }catch(e){return ['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??'')?'dead':'unknown';}
}

/** Runs only in a host storage worker/maintenance process. The web process
 * holds the small catalogue but never receives cloud credentials or age keys. */
export class StorageHost {
  readonly policy=storagePolicy();readonly db:DatabaseSync;readonly catalog:StorageCatalog;
  readonly roots:StorageRoots;readonly chunks:StorageChunkStore;readonly files:StorageFileLifecycle;readonly reader:AliyunStorageReader;
  readonly native:StorageNativeLifecycle;
  private progress?:StorageRestoreProgress;
  constructor(readonly legacyRoots:ColdStorageRoots,options:{background?:boolean}={}){
    if(!this.policy.enabled)throw new Error('storage_lifecycle_disabled');
    assertStorageIdentity(this.policy.identity,this.policy.recipient);
    this.legacyRoots={...legacyRoots,...storageEnvironment()};legacyRoots=this.legacyRoots;
    const required=(name:string)=>{const v=process.env[name]?.trim();if(!v)throw new Error(`storage_config_missing:${name}`);return v;};
    const lifecycleRoot=required('STORAGE_LIFECYCLE_ROOT'),transferRoot=required('STORAGE_TRANSFER_ROOT'),configFile=required('STORAGE_ALIYUN_CONFIG');
    if(![lifecycleRoot,transferRoot,configFile].every(path.isAbsolute))throw new Error('storage_config_path_invalid');
    const hostUserId=required('STORAGE_HOST_USER_ID');if(!/^[a-f0-9-]{36}$/i.test(hostUserId))throw new Error('storage_host_owner_invalid');
    this.roots={dataRoot:legacyRoots.dataRoot,tenantRoot:legacyRoots.tenantRoot,hostRootCodexHome:legacyRoots.hostRootCodexHome,hostUserId,lifecycleRoot};
    this.db=new DatabaseSync(legacyRoots.databasePath);this.db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_items'").get()){this.db.close();throw new Error('storage_migration_required');}
    this.catalog=new StorageCatalog(this.db);
    const allowedLegacy=(process.env.STORAGE_LEGACY_REMOTE_ROOTS??'').split(',').map(s=>s.trim()).filter(Boolean);
    const interval=options.background?Number(process.env.STORAGE_BACKGROUND_REQUEST_INTERVAL_MS??1000):0;
    if(options.background && (!Number.isSafeInteger(interval)||interval<250||interval>60_000))throw new Error('storage_background_interval_invalid');
    this.reader=new AliyunStorageReader({requestIntervalMs:interval,configFile,driveId:this.policy.driveId,allowedRoots:[this.policy.remoteRoot,...allowedLegacy],writeRoot:this.policy.remoteRoot,writeStateRoot:path.join(lifecycleRoot,'remote-intents'),refresh:async()=>{
      try{execFileSync(legacyRoots.aliyunpan,['ls','--driveId',this.policy.driveId,this.policy.remoteRoot],{stdio:'ignore',timeout:60_000});}
      catch{throw new Error('storage_cloud_auth_refresh_failed');}
    }});
    const uid=Number(required('STORAGE_TRANSFER_UID')),gid=Number(required('STORAGE_TRANSFER_GID'));
    const transport=new AliyunChunkTransport({command:legacyRoots.aliyunpan,driveId:this.policy.driveId,remoteRoot:this.policy.remoteRoot,transferRoot,uid,gid},this.reader);
    const scratch=path.join(lifecycleRoot,'scratch');
    this.chunks=new StorageChunkStore(this.catalog,this.policy,scratch,transport,legacyRoots.age,[scratch,transferRoot,path.join(lifecycleRoot,'materialized')]);
    this.files=new StorageFileLifecycle(this.catalog,this.chunks,path.join(lifecycleRoot,'isolated'),(u,r)=>storageRoot(this.catalog,this.roots,u,r),(item,file)=>this.guard(item,file));
    this.native=new StorageNativeLifecycle(this.catalog,this.chunks,this.roots,path.join(lifecycleRoot,'isolated'),(item,file)=>this.guardObject(item,file));
  }
  close():void{this.db.close();}
  private async tracked(userId:string,kind:'file'|'item'|'conversation',id:string,operation:()=>Promise<void>):Promise<void>{
    const previous=this.progress,callback=this.chunks.onProgress,progress=new StorageRestoreProgress(this.db,userId,kind,id);
    this.progress=progress;this.chunks.onProgress=value=>progress.update(value);
    try{await operation();progress.finish();}catch(e){progress.finish(e);throw e;}
    finally{this.progress=previous;this.chunks.onProgress=callback;}
  }
  source(item:StorageItem):string {
    const loc=JSON.parse(item.locator_json) as FileLocator;
    return safeStorageMember(storageRoot(this.catalog,this.roots,item.user_id,loc.root),loc.path);
  }
  guard(item:StorageItem,file:string):void {
    this.guardObject(item,file);
    if(item.kind==='native-history')throw new Error('storage_native_consistent_unit_required');
  }
  guardObject(item:StorageItem,file:string):void {
    if(item.usage_not_before>this.catalog.now())throw new Error('storage_usage_observation_gap_grace');
    const locator=JSON.parse(item.locator_json);
    if(!['events','native-snapshots'].includes(locator.root)){
      const monitor=this.db.prepare("SELECT * FROM storage_scan_state WHERE name='access-monitor'").get();
      if(!monitor || Number(monitor.updated_at)<this.catalog.now()-150_000 || !JSON.parse(String(monitor.value_json)).ready)throw new Error('storage_access_monitor_not_ready');
      if(file===this.source(item) && fs.existsSync(file) && !JSON.parse(String(monitor.value_json)).items?.includes(item.id))throw new Error('storage_object_watch_pending');
      if(this.db.prepare("SELECT 1 FROM storage_issues WHERE scope='access-monitor' AND source_key='queue' AND resolved_at IS NULL").get())throw new Error('storage_access_monitor_gap_requires_reconciliation');
    }
    reconcileStorageUsageMarker(this.catalog,path.join(this.roots.lifecycleRoot!,'access'),item);
    if(this.catalog.activeLeases(item.user_id,item.id,lease=>reconcileStorageObjectLease(lease,this.db,file,this.catalog.now())).length)throw new Error('storage_active_object_lease');
    assertFileNotOpen(file);
  }
  async restoreNativeUnit(userId:string,unitId:string):Promise<void>{
    const unit=this.db.prepare('SELECT * FROM storage_native_units WHERE id=? AND user_id=?').get(unitId,userId);
    if(!unit)throw new Error('storage_native_unit_not_found');
    const m=JSON.parse(String(unit.manifest_json));
    if(unit.state==='restored'){
      const successor=nativeUnitSuccessor(this.catalog,userId,unitId);
      if(successor)throw new Error(`storage_native_unit_superseded:${successor}`);
      const home=storageRoot(this.catalog,this.roots,userId,'native');
      if(!m.lineage.threads.every((thread:{paths:string[]})=>thread.paths.every(p=>fs.existsSync(safeStorageMember(home,p)))))throw new Error('storage_native_local_material_missing');
      return;
    }
    await this.tracked(userId,'item',unitId,async()=>{
      if(!await this.native.restore(userId,String(unit.conversation_id),m.lineage.roots[0],unitId))throw new Error('storage_native_unit_unavailable');
    });
  }
  async restoreFile(userId:string,fileId:string):Promise<void> {
    return this.tracked(userId,'file',fileId,async()=>{
    const file=this.db.prepare(`SELECT f.*,c.user_id FROM files f JOIN conversations c ON c.id=f.conversation_id
      WHERE f.id=? AND c.user_id=? AND c.deleted_at IS NULL AND c.deletion_state='active'`).get(fileId,userId);
    if(!file)throw new Error('storage_file_not_found');
    enrollRegisteredFiles(this.catalog,this.roots,fileId);
    let item=itemForFile(this.catalog,userId,fileId);if(!item)throw new Error('storage_file_mapping_failed');
    if(fs.existsSync(this.source(item))){this.catalog.touch(userId,item.id,'user-read');return;}
    if(!item.current_version){
      await this.importConversation(String(file.conversation_id));item=this.catalog.item(userId,item.id);
    }
    if(!item.current_version)throw new Error('storage_file_archive_missing');
    await this.files.restore(userId,item.id,'user-read');
    });
  }
  async restoreItem(userId:string,itemId:string,evidence:'user-read'|'tool-read'|'resume'='user-read'):Promise<void> {
    return this.tracked(userId,'item',itemId,async()=>{
    let item=this.catalog.item(userId,itemId);
    if(item.kind==='native-history')throw new Error('storage_native_consistent_unit_required');
    if(fs.existsSync(this.source(item))){this.catalog.touch(userId,itemId,evidence);return;}
    if(!item.current_version && ['reader','voice'].includes(item.kind)){
      const kind=item.kind as 'reader'|'voice',loc=JSON.parse(item.locator_json);
      const id=kind==='reader'?String(loc.root).slice('reader:'.length):String(this.db.prepare("SELECT subject_id FROM storage_item_links WHERE user_id=? AND item_id=? AND kind='voice'").get(userId,itemId)?.subject_id??'');
      await this.importResource(kind,id,userId);item=this.catalog.item(userId,itemId);
    }
    await this.files.restore(userId,itemId,evidence);
    });
  }
  async importConversation(conversationId:string){
    return importLegacyConversation({catalog:this.catalog,chunks:this.chunks,roots:this.roots,legacyRoots:this.legacyRoots,conversationId,
      progress:(completed,total)=>this.progress?.update({stage:'converting',completed,total}),
      read:(remote,bytes)=>this.reader.stream(remote,bytes)});
  }
  async importResource(kind:'reader'|'voice',id:string,userId:string){
    return importLegacyResource({catalog:this.catalog,chunks:this.chunks,roots:this.roots,legacyRoots:this.legacyRoots,kind,id,userId,read:(remote,bytes)=>this.reader.stream(remote,bytes)});
  }
  async preheatConversation(userId:string,conversationId:string,threadId?:string):Promise<void>{
    return this.tracked(userId,'conversation',conversationId,async()=>{
    const c=this.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=? AND deleted_at IS NULL').get(conversationId,userId);
    if(!c)throw new Error('storage_conversation_owner');
    if(!await this.native.restore(userId,conversationId,threadId)){
      const legacy=this.db.prepare('SELECT * FROM conversation_storage WHERE conversation_id=?').get(conversationId);
      if(legacy && legacy.state!=='local' && legacy.manifest_json){
        await this.importConversation(conversationId);
        const text=String(legacy.manifest_json),m=JSON.parse(text) as ColdManifest;
        if(crypto.createHash('sha256').update(text).digest('hex')!==legacy.manifest_sha256 || m.userId!==userId || m.conversationId!==conversationId)throw new Error('storage_native_legacy_identity');
        const home=storageRoot(this.catalog,this.roots,userId,'native'),release=acquireCodexLifecycleLock(home);
        try{
          assertNoUnmanagedCodexRuntime(home,[]);
          const family=m.lineage && (threadId||c.codex_thread_id)?nativeFamily(m.lineage,String(threadId||c.codex_thread_id)):m.lineage;
          const paths=new Set(family?.threads.flatMap(t=>t.paths)??[]);
          for(const item of this.catalog.linked(userId,'native-conversation',conversationId))if(paths.has(JSON.parse(item.locator_json).path))await this.native.files.restore(userId,item.id,'resume');
          if(m.lineage){
            if(m.lineage.userId!==userId || m.lineage.codexHome!==home)throw new Error('storage_native_legacy_scope');
            validateRestoredLineage(home,family!);mutateThreadIndex(home,family!.index,'restore');
          }
        }finally{release();}
      }
    }
    this.db.prepare("UPDATE conversation_storage SET state='local',restored_at=?,last_error=NULL,revision=revision+1 WHERE conversation_id=? AND state IN ('cold','error','restoring')")
      .run(new Date().toISOString(),conversationId);
    });
  }
  inventory(includeTrees=false):{files:ReturnType<typeof enrollRegisteredFiles>;voice:number;trees:number} {
    const files=enrollRegisteredFiles(this.catalog,this.roots),voice=enrollVoiceFiles(this.catalog);let trees=0;
    if(includeTrees){
      for(const user of storageMetadataRows(this.db,'SELECT rowid AS _storage_rowid,id FROM users')){
        trees+=enrollTree(this.catalog,this.roots,{userId:String(user.id),root:'library',kind:'library'}).enrolled;
        trees+=enrollTree(this.catalog,this.roots,{userId:String(user.id),root:'native-images',kind:'image'}).enrolled;
      }
      for(const c of storageMetadataRows(this.db,'SELECT rowid AS _storage_rowid,id,user_id,last_active_at FROM conversations WHERE deleted_at IS NULL')){
        trees+=enrollTree(this.catalog,this.roots,{userId:String(c.user_id),root:`conversation:${c.id}`,kind:'file',conversationId:String(c.id),knownUpperBound:Date.parse(String(c.last_active_at))}).enrolled;
      }
      for(const reader of storageMetadataRows(this.db,'SELECT rowid AS _storage_rowid,id,user_id,last_accessed_at FROM reading_source_versions WHERE normalized_root IS NOT NULL')){
        trees+=enrollTree(this.catalog,this.roots,{userId:String(reader.user_id),root:`reader:${reader.id}`,kind:'reader',knownUpperBound:Date.parse(String(reader.last_accessed_at))}).enrolled;
      }
    }
    enrollRecoveryDependencies(this.catalog,this.roots);
    return {files,voice,trees};
  }
  /** Deliberately not a fake original file. One small index per logical root
   * documents original path, immutable version and the explicit restore API. */
  writeIndex(userId:string,rootKey:string):void {
    const directory=storageRoot(this.catalog,this.roots,userId,rootKey);
    if(!fs.existsSync(directory))return;
    const rows=this.db.prepare(`SELECT i.*,v.sha256,v.logical_bytes,v.generation,v.state,v.manifest_json FROM storage_items i
      LEFT JOIN storage_versions v ON v.id=i.current_version AND v.user_id=i.user_id
      WHERE i.user_id=? AND json_extract(i.locator_json,'$.root')=? ORDER BY i.id LIMIT 201`).all(userId,rootKey);
    const files=rows.slice(0,200).map(r=>({accountId:userId,fileId:r.id,name:r.display_name,path:JSON.parse(String(r.locator_json)).path,
      bytes:r.logical_bytes??null,sha256:r.sha256??null,version:r.current_version??null,generation:r.generation??null,state:r.state??'local',
      cloud:r.current_version?this.db.prepare(`SELECT c.remote_drive,c.remote_path FROM storage_version_chunks vc JOIN storage_chunks c ON c.id=vc.chunk_id WHERE vc.version_id=? ORDER BY vc.ordinal`).all(r.current_version):[],
      restore:r.kind==='native-history'?{tool:'pp_agent_storage',action:'native',id:this.db.prepare("SELECT r.ref_id FROM storage_references r JOIN storage_native_units u ON u.id=r.ref_id WHERE r.version_id=? AND r.kind='native-unit' AND u.state!='stale' ORDER BY u.rowid DESC LIMIT 1").get(r.current_version)?.ref_id}:{tool:'pp_agent_storage',action:'restore',id:r.id},blocked:r.blocked_reason??null}));
    const body=JSON.stringify({format:'pp-storage-directory-v1',originalFiles:false,files,complete:rows.length<=200,next:rows.length>200?(rootKey==='native'?{tool:'pp_agent_storage',action:'native'}:{tool:'pp_agent_storage',action:'list',root:rootKey,after:rows[199].id}):null},null,2)+'\n';
    if(Buffer.byteLength(body)>8*1024**2)throw new Error('storage_directory_index_budget');
    const target=path.join(directory,'.pp-storage-index.json'),temporary=`${target}.${crypto.randomUUID()}.tmp`;
    try{fs.writeFileSync(temporary,body,{flag:'wx',mode:0o600});const owner=fs.statSync(directory);if(process.getuid?.()===0)fs.chownSync(temporary,owner.uid,owner.gid);fs.renameSync(temporary,target);}
    finally{try{fs.unlinkSync(temporary);}catch{}}
  }
}
