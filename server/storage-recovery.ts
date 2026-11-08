import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Readable} from 'node:stream';
import {readBackupManifest,restoreBackupMaterial,type BackupDescriptor,type BackupManifest,type BackupMaterial,type UnavailableOriginal} from './storage-backups.js';
import {StorageChunkStore,sha256Path} from './storage-chunks.js';
import {safeStorageMember} from './storage-file-lifecycle.js';
import {SqliteStreamSnapshot,verifySqliteBinary} from './storage-sqlite-stream.js';
import {verifyTarStream} from './storage-tar.js';
import {maintenanceLock} from './storage-maintenance.js';
import {consumeAgeFile} from './storage-age-stream.js';
import {StorageCatalog} from './storage-catalog.js';

type RecoveryEntry={verifiedAt:number;fileSha256?:string;bytes:number};
export type RecoveryJournal={format:'pp-recovery-journal-v1';descriptorSha256:string;instanceId:string;pointId:string;
  startedAt:number;finishedAt?:number;catalogInstalling?:boolean;catalogInstalledAt?:number;complete:boolean;materials:Record<string,RecoveryEntry>;legacy:Record<string,RecoveryEntry>;unavailableOriginals?:UnavailableOriginal[]};
function durableJson(file:string,value:unknown):void{
 const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
 const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
function validateMaterial(m:BackupMaterial):void{
 if(!m || !['file','sqlite-stream','sqlite-binary','catalog-version','cloud-reference'].includes(m.format) || !/^[a-zA-Z0-9_-]+$/.test(m.userId)
  || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes<0 || !Number.isInteger(m.mode) || m.mode<0 || m.mode>0o777
  || !Number.isSafeInteger(m.uid) || m.uid<0 || !Number.isSafeInteger(m.gid) || m.gid<0 || !Array.isArray(m.chunks))throw new Error('storage_recovery_material_invalid');
}
function verifyRestored(m:BackupMaterial,file:string):string{
 const stat=fs.lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error('storage_recovery_destination_changed');
 if(m.format==='sqlite-stream'){
  const snapshot=new SqliteStreamSnapshot(file);
  try{
   const measured=snapshot.measure();
   if(measured.sha256!==m.sha256 || measured.bytes!==m.bytes || snapshot.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'
    || snapshot.db.prepare('PRAGMA foreign_key_check').get())throw new Error('storage_recovery_database_changed');
  }finally{snapshot.close();}
 }else if(stat.size!==m.bytes || sha256Path(file)!==m.sha256)throw new Error('storage_recovery_destination_changed');
 if(m.format==='sqlite-binary')verifySqliteBinary(file);
 return sha256Path(file);
}

/** An explicit empty destination and cloud descriptor are sufficient. No
 * original application database, old local package or source files are read.
 * A crash resumes only this journal's destinations; it cannot overwrite a
 * changed file or another site's installation. Cold references are verified
 * through bounded streams instead of warming all historical files. */
export async function recoverStorageSite(input:{chunks:StorageChunkStore;descriptor:BackupDescriptor;destination:string;
  legacyStream?:(remote:string,bytes:number,drive:string)=>Promise<Readable>;
  onProgress?:(event:{stage:string;completed:number;total:number})=>void}):Promise<RecoveryJournal>{
 const {chunks,descriptor}=input,root=path.resolve(input.destination);
 if(!path.isAbsolute(input.destination) || root==='/' || root===path.resolve(chunks.scratch) || chunks.scratch.startsWith(root+'/'))throw new Error('storage_recovery_destination_invalid');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 if(fs.realpathSync(root)!==root || (fs.statSync(root).mode&0o077)!==0)throw new Error('storage_recovery_destination_permissions');
 const journalFile=safeStorageMember(root,'.pp-recovery-state.json'),descriptorHash=crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
 if(!fs.existsSync(journalFile) && fs.readdirSync(root).some(n=>n!=='.recovery.flock'))throw new Error('storage_recovery_destination_not_empty');
 const unlock=maintenanceLock(root,'recovery');
 try{
  const journal:RecoveryJournal=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile,'utf8')):
   {format:'pp-recovery-journal-v1',descriptorSha256:descriptorHash,instanceId:descriptor.instanceId,pointId:descriptor.pointId,
    startedAt:Date.now(),complete:false,materials:{},legacy:{}};
  if(journal.format!=='pp-recovery-journal-v1' || journal.descriptorSha256!==descriptorHash || journal.instanceId!==descriptor.instanceId
   || journal.pointId!==descriptor.pointId)throw new Error('storage_recovery_journal_mismatch');
  durableJson(journalFile,journal);
  if(journal.catalogInstalling && !journal.catalogInstalledAt){
   // A process exit between the SQLite commit and the filesystem receipt has
   // an uncertain DB hash. Re-fetch only this owned destination from cloud;
   // never accept an unexplained changed database or replay the whole site.
   const main=safeStorageMember(root,'database/main.sqlite');
   if(fs.existsSync(main)){const interrupted=new DatabaseSync(main);interrupted.close();fs.unlinkSync(main);}
   delete journal.materials['database/main.sqlite'];delete journal.catalogInstalling;durableJson(journalFile,journal);
  }
  const manifest=await readBackupManifest(chunks,descriptor);
  if(manifest.unavailableOriginals?.length){
   for(const missing of manifest.unavailableOriginals)if(missing.reason!=='pre-existing-unavailable' || !/^[a-f0-9]{64}$/.test(missing.evidenceSha256))throw new Error('storage_recovery_absence_evidence_invalid');
   journal.unavailableOriginals=manifest.unavailableOriginals;durableJson(journalFile,journal);
  }
  if(!Array.isArray(manifest.materials) || !Array.isArray(manifest.legacy) || !manifest.materials.some(m=>m.target==='database/main.sqlite' && m.format==='sqlite-stream')
   || new Set(manifest.materials.map(m=>m.target)).size!==manifest.materials.length)throw new Error('storage_recovery_manifest_incomplete');
  const total=manifest.materials.length+manifest.legacy.length;let completed=0;
  for(const m of manifest.materials){
   validateMaterial(m);const target=safeStorageMember(root,m.target);
   if(m.target.startsWith('.pp-') || m.target==='.recovery.flock')throw new Error('storage_recovery_reserved_target');
   const previous=journal.materials[m.target];
   if(m.format==='cloud-reference'){
    if(!previous){await restoreBackupMaterial(chunks,m,target);journal.materials[m.target]={verifiedAt:Date.now(),bytes:m.bytes};durableJson(journalFile,journal);}
   }else{
    if(previous){if(!fs.existsSync(target) || sha256Path(target)!==previous.fileSha256)throw new Error('storage_recovery_destination_changed');}
    else{
     fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
     // A deterministic exclusive staging name is owned by this private journal.
     const candidate=safeStorageMember(root,`.pp-candidate-${crypto.createHash('sha256').update(m.target).digest('hex')}`);
     if(fs.existsSync(target))verifyRestored(m,target); // crash after rename before journal commit
     else{
      if(fs.existsSync(candidate)){if(!fs.lstatSync(candidate).isFile())throw new Error('storage_recovery_staging_changed');fs.unlinkSync(candidate);}
      // This journal owns a never-published DELETE-mode recovery candidate.
      // A killed restore may leave its rollback journal, never a live WAL/SHM.
      if(fs.existsSync(candidate+'-journal'))fs.unlinkSync(safeStorageMember(root,path.basename(candidate)+'-journal'));
      await restoreBackupMaterial(chunks,m,candidate);verifyRestored(m,candidate);
      // Hard linking an immutable newly restored candidate is only an atomic
      // no-overwrite install; never a link to any mutable/live source DB.
      fs.linkSync(candidate,target);fs.unlinkSync(candidate);
     }
     journal.materials[m.target]={verifiedAt:Date.now(),bytes:m.bytes,fileSha256:sha256Path(target)};durableJson(journalFile,journal);
    }
   }
   input.onProgress?.({stage:'materials',completed:++completed,total});
  }
  for(const object of manifest.legacy){
   const key=JSON.stringify([object.remote_drive,object.remote_path]);
   if(!journal.legacy[key]){
    if(!input.legacyStream)throw new Error('storage_recovery_legacy_reader_required');
    const stream=await input.legacyStream(object.remote_path,object.archive_bytes,object.remote_drive);
    if(object.kind==='voice'){
     const m=JSON.parse(object.manifest_json);await consumeAgeFile({stream,identity:chunks.policy.identity,cipherSha256:object.archive_sha256,cipherBytes:object.archive_bytes,sha256:m.sha256,bytes:m.size});
    }else await verifyTarStream({stream,identity:chunks.policy.identity,
      ciphertextSha256:object.archive_sha256,ciphertextBytes:object.archive_bytes,members:{},strict:false,maxPlaintextBytes:1024**4});
    journal.legacy[key]={verifiedAt:Date.now(),bytes:object.archive_bytes};durableJson(journalFile,journal);
   }
   input.onProgress?.({stage:'legacy',completed:++completed,total});
  }
  const mainPath=safeStorageMember(root,'database/main.sqlite'),main=new DatabaseSync(mainPath);
  try{if(main.prepare('PRAGMA quick_check').get()?.quick_check!=='ok' || main.prepare('PRAGMA foreign_key_check').get())throw new Error('storage_recovery_main_integrity');}
  finally{main.close();}
  if(!journal.catalogInstalledAt){
   journal.catalogInstalling=true;durableJson(journalFile,journal);
   installRecoveredCatalog(mainPath,chunks,descriptor,manifest);
   journal.catalogInstalledAt=Date.now();delete journal.catalogInstalling;journal.materials['database/main.sqlite'].fileSha256=sha256Path(mainPath);durableJson(journalFile,journal);
  }
  journal.complete=true;journal.finishedAt=Date.now();durableJson(journalFile,journal);return journal;
 }finally{unlock();}
}

/** The database snapshot predates publication of its own backup point. Seed
 * the verified descriptor and its pins before a restored installation can
 * run retention maintenance. This only writes the new recovery destination. */
function installRecoveredCatalog(file:string,chunks:StorageChunkStore,descriptor:BackupDescriptor,manifest:BackupManifest):void{
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=DELETE');const catalog=new StorageCatalog(db);
 try{catalog.transaction(()=>{
  db.prepare(`INSERT INTO storage_backup_points(id,instance_id,created_at,manifest_json,manifest_sha256,verified_at,restore_tested_at,kind,state,remote_path)
    VALUES(?,?,?,?,?,?,?,'restored','verified',?) ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json,manifest_sha256=excluded.manifest_sha256,
    verified_at=excluded.verified_at,restore_tested_at=excluded.restore_tested_at,state='verified',blocked_reason=NULL`)
    .run(descriptor.pointId,descriptor.instanceId,descriptor.createdAt,JSON.stringify(descriptor),descriptor.manifest.sha256,Date.now(),Date.now(),`${chunks.policy.remoteRoot}/recovery/${descriptor.pointId}.json`);
  const pin=(m:BackupMaterial)=>{
   const restoredChunks=m.chunks.map(chunk=>{
    const known=catalog.recordChunk(chunk);if(known.id!==chunk.id || known.ciphertext_sha256!==chunk.ciphertext_sha256)throw new Error('storage_recovery_chunk_identity');return known;
   });
   let version=db.prepare('SELECT * FROM storage_versions WHERE id=?').get(m.versionId);
   if(!version){
    if(m.format==='cloud-reference' || m.format==='catalog-version')throw new Error('storage_recovery_referenced_version_missing');
    const item=catalog.enroll({userId:m.userId,scope:'backup-material',sourceKey:m.target,kind:'recovery',locator:{root:'backup-material',path:m.target},name:path.posix.basename(m.target)});
    const generation=Number(db.prepare('SELECT COALESCE(MAX(generation),0)+1 n FROM storage_versions WHERE item_id=?').get(item.id)!.n);
    db.prepare(`INSERT INTO storage_versions(id,item_id,user_id,generation,sha256,logical_bytes,source_fingerprint,state,created_at)
      VALUES(?,?,?,?,?,?,?,'local',?)`).run(m.versionId,item.id,m.userId,generation,m.sha256,m.bytes,`${m.format}:${m.sha256}:${m.bytes}`,descriptor.createdAt);
    version=catalog.version(m.userId,m.versionId);
   }
   if(version.user_id!==m.userId || version.sha256!==m.sha256 || version.logical_bytes!==m.bytes)throw new Error('storage_recovery_version_identity');
   catalog.verifyVersion(m.userId,m.versionId,m.manifest,restoredChunks);catalog.reference(m.userId,m.versionId,'backup',descriptor.pointId);
   db.prepare('INSERT OR REPLACE INTO storage_backup_materials VALUES(?,?,?,?,?)').run(descriptor.pointId,m.target,m.userId,m.versionId,m.format);
  };
  for(const material of manifest.materials)pin(material);
  const target=`manifests/${descriptor.pointId}.json`,item=catalog.enroll({userId:'__shared__',scope:'backup-material',sourceKey:target,kind:'recovery',locator:{root:'backup-material',path:target},name:path.posix.basename(target)});
  const version=catalog.registerVersion('__shared__',item.id,{sha256:descriptor.manifest.sha256,bytes:descriptor.manifest.bytes,fingerprint:`file:${descriptor.manifest.sha256}:${descriptor.manifest.bytes}`});
  pin({target,userId:'__shared__',versionId:version.id,format:'file',sha256:descriptor.manifest.sha256,bytes:descriptor.manifest.bytes,mode:0o600,uid:0,gid:0,
   manifest:{format:'pp-backup-material-v1',target,contentFormat:'file',mode:0o600,uid:0,gid:0,sha256:descriptor.manifest.sha256,bytes:descriptor.manifest.bytes,chunks:descriptor.manifest.chunks.map(c=>c.id)},chunks:descriptor.manifest.chunks});
  for(const object of manifest.legacy)db.prepare('INSERT OR REPLACE INTO storage_backup_legacy_refs VALUES(?,?,?,?,?)').run(descriptor.pointId,object.remote_drive,object.remote_path,object.archive_sha256,object.archive_bytes);
  db.prepare("UPDATE storage_restores SET state='error',error='storage_server_recovered_retry',updated_at=? WHERE state IN ('queued','restoring')").run(Date.now());
  // These are paths on the lost host, not evidence of physical deletion here.
  db.prepare("UPDATE storage_replicas SET state='unavailable',blocked_reason='storage_original_host_not_present' WHERE released_at IS NULL").run();
  db.prepare("UPDATE storage_legacy_generations SET blocked_reason='storage_original_host_not_present' WHERE released_at IS NULL").run();
  db.prepare('UPDATE conversation_storage SET local_isolated_path=NULL').run();
  db.prepare('UPDATE reading_source_versions SET local_isolated_path=NULL').run();
  db.prepare('UPDATE voice_transcriptions SET audio_local_isolated_path=NULL').run();
  catalog.audit('__shared__',null,null,'recovery_catalog_installed',0,{point:descriptor.pointId,originalLocalPathsRetired:true});
 });}finally{db.close();}
}

export function recordRecoveryDrill(db:DatabaseSync,descriptor:BackupDescriptor,journal:RecoveryJournal):void{
 const point=db.prepare('SELECT manifest_json,state FROM storage_backup_points WHERE id=? AND instance_id=?').get(descriptor.pointId,descriptor.instanceId);
 if(!journal.complete || !journal.finishedAt || journal.pointId!==descriptor.pointId || !point || point.state!=='verified'
  || crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')!==journal.descriptorSha256
  || JSON.stringify(JSON.parse(String(point.manifest_json)))!==JSON.stringify(descriptor))throw new Error('storage_recovery_drill_identity');
 db.prepare('UPDATE storage_backup_points SET restore_tested_at=? WHERE id=?').run(journal.finishedAt,descriptor.pointId);
}
