import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {StorageHost} from './storage-host.js';
import {StorageBackups,backupLegacyObjects,type BackupMaterial,type BackupPoint,type BackupDescriptor,type UnavailableOriginal} from './storage-backups.js';
import type {ColdManifest} from './conversation-cold-storage.js';
import type {StorageItem} from './storage-catalog.js';
import {storageRoot,fileStorageLocator} from './storage-inventory.js';
import {acquireCodexLifecycleLock,assertNoUnmanagedCodexRuntime} from './codex-lifecycle-lock.js';
import {maintenanceLock} from './storage-maintenance.js';
import {safeStorageMember} from './storage-file-lifecycle.js';
import {SqliteStreamSnapshot,SqliteBinarySnapshot,createDatabaseSnapshot} from './storage-sqlite-stream.js';
import {fileFingerprint,sha256Path} from './storage-chunks.js';
import {isStorageIdentity} from './storage-key.js';

export type RecoverySource={source:string;target:string;userId?:string;exclude?:string[];optional?:boolean};
export type BackupPlan={format:'pp-storage-backup-plan-v1';codeSha:string;keyRecovery:BackupDescriptor['keyRecovery'];localRecoveryRoot:string;
  extraSources:RecoverySource[];excludeData:string[];excludeTenant:string[];excludeNative:string[];knownMissingOriginals?:UnavailableOriginal[];};
export function readBackupPlan(file:string):BackupPlan{
 const st=fs.lstatSync(file);if(!st.isFile() || st.isSymbolicLink() || (st.mode&0o077)!==0 || st.size>1024*1024)throw new Error('storage_backup_plan_permissions');
 const plan=JSON.parse(fs.readFileSync(file,'utf8')) as BackupPlan;
 if(plan.format!=='pp-storage-backup-plan-v1' || !path.isAbsolute(plan.localRecoveryRoot) || !Array.isArray(plan.extraSources)
  || ![plan.excludeData,plan.excludeTenant,plan.excludeNative].every(Array.isArray))throw new Error('storage_backup_plan_invalid');
 return plan;
}
function sqliteFile(file:string):boolean{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const b=Buffer.alloc(16);return fs.readSync(fd,b,0,16,0)===16 && b.toString()==='SQLite format 3\0';}finally{fs.closeSync(fd);}}
function excluded(relative:string,patterns:string[]):boolean{return patterns.some(p=>relative===p || relative.startsWith(p+'/') || p.startsWith('**/') && relative.split('/').includes(p.slice(3)));}

/** The restore manifest is complete; data bytes are immutable per-file chunks
 * reused across points. No full-site tarball is created locally or remotely. */
export async function createStorageBackup(host:StorageHost,plan:BackupPlan):Promise<BackupPoint>{
 const release=maintenanceLock(host.roots.lifecycleRoot!,'backup'),snapshots=new Map<string,SqliteStreamSnapshot|SqliteBinarySnapshot>(),homeLocks:Array<()=>void>=[];
 const backups=new StorageBackups(host.catalog,host.chunks,{instanceId:host.policy.instanceId,codeSha:plan.codeSha,keyRecovery:plan.keyRecovery,
  assertPresent:c=>host.reader.assertPresent(c.remote_path,c.ciphertext_bytes,c.remote_file_id)});
 try{
  const point=await backups.create(async id=>{
   const materials=new Map<string,BackupMaterial>(),accountSources:RecoverySource[]=[];
   type Entry={file:string;target:string;userId?:string;fingerprint:string;inode:string};
   const entries:Entry[]=[],seen=new Set<string>(),sourceFiles=new Set<string>();
   for(const user of host.db.prepare('SELECT id FROM users ORDER BY id').all()){
    const uid=String(user.id),home=storageRoot(host.catalog,host.roots,uid,'native');
    if(fs.existsSync(home)){
     homeLocks.push(acquireCodexLifecycleLock(home));assertNoUnmanagedCodexRuntime(home,[]);
     accountSources.push({source:home,target:`users/${uid}/native`,userId:uid,exclude:[...plan.excludeNative,'cache','logs_2.sqlite','log','tmp/arg0','tmp/arg0-linux']});
    }
    accountSources.push({source:path.join(host.roots.tenantRoot,uid),target:`users/${uid}/tenant`,userId:uid,exclude:[...plan.excludeTenant,'codex-home'],optional:true});
   }
   const sources:RecoverySource[]=[{source:host.roots.dataRoot,target:'data',exclude:[...plan.excludeData,path.relative(host.roots.dataRoot,host.legacyRoots.databasePath)]},...accountSources,...plan.extraSources];
   for(const source of sources){
    if(!path.isAbsolute(source.source) || path.resolve(source.source)!==source.source)throw new Error('storage_backup_source_configuration');
    safeStorageMember('/tmp',source.target);
    if(!fs.existsSync(source.source)){if(source.optional)continue;throw new Error('storage_backup_source_missing');}
    const visit=(file:string,relative:string)=>{
     if(excluded(relative,source.exclude??[]) || /-(wal|shm)$/.test(file) || /\.sqlite-journal$/.test(file))return;
     const st=fs.lstatSync(file);
     if(st.isSymbolicLink())throw new Error('storage_backup_symlink_requires_explicit_target');
     if(st.isDirectory()){for(const name of fs.readdirSync(file).sort())visit(path.join(file,name),relative?`${relative}/${name}`:name);return;}
     if(!st.isFile() || isStorageIdentity(file,host.policy.identity))return;
     const target=path.posix.join(source.target,relative);
     if(seen.has(target) || sourceFiles.has(file))throw new Error('storage_backup_source_overlap');
     if(entries.length>=200000)throw new Error('storage_backup_inventory_budget');
     seen.add(target);sourceFiles.add(file);entries.push({file,target,userId:source.userId,fingerprint:fileFingerprint(st),inode:`${st.dev}:${st.ino}`});
     if(sqliteFile(file)){
       host.chunks.checkBudget();snapshots.set(file,createDatabaseSnapshot(file,host.chunks.scratch,host.policy.chunkBytes));
     }
    };visit(source.source,'');
   }
   // Freeze the registered-file catalogue at the same idle-engine boundary.
   // Capture exactly the listed files: later additions cannot silently change
   // the restore point, and disappearing/changing originals abort publication.
   const main=new SqliteStreamSnapshot(host.legacyRoots.databasePath);snapshots.set(host.legacyRoots.databasePath,main);
   const legacy=backupLegacyObjects(main.db),unavailableOriginals:UnavailableOriginal[]=[];
   const legacyManifests=new Map<string,ColdManifest|null>();
   const legacyCovers=(file:Record<string,unknown>):boolean=>{
    const cid=String(file.conversation_id);
    if(!legacyManifests.has(cid)){
     const row=main.db.prepare('SELECT * FROM conversation_storage WHERE conversation_id=?').get(cid);let m:ColdManifest|null=null;
     if(row?.verified_at && row.manifest_json && row.manifest_sha256 && legacy.some(o=>o.kind==='conversation' && o.remote_drive===row.remote_drive_id
       && o.remote_path===row.remote_path && o.archive_sha256===row.archive_sha256 && o.archive_bytes===row.archive_bytes)){
      const text=String(row.manifest_json);
      if(crypto.createHash('sha256').update(text).digest('hex')===row.manifest_sha256){
       const parsed=JSON.parse(text) as ColdManifest;
       if(['conversation-cold-storage-v1','conversation-cold-storage-v2','conversation-cold-storage-v3'].includes(parsed.format)
         && parsed.conversationId===cid && parsed.userId===file.user_id && parsed.generation===row.generation)m=parsed;
      }
     }
     legacyManifests.set(cid,m);
    }
    const loc=fileStorageLocator(file as unknown as Parameters<typeof fileStorageLocator>[0]);
    return legacyManifests.get(cid)?.entries.some(e=>e.root===(loc.root.startsWith('deliverable:')?'dataRoot':'conversation')
      && e.relativePath===file.relative_path && e.size===file.size && /^[a-f0-9]{64}$/.test(e.sha256))??false;
   };
   const coldPaths=new Set<string>();
   for(const item of main.db.prepare(`SELECT i.* FROM storage_items i WHERE current_version IS NOT NULL AND scope!='backup-material'
     AND NOT (i.scope='events' AND EXISTS(SELECT 1 FROM storage_event_batches b WHERE b.item_id=i.id AND b.expires_at<=?))`).all(Date.now()) as StorageItem[]){
    const reference=backups.referenceCloudVersion(id,item.user_id,item.current_version!);materials.set(reference.target,reference);
    let file:string;try{file=host.source(item);}catch{continue;}
    if(fs.existsSync(file))continue;
    coldPaths.add(file);
   }
   // Finite cloud references include checkpoint history and earlier versions,
   // not only the current version of objects that are still hot locally.
   for(const row of main.db.prepare(`SELECT DISTINCT r.user_id,r.version_id FROM storage_references r
     WHERE r.kind!='backup' AND (r.expires_at IS NULL OR r.expires_at>?)`).all(Date.now())){
    const reference=backups.referenceCloudVersion(id,String(row.user_id),String(row.version_id));materials.set(reference.target,reference);
   }
   const listed=new Set(entries.map(e=>e.file));
   for(const file of main.db.prepare(`SELECT f.*,c.user_id FROM files f JOIN conversations c ON c.id=f.conversation_id
     WHERE c.deleted_at IS NULL AND c.deletion_state='active'`).all()){
    const locator=fileStorageLocator(file as unknown as Parameters<typeof fileStorageLocator>[0]);
    const original=safeStorageMember(storageRoot(host.catalog,host.roots,String(file.user_id),locator.root),locator.path);
    if(!listed.has(original) && !coldPaths.has(original) && !(!fs.existsSync(original) && legacyCovers(file))){
     const known=plan.knownMissingOriginals?.find(k=>k.fileId===file.id && k.userId===file.user_id && k.relativePath===file.relative_path
       && k.bytes===file.size && k.reason==='pre-existing-unavailable' && /^[a-f0-9]{64}$/.test(k.evidenceSha256));
     // Never silently turn a newly missing original into a valid backup.
     // An operator must first supply exact, durable absence evidence for an
     // older broken reference. Preserve that limitation in every restore point.
     if(!known || fs.existsSync(original))throw new Error('storage_backup_registered_original_uncovered');
     unavailableOriginals.push({...known});host.catalog.issue('backup-original',String(file.id),String(file.user_id),'storage_preexisting_original_unavailable');
    }
   }
   for(const unlock of homeLocks.splice(0).reverse())unlock();
   // Stream the main DB first to release its WAL read snapshot promptly.
   materials.set('database/main.sqlite',await backups.captureDatabaseSnapshot(id,'database/main.sqlite',host.legacyRoots.databasePath,main));main.close();snapshots.delete(host.legacyRoots.databasePath);
   for(const entry of entries.sort((a,b)=>Number(snapshots.has(b.file))-Number(snapshots.has(a.file)))){
    const stat=fs.lstatSync(entry.file),snapshot=snapshots.get(entry.file);
    if(`${stat.dev}:${stat.ino}`!==entry.inode || (!snapshot && fileFingerprint(stat)!==entry.fingerprint))throw new Error('storage_backup_source_changed_retry');
    const material=snapshot?await backups.captureDatabaseSnapshot(id,entry.target,entry.file,snapshot,entry.userId):await backups.captureFile(id,entry.target,entry.file,entry.userId);
    if(snapshot){snapshot.close();snapshots.delete(entry.file);}
    else if(fileFingerprint(fs.lstatSync(entry.file))!==entry.fingerprint)throw new Error('storage_backup_source_changed_retry');
    if(materials.has(entry.target))throw new Error('storage_backup_target_overlap');materials.set(entry.target,material);
   }
   return {materials:[...materials.values()],legacy,unavailableOriginals};
  });
  backups.retireExpired();return point;
 }finally{for(const unlock of homeLocks.reverse())unlock();for(const snapshot of snapshots.values())snapshot.close();release();}
}

export function compactLocalRecoveryPoint(host:StorageHost,plan:BackupPlan):{path:string;bytes:number;sha256:string}{
 if(!host.db.prepare("SELECT 1 FROM storage_backup_points WHERE state='verified' AND restore_tested_at IS NOT NULL").get())throw new Error('storage_cloud_recovery_drill_required');
 const release=maintenanceLock(host.roots.lifecycleRoot!,'local-recovery');
 try{
  fs.mkdirSync(plan.localRecoveryRoot,{recursive:true,mode:0o700});
  const pointer=safeStorageMember(plan.localRecoveryRoot,'current.json'),previous=fs.existsSync(pointer)?JSON.parse(fs.readFileSync(pointer,'utf8')):null;
  const name=`point-${crypto.randomUUID()}`,directory=safeStorageMember(plan.localRecoveryRoot,name);
  const size=fs.statSync(host.legacyRoots.databasePath).size,disk=fs.statfsSync(plan.localRecoveryRoot);
  if(disk.bavail*disk.bsize-size<disk.blocks*disk.bsize*.1)throw new Error('storage_recovery_snapshot_reserve');
  fs.mkdirSync(directory,{mode:0o700});const target=path.join(directory,'database.sqlite');
  host.db.prepare('VACUUM INTO ?').run(target);
  const candidate=new DatabaseSync(target,{readOnly:true});try{if(candidate.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('storage_recovery_snapshot_integrity');}finally{candidate.close();}
  fs.chmodSync(target,0o600);const fd=fs.openSync(target,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const sha256=sha256Path(target),manifest={format:'pp-storage-local-recovery-v1',directory:name,database:'database.sqlite',source:host.legacyRoots.databasePath,
   createdAt:Date.now(),sha256,bytes:fs.statSync(target).size,quickCheck:'ok'};
  const publish=(file:string,value:unknown)=>{
   const tmp=file+'.'+crypto.randomUUID()+'.tmp',handle=fs.openSync(tmp,'wx',0o600);
   try{fs.writeFileSync(handle,JSON.stringify(value)+'\n');fs.fsyncSync(handle);}finally{fs.closeSync(handle);}
   fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  };
  publish(path.join(directory,'manifest.json'),manifest);publish(pointer,manifest);
  if(previous?.format===manifest.format && previous.source===manifest.source && /^point-[a-f0-9-]{36}$/.test(previous.directory)){
   const old=safeStorageMember(plan.localRecoveryRoot,previous.directory);
   if(fs.existsSync(old) && !fs.lstatSync(old).isSymbolicLink() && sha256Path(path.join(old,'database.sqlite'))===previous.sha256)fs.rmSync(old,{recursive:true});
  }
  return {path:target,bytes:fs.statSync(target).blocks*512,sha256};
 }finally{release();}
}
