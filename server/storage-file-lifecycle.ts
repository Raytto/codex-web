import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import { StorageCatalog, type StorageItem, type StorageReplica, type StorageVersion } from './storage-catalog.js';
import { StorageChunkStore, fileFingerprint, sha256Path } from './storage-chunks.js';
import type { UsageEvidence } from './storage-lifecycle-policy.js';

export type FileLocator = {root:string;path:string};
export type FileManifest = {format:'pp-storage-file-v1';userId:string;itemId:string;versionId:string;name:string;
  locator:FileLocator;sha256:string;bytes:number;mode:number;uid:number;gid:number;chunks:string[]};
export function safeStorageMember(root:string,relative:string):string {
  if(!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p=>!p || p==='.' || p==='..'))throw new Error('storage_path_invalid');
  let current=path.resolve(root);
  let ancestor=current;
  while(!fs.existsSync(ancestor)){
    const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error('storage_root_missing');ancestor=parent;
  }
  if(fs.realpathSync(ancestor)!==ancestor)throw new Error('storage_root_alias');
  for(const part of relative.split('/')){
    current=path.join(current,part);
    try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('storage_member_symlink');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }return current;
}
function syncDirectory(directory:string):void {const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function fileLock(directory:string,id:string):()=>void {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,crypto.createHash('sha256').update(id).digest('hex'));
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  try{execFileSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','pipe',fd]});}
  catch{fs.closeSync(fd);throw new Error('storage_item_busy');}
  return ()=>fs.closeSync(fd);
}
export function assertFileNotOpen(file:string):void {
  const deadline=performance.now()+500;
  if(process.platform!=='linux')throw new Error('storage_process_inspection_unsupported');
  if(!fs.existsSync(file))return;
  const st=fs.lstatSync(file),key=`${st.dev}:${st.ino}`;
  for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p) && Number(p)!==process.pid)){
    try{
      for(const fd of fs.readdirSync(`/proc/${pid}/fd`)){
        if(performance.now()>deadline)throw new Error('storage_process_inspection_budget');
        try{const s=fs.statSync(`/proc/${pid}/fd/${fd}`);if(`${s.dev}:${s.ino}`===key)throw new Error('storage_file_in_use');}
        catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
      }
    }catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
  }
}

function settleStandaloneSqlite(file:string):void{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),magic=Buffer.alloc(16);
 let sqlite=false;try{sqlite=fs.readSync(fd,magic,0,16,0)===16 && magic.toString()==='SQLite format 3\0';}finally{fs.closeSync(fd);}
 if(!sqlite)return;
 // Fold a quiet database's WAL through SQLite itself. Active connections are
 // rejected, not killed; no WAL/SHM is ever removed by filesystem operations.
 assertFileNotOpen(file);const db=new DatabaseSync(file);
 try{db.exec('PRAGMA busy_timeout=1000');const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if(checkpoint?.busy!==0 || db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('storage_sqlite_not_quiescent');
 }finally{db.close();}
}

/** Resolution must prove tenant ownership. guard must reconcile actual jobs,
 * processes and leases, not just trust a stale persisted running label. */
export class StorageFileLifecycle {
  constructor(readonly catalog:StorageCatalog,readonly chunks:StorageChunkStore,readonly isolationRoot:string,
    readonly resolveRoot:(userId:string,root:string)=>string,
    readonly guard:(item:StorageItem,localPath:string)=>void=(_item,file)=>assertFileNotOpen(file)){
    fs.mkdirSync(isolationRoot,{recursive:true,mode:0o700});
    if(fs.realpathSync(isolationRoot)!==path.resolve(isolationRoot))throw new Error('storage_isolation_alias');
  }
  private source(item:StorageItem):string {
    const loc=JSON.parse(item.locator_json) as FileLocator;
    if(typeof loc.root!=='string' || typeof loc.path!=='string')throw new Error('storage_locator_invalid');
    return safeStorageMember(this.resolveRoot(item.user_id,loc.root),loc.path);
  }
  private lock(item:StorageItem):()=>void{return fileLock(path.join(this.isolationRoot,'.locks'),item.id);}
  private manifest(version:StorageVersion):FileManifest {
    if(!version.verified_at || !version.manifest_json || crypto.createHash('sha256').update(version.manifest_json).digest('hex')!==version.manifest_sha256)throw new Error('storage_manifest_unverified');
    const m=JSON.parse(version.manifest_json) as FileManifest;
    if(m.format!=='pp-storage-file-v1' || m.userId!==version.user_id || m.itemId!==version.item_id || m.versionId!==version.id
      || m.sha256!==version.sha256 || m.bytes!==version.logical_bytes)throw new Error('storage_manifest_identity');
    return m;
  }
  async archive(userId:string,itemId:string,options:{cachePressure?:boolean}={}):Promise<StorageReplica> {
    let item=this.catalog.item(userId,itemId);const release=this.lock(item);
    try{
      const eligible=(value:StorageItem)=>this.catalog.due(value) || Boolean(options.cachePressure && value.usage_not_before<=this.catalog.now() && value.current_version
        && this.catalog.version(userId,value.current_version).restored_at && value.last_used_at+15*60_000<=this.catalog.now());
      item=this.catalog.item(userId,itemId);if(!eligible(item))throw new Error('storage_not_due');
      const cached=options.cachePressure && item.current_version?this.catalog.version(userId,item.current_version):null;
      const source=this.source(item);
      // Resume a process exit after rename without requiring the source to exist.
      if(item.current_version){
        const v=this.catalog.version(userId,item.current_version);
        const existing=this.catalog.db.prepare("SELECT * FROM storage_replicas WHERE version_id=? AND released_at IS NULL AND purpose='isolation'").get(v.id) as StorageReplica|undefined;
        if(existing && fs.existsSync(existing.path) && !fs.existsSync(source)){
          this.validateReplica(item,v,existing);
          this.catalog.db.prepare("UPDATE storage_replicas SET isolated_at=COALESCE(isolated_at,?),state='present' WHERE id=?").run(this.catalog.now(),existing.id);
          this.catalog.db.prepare("UPDATE storage_versions SET state='cold' WHERE id=?").run(v.id);return existing;
        }
      }
      this.guard(item,source);
      settleStandaloneSqlite(source);
      const before=fs.lstatSync(source),accessRevision=item.revision;
      const archived=await this.chunks.archiveFile(userId,source,{firstSeenAt:item.enrolled_at});
      if(cached && (cached.sha256!==archived.sha256 || cached.logical_bytes!==archived.bytes))throw new Error('storage_cache_copy_changed');
      // Reads and writers can proceed during upload; any real use aborts eviction.
      item=this.catalog.item(userId,itemId);
      if(item.revision!==accessRevision || !eligible(item) || fileFingerprint(fs.lstatSync(source))!==archived.fingerprint)throw new Error('storage_source_or_usage_changed');
      this.guard(item,source);
      if(fileFingerprint(fs.lstatSync(source))!==archived.fingerprint)throw new Error('storage_source_changed_after_guard');
      const version=this.catalog.registerVersion(userId,itemId,archived);
      const manifest:FileManifest={format:'pp-storage-file-v1',userId,itemId,versionId:version.id,name:item.display_name,
        locator:JSON.parse(item.locator_json),sha256:archived.sha256,bytes:archived.bytes,mode:before.mode&0o777,uid:before.uid,gid:before.gid,chunks:archived.chunks.map(c=>c.id)};
      this.catalog.verifyVersion(userId,version.id,manifest,archived.chunks);
      // A restored file has a new inode/fingerprint, hence a new generation.
      // Preserve its cache provenance across that generation and crash retries.
      if(cached?.restored_at)this.catalog.db.prepare('UPDATE storage_versions SET restored_at=? WHERE id=?').run(cached.restored_at,version.id);
      const relative=`${userId}/${itemId}/${version.generation}/${crypto.randomUUID()}.bin`;
      const isolated=safeStorageMember(this.isolationRoot,relative);fs.mkdirSync(path.dirname(isolated),{recursive:true,mode:0o700});
      // Commit intent before the filesystem mutation. A crash cannot leave an
      // untracked original, and planned time never starts the isolation grace.
      const replicaId=crypto.randomUUID();
      this.catalog.db.prepare(`INSERT INTO storage_replicas(id,user_id,version_id,path,purpose,created_at,verified_at,allocated_bytes,state)
        VALUES(?,?,?,?,'isolation',?,?,?,'planned')`).run(replicaId,userId,version.id,isolated,this.catalog.now(),this.catalog.version(userId,version.id).verified_at!,before.blocks*512);
      this.catalog.db.prepare("UPDATE storage_versions SET state='isolating' WHERE id=?").run(version.id);
      // Hashing can take seconds for a large object. Do it before reserving
      // the shared writer; the inode/size/mtime/ctime fingerprint is checked
      // again under the transaction immediately before the atomic rename.
      if(sha256Path(source)!==version.sha256 || fileFingerprint(fs.lstatSync(source))!==archived.fingerprint)throw new Error('storage_evict_recheck_failed');
      return this.catalog.transaction(()=>{
        const current=this.catalog.item(userId,itemId);this.guard(current,source);
        if(!eligible(current) || current.current_version!==version.id || current.last_used_at!==item.last_used_at
          || fileFingerprint(fs.lstatSync(source))!==archived.fingerprint)throw new Error('storage_evict_recheck_failed');
        // Directory rename is atomic. The recorded generation is independent of
        // the currently warm version and never overwritten on the next cycle.
        fs.renameSync(source,isolated);syncDirectory(path.dirname(source));syncDirectory(path.dirname(isolated));
        this.catalog.db.prepare("UPDATE storage_versions SET state='cold' WHERE id=?").run(version.id);
        this.catalog.db.prepare("UPDATE storage_replicas SET isolated_at=?,state='present' WHERE id=?").run(this.catalog.now(),replicaId);
        this.catalog.audit(userId,itemId,version.id,'isolated',before.blocks*512,{replica:replicaId});
        return this.catalog.db.prepare('SELECT * FROM storage_replicas WHERE id=?').get(replicaId) as StorageReplica;
      },'storage_file_isolate');
    }catch(e){this.catalog.block(userId,itemId,e instanceof Error?e.message:'storage_archive_failed');throw e;}
    finally{release();}
  }
  async restore(userId:string,itemId:string,evidence:UsageEvidence):Promise<string> {
    let item=this.catalog.item(userId,itemId);const release=this.lock(item);let temporary='';
    try{
      item=this.catalog.item(userId,itemId);if(!item.current_version)throw new Error('storage_no_version');
      const version=this.catalog.version(userId,item.current_version),m=this.manifest(version),source=this.source(item);
      if(JSON.stringify(m.locator)!==item.locator_json)throw new Error('storage_locator_changed');
      if(fs.existsSync(source)){
        if(!fs.lstatSync(source).isFile() || sha256Path(source)!==m.sha256)throw new Error('storage_restore_target_conflict');
      }else{
        const chunks=m.chunks.map(id=>{
          const c=this.catalog.db.prepare('SELECT * FROM storage_chunks WHERE id=? AND user_id=?').get(id,userId);
          if(!c)throw new Error('storage_chunk_missing');return c;
        }) as unknown as Parameters<StorageChunkStore['restoreFile']>[1];
        const missing:string[]=[];let directory=path.dirname(source);
        while(!fs.existsSync(directory)){missing.unshift(directory);directory=path.dirname(directory);}
        for(const member of missing){fs.mkdirSync(member,{mode:0o700});if(process.getuid?.()===0)fs.chownSync(member,m.uid,m.gid);}
        temporary=`${source}.pp-restore-${crypto.randomUUID()}`;
        this.catalog.db.prepare("UPDATE storage_versions SET state='restoring' WHERE id=?").run(version.id);
        await this.chunks.restoreFile(userId,chunks,temporary,m);
        fs.chmodSync(temporary,m.mode);if(process.getuid?.()===0)fs.chownSync(temporary,m.uid,m.gid);
        this.catalog.transaction(()=>{
          if(this.catalog.item(userId,itemId).current_version!==version.id || fs.existsSync(source))throw new Error('storage_restore_target_changed');
          // link+unlink provides atomic no-replace publication; this is a newly
          // verified immutable temp file, never a live DB/rollout dedup link.
          fs.linkSync(temporary,source);fs.unlinkSync(temporary);temporary='';syncDirectory(path.dirname(source));
        });
      }
      this.catalog.db.prepare("UPDATE storage_versions SET state='local',restored_at=? WHERE id=?").run(this.catalog.now(),version.id);
      this.catalog.touch(userId,itemId,evidence);this.catalog.audit(userId,itemId,version.id,'restored',version.logical_bytes);
      return source;
    }catch(e){this.catalog.block(userId,itemId,e instanceof Error?e.message:'storage_restore_failed');throw e;}
    finally{if(temporary)try{fs.unlinkSync(temporary);}catch{}release();}
  }
  private validateReplica(item:StorageItem,v:StorageVersion,r:StorageReplica):void {
    const m=this.manifest(v),relative=path.relative(this.isolationRoot,r.path);
    if(r.user_id!==item.user_id || r.version_id!==v.id || !relative.startsWith(`${item.user_id}/${item.id}/`)
      || safeStorageMember(this.isolationRoot,relative)!==r.path)throw new Error('storage_replica_scope');
    const stat=fs.lstatSync(r.path);
    if(!stat.isFile() || stat.nlink!==1 || stat.size!==m.bytes || sha256Path(r.path)!==m.sha256)throw new Error('storage_replica_changed');
    this.guard(item,r.path);
  }
  purge(replica:StorageReplica):number {
    const v=this.catalog.version(replica.user_id,replica.version_id),item=this.catalog.item(replica.user_id,v.item_id),release=this.lock(item);
    try{
      const r=this.catalog.db.prepare('SELECT * FROM storage_replicas WHERE id=? AND user_id=?').get(replica.id,replica.user_id) as StorageReplica;
      if(r.released_at!==null)return 0;
      if(r.isolated_at===null || r.isolated_at+this.chunks.policy.graceMs>this.catalog.now())throw new Error('storage_replica_in_grace');
      this.manifest(v);
      if(!fs.existsSync(r.path)){
        if(r.state!=='releasing')throw new Error('storage_replica_missing_unexplained');
      }else{
        this.validateReplica(item,v,r);
        this.catalog.db.prepare("UPDATE storage_replicas SET state='releasing' WHERE id=?").run(r.id);
        fs.unlinkSync(r.path);syncDirectory(path.dirname(r.path));
      }
      this.catalog.db.prepare("UPDATE storage_replicas SET state='released',released_at=?,released_bytes=allocated_bytes,blocked_reason=NULL WHERE id=?").run(this.catalog.now(),r.id);
      this.catalog.audit(item.user_id,item.id,v.id,'physically_released',r.allocated_bytes,{replica:r.id});return r.allocated_bytes;
    }catch(e){this.catalog.db.prepare("UPDATE storage_replicas SET state=CASE WHEN state='releasing' THEN state ELSE 'blocked' END,blocked_reason=? WHERE id=?").run(e instanceof Error?e.message:'storage_purge_failed',replica.id);throw e;}
    finally{release();}
  }
}
