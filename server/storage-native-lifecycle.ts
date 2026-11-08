import {nativeOwnership} from './storage-native-ownership.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {SQLInputValue} from 'node:sqlite';
import {StorageCatalog,type StorageChunk,type StorageItem} from './storage-catalog.js';
import {StorageChunkStore,sha256Path} from './storage-chunks.js';
import {StorageFileLifecycle,safeStorageMember,assertFileNotOpen,type FileManifest} from './storage-file-lifecycle.js';
import {storageRoot,type StorageRoots} from './storage-inventory.js';
import {STORAGE_DAY} from './storage-lifecycle-policy.js';
import {acquireCodexLifecycleLock,assertNoUnmanagedCodexRuntime} from './codex-lifecycle-lock.js';
import {collectConversationLineage,readLineageInventory,mutateThreadIndex,validateRestoredLineage,type ThreadLineage,type LineageInventory} from './conversation-lineage.js';
import type {ColdManifest} from './conversation-cold-storage.js';
import {nativeHistoryDefinition,nativeHistoryDigests,snapshotNativeHistoryPage,removeNativeHistoryParts,restoreNativeHistoryPage,
  type NativeHistoryDefinition,type NativeHistoryDigest,type NativeHistoryPage} from './storage-native-partitions.js';

type NativeUnit={id:string;user_id:string;conversation_id:string;created_at:number;last_used_at:number;retention_days:number;
  manifest_json:string|null;manifest_sha256:string|null;verified_at:number|null;isolated_at:number|null;removed_at:number|null;restored_at:number|null;state:string};
type Member={itemId:string;versionId:string};
type Part=Member & NativeHistoryPage;
type UnitManifest={format:'pp-native-unit-v1';userId:string;conversationId:string;unitId:string;lineage:ThreadLineage;
  history:NativeHistoryDefinition|null;digests:Record<string,NativeHistoryDigest>;parts:Part[];rollouts:Member[];complete:boolean;cachePressure?:boolean};
const digest=(m:UnitManifest)=>crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');

/** A restored generation is historical once the same family is archived again.
 * Return the exact successor rather than silently claiming its files are hot. */
export function nativeUnitSuccessor(catalog:StorageCatalog,userId:string,unitId:string):string|null{
  const row=catalog.db.prepare(`SELECT newer.id FROM storage_native_units older JOIN storage_native_units newer
    ON newer.user_id=older.user_id AND newer.rowid>older.rowid
    WHERE older.id=? AND older.user_id=? AND older.state='restored'
      AND newer.state IN ('verified','isolating','isolated','evicting','cold','restoring','restored')
      AND EXISTS(SELECT 1 FROM json_each(older.manifest_json,'$.lineage.threads') a
        JOIN json_each(newer.manifest_json,'$.lineage.threads') b ON json_extract(a.value,'$.id')=json_extract(b.value,'$.id'))
    ORDER BY newer.rowid DESC LIMIT 1`).get(unitId,userId);
  return row?String(row.id):null;
}

/** A conversation may contain several historical engine sessions. Resuming
 * one connected parent/child family must not warm unrelated old sessions. */
export function nativeFamily(lineage:ThreadLineage,threadId:string):ThreadLineage{
  const nodes=new Map(lineage.threads.map(t=>[t.id,t]));let root=nodes.get(threadId);
  if(!root)throw new Error('native_family_thread_missing');
  const ancestors=new Set<string>();
  while(root.parentId && nodes.has(root.parentId)){
    if(ancestors.has(root.id))throw new Error('native_family_cycle');ancestors.add(root.id);root=nodes.get(root.parentId)!;
  }
  const ids=new Set<string>();const visit=(id:string)=>{if(ids.has(id))return;ids.add(id);for(const n of nodes.values())if(n.parentId===id)visit(n.id);};visit(root.id);
  const tables=Object.fromEntries(Object.entries(lineage.index.tables).map(([table,rows])=>[table,rows.filter(row=>table==='threads'?ids.has(String(row.id)):
    table==='thread_sections'?(lineage.index.tables.threads??[]).some(t=>ids.has(String(t.id))&&t.thread_section_id===row.id):
    table==='thread_spawn_edges'?ids.has(String(row.parent_thread_id))&&ids.has(String(row.child_thread_id)):ids.has(String(row.thread_id)))]));
  return {...lineage,roots:lineage.roots.filter(id=>ids.has(id)),threads:lineage.threads.filter(t=>ids.has(t.id)),index:{tables,
    originalPaths:lineage.index.originalPaths?Object.fromEntries(Object.entries(lineage.index.originalPaths).filter(([id])=>ids.has(id))):undefined}};
}

/** Cloud uploads happen outside the Home lock. Only bounded snapshot reads,
 * the final comparison, isolation and consistent restoration hold that lock. */
export class StorageNativeLifecycle {
  readonly files:StorageFileLifecycle;
  constructor(readonly catalog:StorageCatalog,readonly chunks:StorageChunkStore,readonly roots:StorageRoots,readonly isolationRoot:string,
    readonly guardItem:(item:StorageItem,file:string)=>void){
    this.files=new StorageFileLifecycle(catalog,chunks,isolationRoot,(u,r)=>storageRoot(catalog,roots,u,r),guardItem);
  }
  private home(userId:string){return storageRoot(this.catalog,this.roots,userId,'native');}
  private save(unit:NativeUnit,m:UnitManifest):void{
    this.catalog.db.prepare('UPDATE storage_native_units SET manifest_json=?,manifest_sha256=? WHERE id=?').run(JSON.stringify(m),digest(m),unit.id);
  }
  private manifest(unit:NativeUnit,verified=true):UnitManifest{
    const m=JSON.parse(unit.manifest_json??'null') as UnitManifest;
    if(!m || m.format!=='pp-native-unit-v1' || m.userId!==unit.user_id || m.conversationId!==unit.conversation_id || m.unitId!==unit.id
      || digest(m)!==unit.manifest_sha256 || verified && (!unit.verified_at || !m.complete))throw new Error('native_unit_unverified');
    return m;
  }
  private locked(home:string,files:string[]=[]):()=>void{
    const release=acquireCodexLifecycleLock(home);
    try{assertNoUnmanagedCodexRuntime(home,[...files,path.join(home,'thread_history_1.sqlite'),path.join(home,'state_5.sqlite')]);return release;}
    catch(e){release();throw e;}
  }
  private async prepareFile(unit:NativeUnit,file:string,locator:{root:string;path:string},name:string):Promise<Member>{
    const item=this.catalog.enroll({userId:unit.user_id,scope:'native-unit',sourceKey:JSON.stringify(locator),kind:'native-history',locator,name,
      trustedUsedAt:unit.last_used_at,timeBasis:'native-thread-business-time',recoveryDependency:unit.retention_days===60});
    this.catalog.link(unit.user_id,item.id,'native-conversation',unit.conversation_id);
    const prior=item.current_version?this.catalog.version(unit.user_id,item.current_version):null;
    this.guardItem(item,file);const stat=fs.statSync(file),data=await this.chunks.archiveFile(unit.user_id,file);
    const v=this.catalog.registerVersion(unit.user_id,item.id,data);
    const m:FileManifest={format:'pp-storage-file-v1',userId:unit.user_id,itemId:item.id,versionId:v.id,name,locator,
      sha256:data.sha256,bytes:data.bytes,mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid,chunks:data.chunks.map(c=>c.id)};
    this.catalog.verifyVersion(unit.user_id,v.id,m,data.chunks);this.catalog.reference(unit.user_id,v.id,'native-unit',unit.id);
    if(prior?.restored_at && prior.sha256===v.sha256 && prior.logical_bytes===v.logical_bytes)
      this.catalog.db.prepare('UPDATE storage_versions SET restored_at=? WHERE id=?').run(prior.restored_at,v.id);
    return {itemId:item.id,versionId:v.id};
  }
  async archive(conversationId:string,engineVersion:string,threadId?:string,orphan?:{userId:string;executor:string},inventoryOverride?:LineageInventory,options:{cachePressure?:boolean}={}):Promise<string|null>{
    const c=orphan?{user_id:orphan.userId,executor_id:orphan.executor,codex_thread_id:threadId,last_active_at:null}:this.catalog.db.prepare(`SELECT c.*,p.executor_id FROM conversations c JOIN projects p ON p.id=c.project_id
      WHERE c.id=? AND c.deleted_at IS NULL`).get(conversationId);
    if(!c || !['local-host','tenant-local'].includes(String(c.executor_id)))return null;
    if(orphan && conversationId!==`orphan:${orphan.userId}:${threadId}`)throw new Error('native_orphan_scope_invalid');
    const requested=threadId??String(c.codex_thread_id??'');if(!requested)return null;
    const userId=String(c.user_id),home=this.home(userId);
    let unit=this.catalog.db.prepare(`SELECT * FROM storage_native_units WHERE conversation_id=? AND state IN ('preparing','verified','isolating','isolated','evicting','cold')
      AND EXISTS(SELECT 1 FROM json_each(manifest_json,'$.lineage.threads') t WHERE json_extract(t.value,'$.id')=?) ORDER BY created_at DESC LIMIT 1`).get(conversationId,requested) as NativeUnit|undefined;
    if(unit && ['isolated','evicting','cold'].includes(unit.state))return unit.id;
    let m:UnitManifest;
    if(unit)m=this.manifest(unit,false);
    else{
      const release=this.locked(home);
      try{
        const archivedPaths=this.catalog.linked(userId,'native-conversation',conversationId).filter(i=>i.current_version).map(i=>String(JSON.parse(i.locator_json).path));
        const inventory=inventoryOverride??readLineageInventory(home),ownership=nativeOwnership(this.catalog.db,userId,String(c.executor_id),inventory);
        if(orphan){if(!ownership.orphanRoots.includes(requested))throw new Error('native_orphan_owner_changed');ownership.references.set(requested,new Set([conversationId]));}
        let result=collectConversationLineage(this.catalog.db,{conversationId,userId,executorId:String(c.executor_id),codexHome:home},archivedPaths,inventory,ownership.references);
        const legacy=this.catalog.db.prepare('SELECT * FROM conversation_storage WHERE conversation_id=?').get(conversationId);
        if(legacy?.manifest_json && (legacy.state!=='local' || result.reasons.includes('lineage_rollout_missing'))){
          const text=String(legacy.manifest_json),old=JSON.parse(text) as ColdManifest;
          if(crypto.createHash('sha256').update(text).digest('hex')!==legacy.manifest_sha256 || old.userId!==userId || old.conversationId!==conversationId
            || !old.lineage || old.lineage.codexHome!==home || old.lineage.executorId!==c.executor_id)throw new Error('legacy_native_lineage_requires_repair');
          if(!this.catalog.db.prepare("SELECT 1 FROM storage_legacy_imports WHERE kind='conversation' AND subject_id=? AND generation=? AND verified_at IS NOT NULL").get(conversationId,legacy.generation!))throw new Error('legacy_native_import_required');
          result={...result,lineage:old.lineage,reasons:[],rollouts:[]};
        }
        result.lineage=nativeFamily(result.lineage,requested);
        const familyIds=new Set(result.lineage.threads.map(t=>t.id));result.rollouts=result.rollouts.filter(r=>familyIds.has(r.id));
        if(result.reasons.length)throw new Error(`native_unit_blocked:${result.reasons.join(',')}`);
        if(!result.lineage.threads.length)return null;
        const checkpoint=Boolean(this.catalog.db.prepare('SELECT 1 FROM job_recovery_checkpoints cp JOIN jobs j ON j.id=cp.job_id WHERE j.conversation_id=?').get(conversationId));
        const retention=checkpoint || orphan?60:15;
        const times=result.rollouts.map(r=>fs.statSync(safeStorageMember(home,r.relativePath)).mtimeMs);
        for(const thread of result.lineage.threads)for(const relative of thread.paths){
          const used=this.catalog.db.prepare('SELECT last_used_at FROM storage_items WHERE user_id=? AND locator_json=?')
            .get(userId,JSON.stringify({root:'native',path:relative}));
          if(used)times.push(Number(used.last_used_at));
        }
        for(const r of result.lineage.index.tables.threads??[]){const v=Number(r.updated_at);if(Number.isFinite(v)&&v>0)times.push(v<1e12?v*1000:v);}
        let known=times.length?Math.floor(Math.max(...times)):Date.parse(String(c.last_active_at));
        if(!Number.isFinite(known)){
          const key=`native-unknown-time:${userId}:${requested}`,prior=this.catalog.db.prepare('SELECT updated_at FROM storage_scan_state WHERE name=?').get(key);
          known=prior?Number(prior.updated_at):this.catalog.now();
          this.catalog.db.prepare('INSERT OR IGNORE INTO storage_scan_state VALUES(?,?,?)').run(key,JSON.stringify({timeBasis:'migration-t0-unknown-access'}),known);
        }
        if(known+(options.cachePressure?15*60_000:retention*STORAGE_DAY)>this.catalog.now())return null;
        const id=crypto.randomUUID(),history=nativeHistoryDefinition(home,{userId,threadIds:result.lineage.threads.map(t=>t.id),engineVersion});
        const digests=history?nativeHistoryDigests(home,history):{};
        if(options.cachePressure){
          const previous=this.catalog.db.prepare(`SELECT * FROM storage_native_units WHERE user_id=? AND state='restored'
            AND EXISTS(SELECT 1 FROM json_each(manifest_json,'$.lineage.threads') t WHERE json_extract(t.value,'$.id')=?) ORDER BY created_at DESC LIMIT 1`).get(userId,requested) as NativeUnit|undefined;
          if(!previous)throw new Error('storage_native_cache_provenance_missing');
          const old=this.manifest(previous);
          if(JSON.stringify(old.digests)!==JSON.stringify(digests) || JSON.stringify(old.lineage.threads.map(t=>t.id).sort())!==JSON.stringify(result.lineage.threads.map(t=>t.id).sort()))throw new Error('storage_native_cache_changed');
          for(const member of old.rollouts){
            const item=this.catalog.item(userId,member.itemId),version=this.catalog.version(userId,member.versionId);
            if(!item.current_version || this.catalog.version(userId,item.current_version).sha256!==version.sha256
              || sha256Path(safeStorageMember(home,JSON.parse(item.locator_json).path))!==version.sha256)throw new Error('storage_native_cache_changed');
          }
        }
        m={format:'pp-native-unit-v1',userId,conversationId,unitId:id,lineage:result.lineage,history,
          digests,parts:[],rollouts:[],complete:false,...(options.cachePressure?{cachePressure:true}:{})};
        this.catalog.db.prepare(`INSERT INTO storage_native_units(id,user_id,conversation_id,created_at,last_used_at,retention_days,state)
          VALUES(?,?,?,?,?,?,'preparing')`).run(id,userId,conversationId,this.catalog.now(),known,retention);
        unit=this.catalog.db.prepare('SELECT * FROM storage_native_units WHERE id=?').get(id) as NativeUnit;this.save(unit,m);
      }finally{release();}
    }
    try{
      if(!unit.verified_at){
        const rollouts=m.lineage.threads.flatMap(t=>t.paths);
        for(let n=m.rollouts.length;n<rollouts.length;n++){
          const relative=rollouts[n],source=safeStorageMember(home,relative);
          let member:Member;
          if(fs.existsSync(source))member=await this.prepareFile(unit,source,{root:'native',path:relative},path.basename(relative));
          else{
            const item=this.catalog.linked(userId,'native-conversation',conversationId).find(i=>i.locator_json===JSON.stringify({root:'native',path:relative}));
            if(!item?.current_version || !this.catalog.version(userId,item.current_version).verified_at)throw new Error('native_rollout_archive_missing');
            member={itemId:item.id,versionId:item.current_version};this.catalog.reference(userId,member.versionId,'native-unit',unit.id);
          }
          m.rollouts.push(member);this.save(unit,m);
        }
        if(m.history){
          for(const table of m.history.tables){
            let previous=m.parts.filter(p=>p.table===table).at(-1),cursor:SQLInputValue[]|null=previous?.cursor??null;
            while(!previous?.done){
              this.chunks.checkBudget();const relative=`${unit.id}/${table}-${m.parts.length}.jsonl`;
              const directory=storageRoot(this.catalog,this.roots,userId,'native-snapshots');fs.mkdirSync(directory,{recursive:true,mode:0o700});
              const file=safeStorageMember(directory,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
              // A failed upload keeps its immutable chunk upload identity. The
              // snapshot can be recreated only after rechecking native hashes.
              if(fs.existsSync(file))fs.unlinkSync(file);
              let page:NativeHistoryPage;const release=this.locked(home);
              try{page=snapshotNativeHistoryPage(home,m.history,table,cursor,file,this.chunks.policy.chunkBytes);}finally{release();}
              try{
                const member=await this.prepareFile(unit,file,{root:'native-snapshots',path:relative},path.basename(relative));
                const part={...page,...member};m.parts.push(part);this.save(unit,m);previous=part;cursor=page.cursor;
                this.catalog.db.prepare("UPDATE storage_versions SET state='cold' WHERE id=?").run(member.versionId);
              }finally{fs.unlinkSync(file);}
            }
          }
        }
        const release=this.locked(home);
        try{
          if(m.history && JSON.stringify(nativeHistoryDigests(home,m.history))!==JSON.stringify(m.digests))throw new Error('native_unit_source_changed');
          for(const member of m.rollouts){const item=this.catalog.item(userId,member.itemId),v=this.catalog.version(userId,member.versionId);
            const source=safeStorageMember(home,JSON.parse(item.locator_json).path);
            if(fs.existsSync(source) && sha256Path(source)!==v.sha256)throw new Error('native_unit_source_changed');}
          mutateThreadIndex(home,m.lineage.index,'check');
          m.complete=true;this.save(unit,m);
          this.catalog.db.prepare("UPDATE storage_native_units SET state='verified',verified_at=? WHERE id=?").run(this.catalog.now(),unit.id);
        }finally{release();}
      }
      // All bytes and the history/index unit are verified before the first
      // rollout is moved. Reused chunks make this phase local and bounded.
      const release=this.locked(home);
      try{
        this.catalog.db.prepare("UPDATE storage_native_units SET state='isolating' WHERE id=?").run(unit.id);
        for(const member of m.rollouts){const item=this.catalog.item(userId,member.itemId);
          if(fs.existsSync(safeStorageMember(home,JSON.parse(item.locator_json).path)))await this.files.archive(userId,member.itemId,{cachePressure:m.cachePressure});}
        this.catalog.db.prepare("UPDATE storage_native_units SET state='isolated',isolated_at=COALESCE(isolated_at,?),blocked_reason=NULL WHERE id=?").run(this.catalog.now(),unit.id);
      }finally{release();}
      this.catalog.audit(userId,null,null,'native_unit_isolated',0,{unit:unit.id,threads:m.lineage.threads.length});return unit.id;
    }catch(e){
      const reason=e instanceof Error?e.message:'native_unit_failed';
      this.catalog.db.prepare("UPDATE storage_native_units SET blocked_reason=?,state=CASE WHEN ?='native_unit_source_changed' THEN 'stale' ELSE state END WHERE id=?").run(reason,reason,unit.id);
      throw e;
    }
  }
  purgeHistory(unit:NativeUnit):void{
    if(!['isolated','evicting'].includes(unit.state) || !unit.isolated_at || unit.isolated_at+this.chunks.policy.graceMs>this.catalog.now())return;
    const m=this.manifest(unit),home=this.home(unit.user_id),release=this.locked(home);
    try{
      for(const member of m.rollouts){const item=this.catalog.item(unit.user_id,member.itemId);
        this.guardItem(item,safeStorageMember(home,JSON.parse(item.locator_json).path));
        if(item.last_used_at>unit.last_used_at)throw new Error('native_unit_used_since_isolation');}
      this.catalog.db.prepare("UPDATE storage_native_units SET state='evicting' WHERE id=?").run(unit.id);
      mutateThreadIndex(home,m.lineage.index,'check');
      if(m.history)removeNativeHistoryParts(home,m.history,m.digests);
      mutateThreadIndex(home,m.lineage.index,'remove');
      this.catalog.db.prepare("UPDATE storage_native_units SET state='cold',removed_at=?,blocked_reason=NULL WHERE id=?").run(this.catalog.now(),unit.id);
      this.catalog.audit(unit.user_id,null,null,'native_rows_removed',0,{unit:unit.id});
    }catch(e){this.catalog.db.prepare('UPDATE storage_native_units SET blocked_reason=? WHERE id=?').run(e instanceof Error?e.message:'native_purge_failed',unit.id);throw e;}
    finally{release();}
  }
  async restore(userId:string,conversationId:string,threadId?:string,unitId?:string):Promise<boolean>{
    const requested=threadId??this.catalog.db.prepare('SELECT codex_thread_id FROM conversations WHERE id=? AND user_id=?').get(conversationId,userId)?.codex_thread_id;
    if(typeof requested!=='string' || !requested)return false;
    const unit=this.catalog.db.prepare(`SELECT * FROM storage_native_units WHERE user_id=? AND (conversation_id=? OR conversation_id LIKE 'orphan:%') AND state IN ('verified','isolating','isolated','evicting','cold','restoring')
      AND (? IS NULL OR id=?) AND EXISTS(SELECT 1 FROM json_each(manifest_json,'$.lineage.threads') t WHERE json_extract(t.value,'$.id')=?) ORDER BY created_at DESC LIMIT 1`).get(userId,conversationId,unitId??null,unitId??null,requested) as NativeUnit|undefined;
    if(!unit)return false;
    const m=this.manifest(unit),home=this.home(userId),release=this.locked(home);
    const report=this.chunks.onProgress,total=m.parts.reduce((sum,p)=>sum+p.bytes,0)+m.rollouts.reduce((sum,r)=>sum+this.catalog.version(userId,r.versionId).logical_bytes,0);
    let completed=0;
    this.chunks.onProgress=value=>report?.({...value,completed:completed+value.completed,total,estimated:true});
    try{
      this.catalog.db.prepare("UPDATE storage_native_units SET state='restoring' WHERE id=?").run(unit.id);
      if(m.history){for(const part of m.parts){
        const version=this.catalog.version(userId,part.versionId),fm=JSON.parse(version.manifest_json!) as FileManifest;
        const chunks=fm.chunks.map(id=>this.catalog.db.prepare('SELECT * FROM storage_chunks WHERE id=? AND user_id=?').get(id,userId)) as StorageChunk[];
        const file=path.join(this.chunks.scratch,`${crypto.randomUUID()}.native-page`);
        try{await this.chunks.restoreFile(userId,chunks,file,fm);report?.({stage:'installing',completed:completed+part.bytes,total,estimated:true});await restoreNativeHistoryPage(home,m.history,part,file);completed+=part.bytes;}
        finally{try{fs.unlinkSync(file);}catch{}}
      }
        if(JSON.stringify(nativeHistoryDigests(home,m.history))!==JSON.stringify(m.digests))throw new Error('native_unit_restored_history_mismatch');
      }
      for(const member of m.rollouts){
        const item=this.catalog.item(userId,member.itemId);
        if(item.current_version!==member.versionId)throw new Error('native_unit_version_changed');
        await this.files.restore(userId,member.itemId,'resume');
        completed+=this.catalog.version(userId,member.versionId).logical_bytes;report?.({stage:'installing',completed,total,estimated:true});
      }
      validateRestoredLineage(home,m.lineage);mutateThreadIndex(home,m.lineage.index,'restore');
      this.catalog.db.prepare("UPDATE storage_native_units SET state='restored',restored_at=?,blocked_reason=NULL WHERE id=?").run(this.catalog.now(),unit.id);
      this.catalog.audit(userId,null,null,'native_unit_restored',0,{unit:unit.id});return true;
    }catch(e){this.catalog.db.prepare('UPDATE storage_native_units SET blocked_reason=? WHERE id=?').run(e instanceof Error?e.message:'native_restore_failed',unit.id);throw e;}
    finally{this.chunks.onProgress=report;release();}
  }
}
