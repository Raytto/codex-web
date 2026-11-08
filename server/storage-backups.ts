import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {StorageCatalog,type StorageChunk} from './storage-catalog.js';
import {StorageChunkStore,sha256Path} from './storage-chunks.js';
import {SqliteStreamSnapshot,SqliteBinarySnapshot,createDatabaseSnapshot,restoreSqliteStream,verifySqliteBinary} from './storage-sqlite-stream.js';
import {STORAGE_DAY} from './storage-lifecycle-policy.js';
import {isStorageIdentity} from './storage-key.js';
import type {DatabaseSync} from 'node:sqlite';

const SHARED='__shared__',hash=(text:string)=>crypto.createHash('sha256').update(text).digest('hex');
// Tens of thousands of small native/workspace files need bounded metadata
// independent of the much larger streamed data set.
export const STORAGE_BACKUP_MANIFEST_BYTES=128*1024**2;
export type BackupMaterial={target:string;userId:string;versionId:string;format:'file'|'sqlite-stream'|'sqlite-binary'|'catalog-version'|'cloud-reference';
  sha256:string;bytes:number;mode:number;uid:number;gid:number;manifest:Record<string,unknown>;chunks:StorageChunk[]};
export type BackupPoint={id:string;instance_id:string;created_at:number;manifest_json:string;manifest_sha256:string;
  verified_at:number|null;restore_tested_at:number|null;kind:string;state:string;remote_path:string|null;blocked_reason:string|null};
export type BackupDescriptor={format:'pp-recovery-point-v1';instanceId:string;pointId:string;createdAt:number;
  codeSha:string;keyRecovery:{mode:'external'|'wrapped-external-secret';reference:string};manifest:{sha256:string;bytes:number;chunks:StorageChunk[]};};
export type UnavailableOriginal={fileId:string;userId:string;relativePath:string;bytes:number;reason:'pre-existing-unavailable';evidenceSha256:string};
export type BackupManifest={format:'pp-recovery-manifest-v1';instanceId:string;pointId:string;createdAt:number;codeSha:string;
  materials:BackupMaterial[];legacy:Array<{kind:string;remote_drive:string;remote_path:string;archive_sha256:string;archive_bytes:number;manifest_json:string}>;unavailableOriginals?:UnavailableOriginal[];};
type BackupCollection={materials:BackupMaterial[];legacy:BackupManifest['legacy'];unavailableOriginals:UnavailableOriginal[]};

export function backupLegacyObjects(db:DatabaseSync):BackupManifest['legacy']{
 const rows=db.prepare(`SELECT kind,remote_drive,remote_path,archive_sha256,archive_bytes,manifest_json FROM storage_legacy_generations
  UNION SELECT 'conversation',remote_drive_id,remote_path,archive_sha256,archive_bytes,manifest_json FROM conversation_storage WHERE remote_path IS NOT NULL AND verified_at IS NOT NULL
  UNION SELECT 'reader',remote_drive_id,remote_path,storage_archive_sha256,storage_archive_bytes,storage_manifest_json FROM reading_source_versions WHERE remote_path IS NOT NULL AND storage_verified_at IS NOT NULL
  UNION SELECT 'voice',audio_remote_drive_id,audio_remote_path,audio_archive_sha256,audio_archive_bytes,json_object('size',audio_bytes,'sha256',audio_sha256)
   FROM voice_transcriptions WHERE audio_remote_path IS NOT NULL AND audio_verified_at IS NOT NULL`).all() as BackupManifest['legacy'];
 const unique=new Map<string,BackupManifest['legacy'][number]>();
 for(const row of rows){const key=JSON.stringify([row.remote_drive,row.remote_path]),old=unique.get(key);
  if(old && (old.archive_sha256!==row.archive_sha256 || old.archive_bytes!==row.archive_bytes || old.kind!==row.kind))throw new Error('storage_backup_legacy_conflict');unique.set(key,row);}
 return [...unique.values()];
}

/** Overlapping calendar buckets select the same immutable point once. The
 * newest verified point and most recent tested point survive a long outage. */
export function retainedBackupIds(points:Array<Pick<BackupPoint,'id'|'created_at'|'verified_at'|'restore_tested_at'>>,now=Date.now()):Set<string>{
 const sorted=points.filter(p=>p.verified_at && p.created_at<=now).sort((a,b)=>b.created_at-a.created_at),keep=new Set<string>();
 if(sorted[0])keep.add(sorted[0].id);const tested=sorted.find(p=>p.restore_tested_at);if(tested)keep.add(tested.id);
 const period=(at:number,kind:'six-hour'|'day'|'week'|'month')=>kind==='month'?new Date(at).getUTCFullYear()*12+new Date(at).getUTCMonth():Math.floor((at+(kind==='week'?3*STORAGE_DAY:0))/(kind==='six-hour'?6*3600_000:kind==='week'?7*STORAGE_DAY:STORAGE_DAY));
 for(const [kind,count] of [['six-hour',4],['day',7],['week',8],['month',12]] as const){
  const seen=new Set<number>(),current=period(now,kind);
  for(const point of sorted){const bucket=period(point.created_at,kind);if(bucket>current || bucket<=current-count || seen.has(bucket))continue;seen.add(bucket);keep.add(point.id);}
 }return keep;
}

export class StorageBackups{
 constructor(readonly catalog:StorageCatalog,readonly chunks:StorageChunkStore,
   readonly options:{instanceId:string;codeSha:string;keyRecovery:BackupDescriptor['keyRecovery'];assertPresent?:(chunk:StorageChunk)=>Promise<void>}){
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.instanceId) || !/^[a-f0-9]{40}$/.test(options.codeSha)
    || !['external','wrapped-external-secret'].includes(options.keyRecovery.mode) || !options.keyRecovery.reference
    || options.keyRecovery.reference.length>500 || /AGE-SECRET-KEY-|BEGIN .*PRIVATE KEY|[\r\n\0]/.test(options.keyRecovery.reference))throw new Error('storage_backup_configuration');
 }
 private material(pointId:string,target:string,userId:string,versionId:string,format:BackupMaterial['format']):BackupMaterial{
  if(!target || target.includes('\\') || target.startsWith('/') || target.split('/').some(p=>!p || p==='.' || p==='..'))throw new Error('storage_backup_target_invalid');
  const version=this.catalog.version(userId,versionId);
  if(!version.verified_at || !version.manifest_json || hash(version.manifest_json)!==version.manifest_sha256)throw new Error('storage_backup_version_unverified');
  const manifest=JSON.parse(version.manifest_json),chunks=this.catalog.db.prepare(`SELECT c.* FROM storage_version_chunks v JOIN storage_chunks c ON c.id=v.chunk_id
    WHERE v.version_id=? ORDER BY v.ordinal`).all(versionId) as StorageChunk[];
  if(chunks.some(c=>c.user_id!==userId) || chunks.reduce((n,c)=>n+c.plaintext_bytes,0)!==version.logical_bytes)throw new Error('storage_backup_chunks_incomplete');
  this.catalog.reference(userId,versionId,'backup',pointId);
  this.catalog.db.prepare(`INSERT INTO storage_backup_materials(point_id,target_key,user_id,version_id,format) VALUES(?,?,?,?,?)
    ON CONFLICT(point_id,target_key) DO UPDATE SET user_id=excluded.user_id,version_id=excluded.version_id,format=excluded.format`).run(pointId,target,userId,versionId,format);
  return {target,userId,versionId,format,sha256:version.sha256,bytes:version.logical_bytes,mode:manifest.mode??0o600,uid:manifest.uid??0,gid:manifest.gid??0,manifest,chunks};
 }
 referenceVersion(pointId:string,target:string,userId:string,versionId:string):BackupMaterial{return this.material(pointId,target,userId,versionId,'catalog-version');}
 referenceCloudVersion(pointId:string,userId:string,versionId:string):BackupMaterial{return this.material(pointId,`cloud/${userId}/${versionId}`,userId,versionId,'cloud-reference');}
 async captureFile(pointId:string,target:string,source:string,userId=SHARED):Promise<BackupMaterial>{
  if(isStorageIdentity(source,this.chunks.policy.identity))throw new Error('storage_identity_requires_external_custody');
  const stat=fs.lstatSync(source),data=await this.chunks.archiveFile(userId,source);
  return this.capture(pointId,target,'file',data,{mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid},userId);
 }
 async captureDatabase(pointId:string,target:string,source:string,userId=SHARED):Promise<BackupMaterial>{
  this.chunks.checkBudget();const snapshot=createDatabaseSnapshot(source,this.chunks.scratch,this.chunks.policy.chunkBytes);
  try{
   return await this.captureDatabaseSnapshot(pointId,target,source,snapshot,userId);
  }finally{snapshot.close();}
 }
 async captureDatabaseSnapshot(pointId:string,target:string,source:string,snapshot:SqliteStreamSnapshot|SqliteBinarySnapshot,userId=SHARED):Promise<BackupMaterial>{
  if(snapshot instanceof SqliteBinarySnapshot){
   const stat=fs.statSync(source),data=await this.chunks.archiveFile(userId,snapshot.target);
   return this.capture(pointId,target,'sqlite-binary',data,{mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid},userId);
  }
  const stat=fs.statSync(source),measured=snapshot.measure(),data=await this.chunks.archiveStream(userId,snapshot.stream(),measured);
  return this.capture(pointId,target,'sqlite-stream',data,{mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid},userId);
 }
 private capture(pointId:string,target:string,format:BackupMaterial['format'],data:{sha256:string;bytes:number;fingerprint:string;chunks:StorageChunk[]},permissions:{mode:number;uid:number;gid:number},userId=SHARED):BackupMaterial{
  const item=this.catalog.enroll({userId,scope:'backup-material',sourceKey:target,kind:'recovery',locator:{root:'backup-material',path:target},name:path.posix.basename(target)});
  const version=this.catalog.registerVersion(userId,item.id,{...data,fingerprint:`${format}:${data.sha256}:${data.bytes}`});
  this.catalog.verifyVersion(userId,version.id,{format:'pp-backup-material-v1',target,contentFormat:format,...permissions,sha256:data.sha256,bytes:data.bytes,chunks:data.chunks.map(c=>c.id)},data.chunks);
  return this.material(pointId,target,userId,version.id,format);
 }
 async create(collect:(pointId:string)=>Promise<BackupMaterial[]|BackupCollection>):Promise<BackupPoint>{
  const now=this.catalog.now(),id=`${this.options.instanceId}-${Math.floor(now/(6*3600_000))}`;
  let point=this.catalog.db.prepare('SELECT * FROM storage_backup_points WHERE id=?').get(id) as BackupPoint|undefined;
  if(point?.state==='verified')return point;
  if(!point){
   const weekly=!this.catalog.db.prepare("SELECT 1 FROM storage_backup_points WHERE instance_id=? AND kind='weekly-recovery-manifest' AND verified_at>=?").get(this.options.instanceId,now-7*STORAGE_DAY);
   this.catalog.db.prepare(`INSERT INTO storage_backup_points(id,instance_id,created_at,manifest_json,manifest_sha256,kind,state)
     VALUES(?,?,?,'{}','',?,'preparing')`).run(id,this.options.instanceId,now,weekly?'weekly-recovery-manifest':'incremental');
   point=this.catalog.db.prepare('SELECT * FROM storage_backup_points WHERE id=?').get(id) as BackupPoint;
  }
  try{
   let descriptor:BackupDescriptor;
   if(point.state==='publishing')descriptor=JSON.parse(point.manifest_json) as BackupDescriptor;
   else{
    // Failed collection can retry in the same six-hour slot. Its old partial
    // inventory is not a second recovery point and must not pin files forever.
    this.catalog.transaction(()=>{
     this.catalog.db.prepare("DELETE FROM storage_references WHERE kind='backup' AND ref_id=?").run(id);
     this.catalog.db.prepare('DELETE FROM storage_backup_materials WHERE point_id=?').run(id);
     this.catalog.db.prepare('DELETE FROM storage_backup_legacy_refs WHERE point_id=?').run(id);
    });
    let legacy=backupLegacyObjects(this.catalog.db);
    for(const object of legacy)this.catalog.db.prepare('INSERT OR IGNORE INTO storage_backup_legacy_refs VALUES(?,?,?,?,?)').run(id,object.remote_drive,object.remote_path,object.archive_sha256,object.archive_bytes);
    const collected=await collect(id),materials=Array.isArray(collected)?collected:collected.materials;
    if(!Array.isArray(collected)){
      legacy=collected.legacy;
      this.catalog.transaction(()=>{
        this.catalog.db.prepare('DELETE FROM storage_backup_legacy_refs WHERE point_id=?').run(id);
        for(const object of legacy)this.catalog.db.prepare('INSERT OR IGNORE INTO storage_backup_legacy_refs VALUES(?,?,?,?,?)').run(id,object.remote_drive,object.remote_path,object.archive_sha256,object.archive_bytes);
      });
    }
    if(!materials.some(m=>m.target==='database/main.sqlite' && m.format==='sqlite-stream'))throw new Error('storage_backup_main_database_required');
    if(new Set(materials.map(m=>m.target)).size!==materials.length)throw new Error('storage_backup_duplicate_target');
    const unique=new Map(materials.flatMap(m=>m.chunks.map(c=>[c.id,c] as const)));
    for(const chunk of unique.values())await this.options.assertPresent?.(chunk);
    const manifest:BackupManifest={format:'pp-recovery-manifest-v1',instanceId:this.options.instanceId,pointId:id,createdAt:point.created_at,codeSha:this.options.codeSha,materials,legacy,
      ...(!Array.isArray(collected) && collected.unavailableOriginals.length?{unavailableOriginals:collected.unavailableOriginals}:{})};
    const body=JSON.stringify(manifest),bytes=Buffer.byteLength(body);if(bytes>STORAGE_BACKUP_MANIFEST_BYTES)throw new Error('storage_backup_manifest_budget');
    const data=await this.chunks.archiveStream(SHARED,Readable.from([body]),{sha256:hash(body),bytes});
    this.capture(id,`manifests/${id}.json`,'file',data,{mode:0o600,uid:0,gid:0});
    descriptor={format:'pp-recovery-point-v1',instanceId:this.options.instanceId,pointId:id,createdAt:point.created_at,codeSha:this.options.codeSha,keyRecovery:this.options.keyRecovery,
      manifest:{sha256:data.sha256,bytes:data.bytes,chunks:data.chunks}};
    const remote=`${this.chunks.policy.remoteRoot}/recovery/${id}.json`;
    // Fixed descriptor intent precedes publication; a crash cannot publish
    // different contents under the same recovery-point name on retry.
    this.catalog.db.prepare("UPDATE storage_backup_points SET state='publishing',manifest_json=?,manifest_sha256=?,remote_path=? WHERE id=?")
      .run(JSON.stringify(descriptor),data.sha256,remote,id);point=this.catalog.db.prepare('SELECT * FROM storage_backup_points WHERE id=?').get(id) as BackupPoint;
   }
   const stage=path.join(this.chunks.scratch,`${crypto.randomUUID()}.point`),download=stage+'.verify',body=JSON.stringify(descriptor);
   try{
    fs.writeFileSync(stage,body,{flag:'wx',mode:0o600});await this.chunks.transport.put(stage,point.remote_path!);
    await this.chunks.transport.get(point.remote_path!,download);
    if(sha256Path(download)!==hash(body))throw new Error('storage_backup_descriptor_verify');
    const restored=await readBackupManifest(this.chunks,descriptor);
    if(restored.pointId!==id || restored.instanceId!==this.options.instanceId)throw new Error('storage_backup_manifest_identity');
   }finally{for(const file of [stage,download])try{fs.unlinkSync(file);}catch{}}
   this.catalog.db.prepare("UPDATE storage_backup_points SET state='verified',verified_at=?,blocked_reason=NULL WHERE id=?").run(this.catalog.now(),id);
   this.catalog.audit(SHARED,null,null,'backup_point_verified',descriptor.manifest.bytes,{point:id});
   return this.catalog.db.prepare('SELECT * FROM storage_backup_points WHERE id=?').get(id) as BackupPoint;
  }catch(e){this.catalog.db.prepare('UPDATE storage_backup_points SET blocked_reason=? WHERE id=?').run(e instanceof Error?e.message:'storage_backup_failed',id);throw e;}
 }
 retireExpired():string[]{
  const points=this.catalog.db.prepare("SELECT * FROM storage_backup_points WHERE instance_id=? AND state='verified' ORDER BY created_at DESC").all(this.options.instanceId) as BackupPoint[];
  if(!points.some(p=>p.restore_tested_at))return [];
  const keep=retainedBackupIds(points,this.catalog.now()),retired:string[]=[];
  const abandoned=this.catalog.db.prepare("SELECT * FROM storage_backup_points WHERE instance_id=? AND state IN ('preparing','publishing') AND created_at<? AND created_at<?")
   .all(this.options.instanceId,this.catalog.now()-7*STORAGE_DAY,points[0].created_at) as BackupPoint[];
  this.catalog.transaction(()=>{for(const point of [...points,...abandoned]){if(keep.has(point.id))continue;
   this.catalog.db.prepare("UPDATE storage_backup_points SET state=?,retired_at=? WHERE id=?").run(point.remote_path?'retired':'collected',this.catalog.now(),point.id);
   this.catalog.db.prepare("DELETE FROM storage_references WHERE kind='backup' AND ref_id=?").run(point.id);
   this.catalog.db.prepare('DELETE FROM storage_backup_legacy_refs WHERE point_id=?').run(point.id);
   this.catalog.db.prepare('DELETE FROM storage_backup_materials WHERE point_id=?').run(point.id);
   this.catalog.db.prepare("UPDATE storage_items SET current_version=NULL WHERE scope='backup-material' AND source_key=?").run(`manifests/${point.id}.json`);
   this.catalog.audit(SHARED,null,null,'backup_point_retired',0,{point:point.id});retired.push(point.id);
  }});return retired;
 }
}

export async function readBackupManifest(chunks:StorageChunkStore,descriptor:BackupDescriptor):Promise<BackupManifest>{
 if(descriptor.format!=='pp-recovery-point-v1' || descriptor.instanceId!==chunks.policy.instanceId || descriptor.manifest.bytes>STORAGE_BACKUP_MANIFEST_BYTES)throw new Error('storage_recovery_descriptor_invalid');
 const parts:Buffer[]=[];let bytes=0;
 for await(const value of chunks.verifiedStream(SHARED,descriptor.manifest.chunks,descriptor.manifest)){bytes+=(value as Buffer).length;if(bytes>STORAGE_BACKUP_MANIFEST_BYTES)throw new Error('storage_recovery_manifest_budget');parts.push(value as Buffer);}
 const m=JSON.parse(Buffer.concat(parts).toString('utf8')) as BackupManifest;
 if(m.format!=='pp-recovery-manifest-v1' || m.instanceId!==descriptor.instanceId || m.pointId!==descriptor.pointId || m.codeSha!==descriptor.codeSha)throw new Error('storage_recovery_manifest_identity');return m;
}

/** Recovery needs only a cloud descriptor, a recovered identity, and explicit
 * target mappings. It does not read the original database or user files. */
export async function restoreBackupMaterial(chunks:StorageChunkStore,material:BackupMaterial,target:string):Promise<void>{
 if(material.format==='cloud-reference'){
  for await(const _ of chunks.verifiedStream(material.userId,material.chunks,material)){ /* verify without warming an entire cold account */ }
  return;
 }
 fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
 if(fs.existsSync(target))throw new Error('storage_recovery_target_exists');
 if(material.format==='sqlite-stream'){
  const restored=await restoreSqliteStream(chunks.verifiedStream(material.userId,material.chunks,material),target);
  if(restored.sha256!==material.sha256 || restored.bytes!==material.bytes){fs.unlinkSync(target);throw new Error('storage_recovery_database_hash');}
 }else {
  await chunks.restoreFile(material.userId,material.chunks,target,material);
  if(material.format==='sqlite-binary'){
   try{verifySqliteBinary(target);}catch(error){fs.unlinkSync(target);throw error;}
  }
 }
 fs.chmodSync(target,material.mode);if(process.getuid?.()===0)fs.chownSync(target,material.uid,material.gid);
}
